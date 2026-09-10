"""提示词库：内置模板 + 自建条目的分组与 CRUD（模块 17 FR-478）。

两条与常规 CRUD 不同的约定：

- **内置模板不进表**，是本文件里的常量，对外用**负数 id**。升级时改一行发一次版
  就生效；写进表则要维护一套「哪些行是上个版本发的、用户改过没有」的同步逻辑，
  而那套逻辑一旦判错就是把用户的改动冲掉。用户想改内置模板就 `fork` 成自建，
  两边永不打架——所以内置条目的 patch / delete 一律 400，并直说该先复制。
- **删组不删条目**：`group_id` 置空退回未归组，与素材分组同一条口径。
- **内置模板可隐藏不可删**：隐藏名单落 `user_pref`（`HIDDEN_BUILTIN_PREF_KEY`），
  是唯一能对内置条目做的写操作。删不掉是因为它本来就不是一行数据；隐藏可逆，
  内容一个字没动，下次升级也不会打架。

内置模板同时包含 Lingua 自写模板和迁入的 Infinite-Canvas 预设。迁入条目保留
``source`` / ``source_ref``，接口与界面会明确展示来源；稳定 key 和负数 id 仍由本文件维护。
每条内置模板自带 ``category``（``BUILTIN_CATEGORIES``，前五类照搬 Infinite-Canvas 的
视角/分镜/角色/产品/光影），与用户自建的 ``group_id`` 是并行的两套，互不覆盖。
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import func, or_, select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession

from domain import llm, studio_revisions
from domain.models import StudioPrompt, StudioPromptGroup, UserPref

MAX_NAME = 60
MAX_TITLE = 120
MAX_BODY = 8000
MAX_SCENE = 200
MAX_VAR_NAME = 40
MAX_VAR_LABEL = 60
MAX_VAR_DESC = 200
MAX_VAR_DEFAULT = 500
# 一条提示词里的变量数上限。超过这个数，填变量的表单本身就比直接改正文还费事
MAX_VARIABLES = 20

# 模板变量占位语法。选双花括号是因为它在提示词正文里几乎不会自然出现：
# 单花括号 `{x}` 与 JSON 片段、Python f-string 示例撞车（提示词里贴 JSON 是常事），
# 方括号 `[x]` 与 Stable Diffusion / ComfyUI 的权重与调度语法撞车，
# `$x` 与 shell 片段撞车。双花括号还是 Handlebars / Jinja / Mustache 的共同写法，
# 用户不用学，从别处抄来的模板多半直接就能用。
#
# 名字**允许中文**（`[^\W\d]` 是「是词字符但不是数字」，即字母或下划线，Unicode 生效）。
# 原来只认 ASCII，而界面上的例子写的是 `{{主体}}`：照着例子写的占位一个都匹配不上，
# 既不进变量名单也不报错，套用时原样发给模型——正是这套东西唯一真正会出事的失败模式。
# 前端 `prompt-variables.ts` 用 `\p{L}` 系列写了等价的一份，两边判据必须一致。
VARIABLE_RE = re.compile(r"\{\{\s*([^\W\d]\w*)\s*\}\}")

# 复制内置模板时加的后缀。留「· 副本」而不是「(1)」：列表里一眼能认出这是从哪来的
FORK_SUFFIX = " · 副本"

# 内置条目不可改的统一说法。UI 直接把 detail 原样弹出来（BR-110）。
# 两条出路都写进来：想改就复制一份，只是不想再看见就隐藏——否则用户读完只知道不行
BUILTIN_READONLY = (
    "内置模板不可改，请先复制为自建（fork）后再编辑；只是不想再看见它，用「隐藏」"
)


class StudioPromptError(Exception):
    """提示词库操作不合法。`status` 由路由层原样映射为 HTTP 状态码。"""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# ---- 内置模板 ----

# 每条：key（稳定标识，换措辞不换 key）、title、category（见 BUILTIN_CATEGORIES）、
# variables（占位的中文说明）、body（提示词骨架）、negative（要避开什么）、
# scene（中文一句话，说清什么时候用）。
#
# body 写成骨架而不是成品：主体留成 `{{占位}}` 让用户填，其余（构图、光线、镜头、质感）
# 是每次都要写但每次都懒得写的部分——模板的价值就在这里。
#
# 占位写 `{{主体}}` 而不是 Infinite-Canvas 原文的 `[主体]`：方括号在这条链路上没有任何
# 机制托底，用户忘了替换就把 `[主体]` 原样发给模型，模型不报错、照着乱出图；换成本仓的
# 变量占位之后，套用前会强制走填空表单，缺必填直接拦下（fill_variables）。除占位这一个
# token 外，迁入的正向与负向全文照抄，一个词没删——那些词是调出来的。

# 内置模板的分类。**与用户自建的分组是两套东西**：分组是库里的归属（可增删改，落表），
# 分类是内置模板自带的属性（随版本发布，用户改不动）——混成一套的话，用户删掉一个分组
# 就会把内置模板的归类一起删掉，而下次升级它又自己长回来。
#
# 前五类照搬 Infinite-Canvas 的分类体系（视角/分镜/角色/产品/光影），后四类是 Lingua
# 自己那批模板要用的。顺序即左栏的显示顺序，`sort` 随位置派生，前端不再自己排一遍。
BUILTIN_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("view", "视角"),
    ("storyboard", "分镜"),
    ("character", "角色"),
    ("product", "产品"),
    ("lighting", "光影"),
    ("design", "设计"),
    ("illustration", "插画"),
    ("poster", "海报"),
    ("photo", "摄影"),
)
CATEGORY_NAMES: dict[str, str] = dict(BUILTIN_CATEGORIES)
CATEGORY_SORT: dict[str, int] = {key: index for index, (key, _) in enumerate(BUILTIN_CATEGORIES)}

# 内置模板的隐藏名单存在 user_pref 里，与素材标签设置同一条口径（不为一个开关新开一张表）。
# 存 key 而不是负数 id：负数 id 是按声明顺序派生的，中间插一条新模板，所有 id 往后挪一位，
# 隐藏名单就会指到别的模板上去。key 换措辞也不换，才是稳定标识。
HIDDEN_BUILTIN_PREF_KEY = "studio_prompt_hidden_builtins"


LOCAL_BUILTIN_PROMPTS: tuple[dict, ...] = (
    {
        "key": "product_white",
        "category": "product",
        "variables": (
            {
                "name": "product",
                "label": "产品",
                "description": "要拍的商品，写清品类与材质",
            },
        ),
        "title": "产品白底图",
        "body": (
            "a single {{product}} centred on a seamless pure white background, "
            "three-quarter front view; studio softbox key from the upper left with a "
            "gentle fill from the right, soft contact shadow directly beneath; "
            "crisp edges, true-to-life colour, fine surface texture and material detail; "
            "shallow depth of field, commercial catalogue photography, 85mm lens look"
        ),
        "negative": (
            "cluttered background, props, visible studio reflections, harsh shadows, "
            "colour cast, distorted proportions, watermark"
        ),
        "scene": "电商主图、商品详情页要的那种干净白底产品图",
    },
    {
        "key": "portrait_studio",
        "category": "character",
        "variables": (
            {
                "name": "person",
                "label": "人物",
                "description": "谁：性别、年龄段、气质、着装",
            },
        ),
        "title": "人像写真",
        "body": (
            "a portrait of {{person}}, head and shoulders, gaze slightly off camera; "
            "warm soft key at 45 degrees with a rim light separating hair from the "
            "backdrop, muted neutral background; natural skin texture with visible pores, "
            "catchlight in the eyes; shallow depth of field, 85mm f/1.8 look, "
            "calm and confident mood"
        ),
        "negative": (
            "plastic over-smoothed skin, extra fingers, deformed hands, direct harsh flash, "
            "heavy vignette, watermark"
        ),
        "scene": "人物写真、头像、团队介绍页配图",
    },
    {
        "key": "ui_screen",
        "category": "design",
        "variables": (
            {
                "name": "platform",
                "label": "平台",
                "description": "iOS / Android / Web 桌面端",
            },
            {
                "name": "feature",
                "label": "功能",
                "description": "这一屏在做什么，如「日程列表」",
            },
        ),
        "title": "UI 设计稿",
        "body": (
            "a clean {{platform}} app screen for {{feature}}, laid out on an 8pt grid with "
            "generous white space; one accent colour over a neutral surface palette; "
            "rounded cards with soft elevation, clear hierarchy of title, body and primary "
            "action; content shown as realistic blocks rather than lettering; "
            "flat vector rendering, straight-on view, no device frame"
        ),
        "negative": (
            "skeuomorphic textures, gradients on every surface, shadows everywhere, "
            "cramped spacing, garbled lettering, watermark"
        ),
        "scene": "界面概念稿、交互方案的视觉参考（文案后期另排）",
    },
    {
        "key": "scene_illustration",
        "category": "illustration",
        "variables": (
            {
                "name": "place",
                "label": "地点",
                "description": "画的是什么地方",
            },
            {
                "name": "time_of_day",
                "label": "时间",
                "description": "如 dusk / early morning",
            },
        ),
        "title": "场景插画",
        "body": (
            "an illustrated scene of {{place}} at {{time_of_day}}; wide establishing "
            "composition with distinct foreground, midground and background; warm ambient "
            "light against cool shadows, limited five-colour palette; soft cel shading, "
            "light grain over flat colour, storybook mood, distant shapes without outlines"
        ),
        "negative": (
            "muddy colours, photographic texture, heavy black outlines, cluttered detail, "
            "watermark"
        ),
        "scene": "文章配图、故事场景、讲气氛不讲细节的插画",
    },
    {
        "key": "poster_key_visual",
        "category": "poster",
        "variables": (
            {
                "name": "theme",
                "label": "主题",
                "description": "海报讲什么",
            },
        ),
        "title": "海报主视觉",
        "body": (
            "a poster key visual for {{theme}}; one dominant subject placed off centre on a "
            "rule-of-thirds intersection, upper third left empty for a headline; "
            "bold high-contrast colour blocking, dramatic directional light, "
            "silhouette still readable at thumbnail size; safe margin on all four edges"
        ),
        "negative": (
            "busy background competing with the subject, subject touching the frame edge, "
            "low contrast, scattered small elements, watermark"
        ),
        "scene": "活动海报、宣传主视觉，标题文字后期另排",
    },
    {
        "key": "icon_set",
        "category": "design",
        "variables": (
            {
                "name": "topic",
                "label": "主题",
                "description": "这组图标覆盖哪一类功能",
            },
        ),
        "title": "图标集",
        "body": (
            "a set of matching icons for {{topic}} arranged on an even grid; every icon built "
            "from the same 2px stroke weight and 4px corner radius, one accent colour plus "
            "one neutral, geometric shapes, consistent optical size and padding; "
            "flat vector on a plain background, straight-on, no perspective"
        ),
        "negative": (
            "mixed stroke weights, gradients, drop shadows, photographic detail, "
            "inconsistent sizes, lettering, watermark"
        ),
        "scene": "一组风格一致的功能/导航图标草案",
    },
    {
        "key": "cover_banner",
        "category": "poster",
        "variables": (
            {
                "name": "subject",
                "label": "主体",
                "description": "横幅里的焦点元素",
            },
            {
                "name": "brand_colour",
                "label": "品牌色",
                "description": "如 deep teal，或直接写色号",
            },
        ),
        "title": "封面横幅",
        "body": (
            "a wide banner for {{subject}}, 16:9; focal element on the right third, "
            "left half kept calm and low-detail for overlaid copy; gentle gradient "
            "background, soft depth cues, restrained palette around {{brand_colour}}; "
            "even lighting with no hotspots, clean and modern"
        ),
        "negative": (
            "centred subject blocking the copy area, noisy texture, high-contrast clutter "
            "at the edges, lettering, watermark"
        ),
        "scene": "文章头图、页面 hero 区、公众号封面",
    },
    {
        "key": "photo_realistic",
        "category": "photo",
        "variables": (
            {
                "name": "subject",
                "label": "主体",
                "description": "拍什么",
            },
            {
                "name": "environment",
                "label": "环境",
                "description": "在哪儿拍",
            },
        ),
        "title": "写实摄影",
        "body": (
            "a photograph of {{subject}} in {{environment}}; natural available light shortly "
            "after sunrise, gentle haze; layered depth with a foreground framing element; "
            "35mm lens at f/4, slight film grain, accurate colour and natural contrast; "
            "documentary feel, nothing staged"
        ),
        "negative": (
            "hdr halos, oversaturation, cgi look, plastic texture, stray lens flare, "
            "watermark"
        ),
        "scene": "需要真实感的配图：风景、街拍、纪实",
    },
    {
        "key": "flat_infographic",
        "category": "design",
        "variables": (
            {
                "name": "process",
                "label": "流程",
                "description": "要讲清的流程或步骤",
            },
        ),
        "title": "流程说明图",
        "body": (
            "a flat infographic layout explaining {{process}}; three to five stages laid "
            "left to right at equal spacing, each stage a simple pictogram inside a rounded "
            "container, thin connector arrows between them; accent colour marks the active "
            "path, everything else grey; wide margins, straight-on view"
        ),
        "negative": (
            "dense paragraphs, tiny illustrations, rainbow palette, 3d bevels, "
            "drop shadows, garbled lettering, watermark"
        ),
        "scene": "流程、步骤的说明图（文字标注后期另加）",
    },
    {
        "key": "render_3d",
        "category": "illustration",
        "variables": (
            {
                "name": "scene",
                "label": "场景",
                "description": "小场景里有什么",
            },
        ),
        "title": "3D 小场景",
        "body": (
            "a small 3d rendered diorama of {{scene}}; soft clay-like materials with subtle "
            "roughness, pastel palette; three-point studio lighting with soft shadows and "
            "gentle ambient occlusion; isometric camera about 30 degrees above, "
            "slight depth of field, plain pastel backdrop, centred composition"
        ),
        "negative": (
            "hard specular highlights, photographic texture, dark moody lighting, "
            "cluttered props, lettering, watermark"
        ),
        "scene": "概念示意、卡片配图用的 3D 小场景",
    },
)


# Infinite-Canvas v2.1 的 10 条系统预设。只迁入创作时实际使用的名称、场景、正向与
# 负向提示词；平台参数说明仍由各模型插件负责，避免模板与运行参数互相污染。
INFINITE_CANVAS_SOURCE_REF = (
    "static/system-prompts/infinite-canvas-prompt-templates.md@v2.1"
)
INFINITE_CANVAS_PROMPTS: tuple[dict, ...] = (
    {
        "key": "infinite_multi_camera_3x3",
        "category": "view",
        "variables": (
            {
                "name": "主体",
                "label": "主体",
                "description": "九宫格里反复出现的那个人或物",
            },
            {
                "name": "主体详细描述",
                "label": "主体详细描述",
                "description": "外观、服装、材质，越具体越一致",
            },
        ),
        "title": "多机位九宫格",
        "body": (
            "A multi-camera angle reference sheet in 3x3 grid layout, showing {{主体}} "
            "from 9 different perspectives simultaneously: top-left front view, "
            "top-center 3/4 front view, top-right side profile, middle-left low angle, "
            "middle-center eye-level straight-on, middle-right high angle, bottom-left "
            "back view, bottom-center 3/4 back view, bottom-right top-down overhead view. "
            "{{主体详细描述}}. Consistent lighting across all 9 frames, uniform light warm "
            "gray background color F0EDE8, subjects softly blending with background with "
            "natural edge transition, no hard edges no white halo no light bleed, "
            "professional studio photography, clean grid layout with thin white dividers "
            "between frames, character consistency maintained across all angles, "
            "absolutely no visible numbers text labels frame counters corner marks or "
            "annotations anywhere on the image"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, "
            "white halo, light bleed, overexposed edge, cutout look, pasted on background, "
            "floating subject, disconnected shadow, pure white background, stark white, "
            "cold gray, bad anatomy, distorted face, extra fingers, deformed hands, "
            "inconsistent character design, lighting mismatch between frames, blurry, "
            "low quality, cropped, out of frame"
        ),
        "scene": "同一主体或场景的 9 个机位参考，用于角色、产品和空间多角度展示",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_multi_camera_3x3_4k",
        "category": "view",
        "variables": (
            {
                "name": "主体",
                "label": "主体",
                "description": "九宫格里反复出现的那个人或物",
            },
            {
                "name": "主体详细描述",
                "label": "主体详细描述",
                "description": "外观、服装、材质，越具体越一致",
            },
        ),
        "title": "多机位九宫格 4K",
        "body": (
            "Ultra high resolution multi-camera angle reference sheet in 3x3 grid "
            "layout, 4K quality, showing {{主体}} from 9 different perspectives "
            "simultaneously: top-left front view, top-center 3/4 front view, top-right "
            "side profile, middle-left low angle, middle-center eye-level straight-on, "
            "middle-right high angle, bottom-left back view, bottom-center 3/4 back view, "
            "bottom-right top-down overhead view. {{主体详细描述}}. Consistent cinematic "
            "lighting across all 9 frames, uniform light warm gray background color "
            "F0EDE8, subjects softly blending with background with natural edge "
            "transition, no hard edges no white halo no light bleed, professional studio "
            "photography with medium format film aesthetic, clean grid layout with thin "
            "white dividers between frames, character consistency maintained across all "
            "angles, fine organic film grain, zero digital sharpening, absolutely no "
            "visible numbers text labels frame counters corner marks or annotations "
            "anywhere on the image"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, "
            "white halo, light bleed, overexposed edge, cutout look, pasted on background, "
            "floating subject, disconnected shadow, pure white background, stark white, "
            "cold gray, bad anatomy, distorted face, extra fingers, deformed hands, "
            "inconsistent character design, lighting mismatch between frames, blurry, "
            "low quality, cropped, out of frame, digital sharpening, oversharpened, "
            "plastic skin, over-smoothing"
        ),
        "scene": "高分辨率九宫格，用于印刷级输出、大屏展示和精细材质参考",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_storyboard_2x2",
        "category": "storyboard",
        "variables": (
            {
                "name": "事件场景",
                "label": "事件 / 场景",
                "description": "四格讲的是哪一件事",
            },
            {
                "name": "阶段一",
                "label": "第 1 格",
                "description": "左上：事情怎么开始",
            },
            {
                "name": "阶段二",
                "label": "第 2 格",
                "description": "右上：往下走了一步",
            },
            {
                "name": "阶段三",
                "label": "第 3 格",
                "description": "左下：冲突或转折",
            },
            {
                "name": "阶段四",
                "label": "第 4 格",
                "description": "右下：收在哪儿",
            },
            {
                "name": "起始情绪",
                "label": "起始情绪",
                "description": "第 1 格的情绪，如 calm",
            },
            {
                "name": "结束情绪",
                "label": "结束情绪",
                "description": "第 4 格的情绪，如 relief",
            },
        ),
        "title": "剧情推演四宫格",
        "body": (
            "A 4-panel storyboard sequence in 2x2 grid, showing narrative progression of "
            "{{事件场景}}: top-left {{阶段一}}, top-right {{阶段二}}, bottom-left "
            "{{阶段三}}, bottom-right {{阶段四}}. Consistent character design across "
            "all panels, coherent lighting and color palette, uniform light warm gray "
            "background color F0EDE8, subjects softly blending with background with "
            "natural edge transition, no hard edges no white halo no light bleed, "
            "cinematic composition, emotional arc from {{起始情绪}} to {{结束情绪}}, film grain "
            "texture, clean thin white grid dividers, absolutely no visible numbers text "
            "labels frame counters corner marks or annotations anywhere on the image"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, "
            "white halo, light bleed, overexposed edge, cutout look, pasted on background, "
            "floating subject, disconnected shadow, pure white background, stark white, "
            "cold gray, bad anatomy, distorted face, extra fingers, deformed hands, "
            "inconsistent character design, lighting mismatch between frames, "
            "discontinuous action, jump cut feel, blurry, low quality, cropped, out of frame"
        ),
        "scene": "同一事件的 4 个连续阶段和情绪递进，用于故事板与叙事节奏测试",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_face_three_views",
        "category": "character",
        "variables": (
            {
                "name": "角色面部详细描述",
                "label": "角色面部描述",
                "description": "五官、发型、妆容、年龄段",
            },
        ),
        "title": "角色脸部三视图",
        "body": (
            "Character face reference sheet, three views side by side in single row: "
            "left panel front view straight-on, center panel 3/4 angle view, right panel "
            "side profile view. {{角色面部详细描述}}. Consistent lighting from 45-degree "
            "top-side across all three views, light warm gray background color F0EDE8, "
            "subjects softly blending with background with natural edge transition, no "
            "hard edges no white halo no light bleed, neutral clean backdrop, professional "
            "character design sheet, clean linework, subtle skin texture, identical facial "
            "features maintained across all angles, absolutely no visible numbers text "
            "labels frame counters corner marks or annotations anywhere on the image"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, "
            "white halo, light bleed, overexposed edge, cutout look, pasted on background, "
            "floating subject, disconnected shadow, pure white background, stark white, "
            "cold gray, bad anatomy, distorted face, asymmetrical eyes, crossed eyes, "
            "extra fingers, deformed hands, inconsistent facial features between panels, "
            "lighting mismatch, blurry, low quality, cropped, out of frame"
        ),
        "scene": "角色正面、四分之三侧面和侧面脸部参考，用于身份与表情一致性",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_product_three_views",
        "category": "product",
        "variables": (
            {
                "name": "产品详细描述",
                "label": "产品详细描述",
                "description": "形态、尺寸感、材质与配色",
            },
        ),
        "title": "产品三视图",
        "body": (
            "Product design reference sheet, three orthographic views in single row: "
            "front view, side view, top view. {{产品详细描述}}. Light warm gray background "
            "color F0EDE8, products softly blending with background with natural edge "
            "transition, no hard edges no white halo no light bleed, studio lighting with "
            "soft shadows, technical drawing aesthetic, precise proportions, material "
            "texture visible, no perspective distortion, professional product photography, "
            "absolutely no visible numbers text labels frame counters corner marks or "
            "annotations anywhere on the image"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, "
            "white halo, light bleed, overexposed edge, cutout look, pasted on background, "
            "floating subject, disconnected shadow, pure white background, stark white, "
            "cold gray, distorted proportions, perspective distortion, blurry, low "
            "quality, cropped, out of frame, cluttered background, random objects, "
            "inconsistent material texture between views"
        ),
        "scene": "产品正面、侧面和顶面正投影视图，用于工业设计、电商和技术文档",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_storyboard_5x5",
        "category": "storyboard",
        "variables": (
            {
                "name": "主体场景动作",
                "label": "主体 / 场景 / 动作",
                "description": "25 格要连贯演完的那段内容",
            },
        ),
        "title": "25 宫格连贯分镜",
        "body": (
            "A 5x5 cinematic storyboard grid, 25 sequential frames showing continuous "
            "narrative flow of {{主体场景动作}}, naturally divided into 9 story beats "
            "progressing through beginning, development, escalation, twist, climax, and "
            "resolution. Scene transitions conveyed purely through visual continuity and "
            "character motion, absolutely no visible numbers, text, labels, frame counters, "
            "corner marks, or annotations anywhere on the image. Consistent character and "
            "environment across all 25 frames, smooth motion continuity between adjacent "
            "frames, uniform cinematic lighting and color palette, light warm gray "
            "background color F0EDE8, subjects softly blending with background with natural "
            "edge transition, no hard edges no white halo no light bleed, varied shot "
            "progression from wide to close-up, professional film storyboard aesthetic, "
            "subtle film grain, clean thin white grid dividers"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, "
            "white halo, light bleed, overexposed edge, cutout look, pasted on background, "
            "floating subject, disconnected shadow, pure white background, stark white, "
            "cold gray, bad anatomy, distorted face, extra fingers, deformed hands, "
            "inconsistent character design, lighting mismatch between frames, "
            "discontinuous action, jump cut feel, blurry, low quality, cropped, out of "
            "frame, different hairstyle between frames, different clothing between frames"
        ),
        "scene": "5×5 连续叙事分镜，用于电影预览、动作连贯性和分段生成参考",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_cinematic_lighting_6",
        "category": "lighting",
        "variables": (
            {
                "name": "主体场景",
                "label": "主体 / 场景",
                "description": "六种光影下反复出现的同一个对象",
            },
        ),
        "title": "电影级光影校正",
        "body": (
            "Cinematic lighting comparison sheet, 6 panels showing the same {{主体场景}} "
            "under different lighting conditions: top-left golden hour warm backlight, "
            "top-center overcast soft diffused light, top-right neon night city light, "
            "bottom-left harsh midday direct sun, bottom-center Rembrandt 45-degree side "
            "light with triangle shadow, bottom-right dramatic low-key chiaroscuro. "
            "Consistent composition and subject across all panels, only lighting changes, "
            "light warm gray background color F0EDE8, subjects softly blending with "
            "background with natural edge transition, no hard edges no white halo no light "
            "bleed, professional cinematography reference, absolutely no visible numbers "
            "text labels frame counters corner marks or annotations anywhere on the image"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, "
            "white halo, light bleed, overexposed edge, cutout look, pasted on background, "
            "floating subject, disconnected shadow, pure white background, stark white, "
            "cold gray, inconsistent subject between panels, different pose between "
            "panels, different costume between panels, cluttered background, blurry, low "
            "quality, cropped, out of frame"
        ),
        "scene": "同一场景 6 种光照条件对比，用于灯光、色调和情绪方案测试",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_character_reference_sheet",
        "category": "character",
        "variables": (),
        "title": "角色设定参考表",
        "body": (
            "Character reference sheet, left-right split layout: left one-third area is "
            "chest-up close-up front view portrait (shoulder-up framing, extreme facial "
            "detail clarity, gentle natural expression, bright eyes looking straight at "
            "camera, realistic skin texture with visible pores and subtle imperfections, "
            "refined classical makeup); right two-thirds area is three full-body views in "
            "horizontal row, from left to right: full-body front standing pose (arms "
            "hanging naturally, feet together, complete front costume and body proportions), "
            "full-body side profile view (weight slightly shifted, waist-hip curve and "
            "silhouette visible, complete side costume and footwear), full-body back view "
            "(complete back neckline, hairstyle from behind, back costume details). "
            "Consistent front-top-side lighting across all panels, soft diffused light "
            "quality, light warm gray background color F0EDE8, subjects softly blending "
            "with background with natural edge transition, no hard edges no white halo no "
            "light bleed, identical character design, costume, hairstyle and accessories "
            "across all panels, professional character design sheet style, clean edges, "
            "accurate proportions, material texture visible from all angles, absolutely "
            "no visible numbers, text, labels, frame counters, corner marks or annotations "
            "anywhere on the image"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, "
            "white halo, light bleed, overexposed edge, cutout look, pasted on background, "
            "floating subject, disconnected shadow, pure white background, stark white, "
            "cold gray, dividing line labels, panel markers, bad anatomy, distorted face, "
            "extra fingers, deformed hands, inconsistent character design, lighting "
            "mismatch between frames, different hairstyle between panels, different "
            "clothing between panels, blurry, low quality, cropped, out of frame, "
            "asymmetrical eyes, crossed eyes, plastic skin, over-smoothing, textureless "
            "skin, uniform skin tone, digital sharpening, filter look, CG look, retouched, "
            "airbrushed, multiple heads, mutated limbs, floating limbs, disconnected limbs, "
            "uneven panel sizes, broken layout"
        ),
        "scene": "胸像面部锚点加全身正侧背三视图，用于角色、服装与身份一致性",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_expression_2x3",
        "category": "character",
        "variables": (),
        "title": "6 种基础表情胸像",
        "body": (
            "Character expression reference sheet in 2x3 grid layout, six basic "
            "expressions of the same character: top row from left to right: calm neutral "
            "expression (relaxed face, eyes looking straight ahead, lips naturally closed), "
            "gentle smile (corners of mouth slightly raised, eyes with smile lines, warm "
            "and approachable), joyful laugh (eyebrows and eyes curved upward, mouth open "
            "showing teeth, exuberant happiness); bottom row from left to right: sad "
            "tearful expression (slight furrow between brows, downturned outer eye corners, "
            "tears welling in eyes about to fall), angry stern expression (brows tightly "
            "locked, sharp piercing eyes with pressure, jaw slightly set), surprised "
            "astonished expression (eyes wide open, eyebrows raised high, mouth slightly "
            "open in O shape). All six expressions are chest-up close-up portraits of the "
            "same character, shoulder-up framing, extreme facial detail clarity, realistic "
            "skin texture preserved, no additional light source, light warm gray background "
            "color F0EDE8, subjects softly blending with background with natural edge "
            "transition, no hard edges no white halo no light bleed, identical character "
            "styling, hairstyle, makeup and accessories across all six panels, only facial "
            "expression changes, professional character expression sheet style, clean "
            "edges, absolutely no visible numbers, text, labels, frame counters, corner "
            "marks or annotations anywhere on the image"
        ),
        "negative": (
            "numbers, text, letters, labels, frame numbers, corner marks, annotations, "
            "captions, watermarks, signatures, logos, readable text, font, typography, "
            "grid numbers, sequence markers, page numbers, index, expression name labels, "
            "emotion text, hard edge, glowing edge, white halo, light bleed, overexposed "
            "edge, cutout look, pasted on background, floating subject, disconnected shadow, "
            "pure white background, stark white, cold gray, bad anatomy, distorted face, "
            "extra fingers, deformed hands, inconsistent character design, different "
            "hairstyle between panels, different clothing between panels, lighting mismatch "
            "between panels, blurry, low quality, cropped, out of frame, asymmetrical eyes, "
            "crossed eyes, plastic skin, over-smoothing, textureless skin, uniform skin tone, "
            "digital sharpening, filter look, CG look, retouched, airbrushed, multiple "
            "heads, mutated limbs, floating limbs, disconnected limbs, uneven panel sizes, "
            "broken layout, extra rows, extra columns, missing panel, shadows on face, "
            "directional light, dramatic lighting, colored light"
        ),
        "scene": "同一角色 2×3 六种基础表情，用于表情和情绪一致性参考",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
    {
        "key": "infinite_360_panorama",
        "category": "view",
        "variables": (),
        "title": "360 全景图",
        "body": (
            "生成一个720度的全景VR图，左右边缘100%像素级无缝衔接，可无限循环拼接；"
            "上下极点(南北极)自然过渡，无明显断层或拉伸，场景一致性，以及场景的逻辑性，"
            "封闭场景需要有门"
        ),
        "negative": (
            "seam, visible seam, hard seam, broken panorama, discontinuous edge, "
            "mismatched left and right edges, distorted poles, stretched ceiling, "
            "stretched floor, warped horizon, inconsistent scene logic, impossible space, "
            "no exit in closed room, text, letters, labels, watermark, logo, blurry, low quality"
        ),
        "scene": "生成 360/VR 全景和可左右循环拼接的室内、展厅或环境概念图",
        "source": "Infinite-Canvas",
        "source_ref": INFINITE_CANVAS_SOURCE_REF,
    },
)

BUILTIN_PROMPTS: tuple[dict, ...] = LOCAL_BUILTIN_PROMPTS + INFINITE_CANVAS_PROMPTS

# 负数 id 与自建条目分区。-1 是第一条，按声明顺序往下排——顺序即展示顺序
BUILTIN_BY_ID: dict[int, dict] = {
    -(index + 1): item for index, item in enumerate(BUILTIN_PROMPTS)
}


def is_builtin(prompt_id: int) -> bool:
    return prompt_id < 0


def category_catalog() -> list[dict]:
    """分类目录（顺序即左栏顺序）。**不带条数**：条数由界面在自己那份列表上算，
    否则「左栏数字」和「右边列表」会各算各的，一过滤就对不上（同 BR-146 的精神）。"""
    return [{"id": key, "name": name} for key, name in BUILTIN_CATEGORIES]


# ---- 模板变量 ----


def extract_variable_names(*texts: str) -> list[str]:
    """按首次出现顺序取出正文里的占位名，去重。顺序即表单里的字段顺序——
    用户读正文的顺序和填表单的顺序对上，填的时候不用来回找。"""
    names: list[str] = []
    for text in texts:
        for match in VARIABLE_RE.finditer(text or ""):
            name = match.group(1)
            if name not in names:
                names.append(name)
    return names


def _clean_variable_spec(name: str, raw: Any) -> dict:
    spec = raw if isinstance(raw, dict) else {}
    default = spec.get("default")
    return {
        "name": name,
        "label": str(spec.get("label") or "").strip()[:MAX_VAR_LABEL],
        "description": str(spec.get("description") or "").strip()[:MAX_VAR_DESC],
        "default": ("" if default is None else str(default))[:MAX_VAR_DEFAULT],
        # 没写就按必填算：漏填一个变量把 `{{name}}` 原样发给模型，是这套东西
        # 唯一真正会出事的失败模式，默认值要站在会报错的那一边
        "required": bool(spec.get("required", True)),
    }


def sync_variables(body: str, negative: str, declared: Any) -> list[dict]:
    """把变量声明对齐到正文里真实存在的占位。

    名单**由正文派生**而不是由声明决定：声明多出来的变量在渲染时什么都替换不了，
    留着只会让填变量的表单出现一个填了也没用的空格子；正文里多出来的占位如果不进
    名单，渲染时就会原样漏给模型——这正是必须避免的那种静默失败。
    人写的说明（标签、描述、默认值、是否必填）按名字保留。

    **这里不设上限也不报错**：它同时供读接口用，一条历史数据不该让整个列表 500。
    数量上限在写入路径由 `check_variable_limit` 单独把关。
    """
    names = extract_variable_names(body or "", negative or "")
    known: dict[str, Any] = {}
    if isinstance(declared, list):
        for item in declared:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()[:MAX_VAR_NAME]
            if name:
                known[name] = item
    return [_clean_variable_spec(name, known.get(name)) for name in names]


def check_variable_limit(variables: list[dict]) -> list[dict]:
    """写入路径的数量闸门。原样返回，方便直接套在 `sync_variables` 外面。"""
    if len(variables) > MAX_VARIABLES:
        names = "、".join(item["name"] for item in variables)
        raise StudioPromptError(
            f"一条提示词最多 {MAX_VARIABLES} 个变量，这条有 {len(variables)} 个：{names}"
        )
    return variables


def fill_variables(
    body: str, negative: str, variables: Any, values: dict[str, Any] | None
) -> dict:
    """把变量值填进正文。缺必填变量直接报错，绝不把 `{{name}}` 原样发出去。

    收尾再扫一遍残留占位。`re.sub` 不会回头扫替换进去的内容，所以变量值本身写着
    `{{x}}` 时它会原封不动留在结果里——这条链路的失败后果是「一段带着占位的提示词
    被当成正文发给模型」，模型不会报错，只会照着这段乱七八糟的文字出图，
    用户要过很久才发现。所以宁可在这里明确拦下。
    """
    given = values or {}
    specs = {item["name"]: item for item in sync_variables(body, negative, variables)}

    resolved: dict[str, str] = {}
    missing: list[str] = []
    for name, spec in specs.items():
        raw = given.get(name)
        filled = "" if raw is None else str(raw).strip()
        if filled == "":
            filled = str(spec.get("default") or "").strip()
        if filled == "" and spec.get("required", True):
            missing.append(spec.get("label") or name)
        resolved[name] = filled
    if missing:
        raise StudioPromptError("这些必填变量还没填：" + "、".join(missing))

    def replace(match: re.Match[str]) -> str:
        return resolved.get(match.group(1), match.group(0))

    rendered_body = VARIABLE_RE.sub(replace, body or "")
    rendered_negative = VARIABLE_RE.sub(replace, negative or "")

    leftover = extract_variable_names(rendered_body, rendered_negative)
    if leftover:
        shown = "、".join(f"{{{{{name}}}}}" for name in leftover)
        raise StudioPromptError(
            f"填好之后正文里还留着占位：{shown}。变量值里别再写占位——"
            "带着占位的正文发给模型，它不会报错，只会照着乱出图"
        )
    return {"body": rendered_body, "negative": rendered_negative, "values": resolved}


def builtin_view(prompt_id: int, item: dict, *, hidden: bool = False) -> dict:
    """内置条目的对外视图。favorite/used_count 恒为初值：它们要落库才有意义，
    而内置条目本身不落库——收藏或计数请先 fork 成自建。

    变量名单从正文里现算，人写的说明（标签/描述）由模板自带的 `variables` 提供：
    名单永远以正文为准，改了正文忘了改说明也不会多出一个填了没用的格子。

    `hidden` 是这一条在**本部署**被收起来了（见 HIDDEN_BUILTIN_PREF_KEY）：
    内容照常回，界面据此把它挪进「已隐藏」而不是当不存在——不然用户就没法恢复。
    """
    category = str(item.get("category") or "")
    return {
        "id": prompt_id,
        "group_id": None,
        "title": item["title"],
        "body": item["body"],
        "negative": item["negative"],
        "scene": item["scene"],
        "source": item.get("source", "Lingua"),
        "source_ref": item.get("source_ref"),
        "builtin": True,
        "hidden": hidden,
        # 内置模板自带的分类；自建条目走 group_id 那一套，这里恒为 None
        "category": category or None,
        "category_name": CATEGORY_NAMES.get(category, ""),
        "category_sort": CATEGORY_SORT.get(category, len(BUILTIN_CATEGORIES)),
        "favorite": False,
        "used_count": 0,
        "variables": sync_variables(
            item["body"], item["negative"], list(item.get("variables") or ())
        ),
        # 内置模板不落库，也就没有版本链
        "version": None,
        "updated_at": None,
    }


def prompt_view(row: StudioPrompt) -> dict:
    return {
        "id": row.id,
        "group_id": row.group_id,
        "title": row.title,
        "body": row.body,
        "negative": row.negative or "",
        "scene": row.scene or "",
        "source": None,
        "source_ref": None,
        "builtin": False,
        # 自建条目没有「隐藏」这回事：不想看就删掉或挪个分组，不需要第三种状态
        "hidden": False,
        "category": None,
        "category_name": "",
        "category_sort": len(BUILTIN_CATEGORIES),
        "favorite": row.favorite,
        "used_count": row.used_count,
        # 按正文现算而不是照抄那一列：正文改了、声明还没跟上时，
        # 界面要显示的是「正文里真实有哪些变量」，不是上一次存的名单
        "variables": sync_variables(row.body, row.negative or "", row.variables),
        "version": row.version or 1,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _snapshot(row: StudioPrompt) -> dict:
    """进版本链的那一份。只存内容，不存收藏 / 归组 / 套用次数——
    那些是「这条提示词在库里怎么摆」，回滚正文不该把它们一起拨回去。"""
    return {
        "title": row.title,
        "body": row.body,
        "negative": row.negative or "",
        "scene": row.scene or "",
        "variables": sync_variables(row.body, row.negative or "", row.variables),
    }


def _now() -> datetime:
    return datetime.now(UTC)


# ---- 分组 ----


def group_view(row: StudioPromptGroup, count: int = 0) -> dict:
    return {"id": row.id, "name": row.name, "parent_id": row.parent_id, "count": count}


async def _get_group(session: AsyncSession, group_id: int) -> StudioPromptGroup:
    row = await session.get(StudioPromptGroup, group_id)
    if row is None:
        raise StudioPromptError(f"分组不存在：{group_id}", status=404)
    return row


async def _check_parent(
    session: AsyncSession, parent_id: int | None, *, self_id: int | None
) -> None:
    """两级约束：父组必须自己是顶级，自己也不能带着子组去当别人的子组。"""
    if parent_id is None:
        return
    if self_id is not None and parent_id == self_id:
        raise StudioPromptError("分组不能挂在自己下面")
    parent = await _get_group(session, parent_id)
    if parent.parent_id is not None:
        raise StudioPromptError(
            f"提示词分组只有两级：「{parent.name}」已经是二级分组，不能再往下挂"
        )
    if self_id is None:
        return
    child_count = (
        await session.execute(
            select(func.count())
            .select_from(StudioPromptGroup)
            .where(StudioPromptGroup.parent_id == self_id)
        )
    ).scalar_one()
    if child_count:
        raise StudioPromptError(f"这个分组下面还有 {child_count} 个子分组，挂过去会变成三级")


def _clean_name(name: str) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        raise StudioPromptError("分组名不能为空")
    return cleaned[:MAX_NAME]


async def list_groups(session: AsyncSession) -> list[dict]:
    """全部分组 + 每组直接挂着的条目数。一次 group by 取全部计数，不逐组查。"""
    rows = (
        await session.execute(
            select(StudioPromptGroup).order_by(StudioPromptGroup.sort, StudioPromptGroup.id)
        )
    ).scalars().all()
    counted: dict[int, int] = {
        int(group_id): int(total)
        for group_id, total in (
            await session.execute(
                select(StudioPrompt.group_id, func.count())
                .where(StudioPrompt.group_id.is_not(None))
                .group_by(StudioPrompt.group_id)
            )
        ).all()
    }
    return [group_view(row, counted.get(row.id, 0)) for row in rows]


async def create_group(
    session: AsyncSession, *, name: str, parent_id: int | None = None
) -> dict:
    await _check_parent(session, parent_id, self_id=None)
    row = StudioPromptGroup(name=_clean_name(name), parent_id=parent_id)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return group_view(row, 0)


async def patch_group(
    session: AsyncSession,
    group_id: int,
    *,
    name: str | None = None,
    parent_id: int | None = None,
    move_parent: bool = False,
) -> dict:
    """改名或改挂靠。`move_parent=False` 时不动 parent_id——
    调用方要能表达「只改名」，否则每次改名都会顺手把组挪到顶级。"""
    row = await _get_group(session, group_id)
    if move_parent:
        await _check_parent(session, parent_id, self_id=group_id)
        row.parent_id = parent_id
    if name is not None:
        row.name = _clean_name(name)
    await session.commit()
    await session.refresh(row)
    count = (
        await session.execute(
            select(func.count()).select_from(StudioPrompt).where(StudioPrompt.group_id == row.id)
        )
    ).scalar_one()
    return group_view(row, count)


async def delete_group(session: AsyncSession, group_id: int) -> int:
    """删组：条目退回未归组，子组升为顶级，返回被释放的条目数。

    **一条都不删**。外键上的 SET NULL 在 SQLite 默认关外键约束时不生效，
    这里显式改，让行为在两种方言下一致。
    """
    row = await _get_group(session, group_id)
    # rowcount 挂在方言的 CursorResult 上，Result 的类型里没有它
    released = cast(
        "CursorResult[Any]",
        await session.execute(
            update(StudioPrompt).where(StudioPrompt.group_id == group_id).values(group_id=None)
        ),
    ).rowcount
    await session.execute(
        update(StudioPromptGroup)
        .where(StudioPromptGroup.parent_id == group_id)
        .values(parent_id=None)
    )
    await session.delete(row)
    await session.commit()
    return int(released or 0)


# ---- 内置模板的隐藏名单 ----

# 内置模板**不能真删**（它是常量，删了下次升级又回来），但「这十条我一条都用不上」是
# 真实诉求。所以给一个可逆的隐藏：列表里不再出现，「已隐藏」里随时恢复，内容一个字没动。
# Infinite-Canvas 的 `promptTemplateOverrides.hiddenBuiltinIds` 是同一件事，它存在
# localStorage 里，换台设备就没了；这里落 user_pref，与素材标签设置同一条口径。


async def hidden_builtin_keys(session: AsyncSession) -> set[str]:
    row = await session.get(UserPref, HIDDEN_BUILTIN_PREF_KEY)
    value = row.value if row is not None else None
    raw = value.get("keys") if isinstance(value, dict) else None
    if not isinstance(raw, list):
        return set()
    # 只认还存在的 key：模板被下架之后名单里留着的那条既恢复不了也删不掉，
    # 留着只会让「已隐藏」的计数比能恢复的条数多
    known = {item["key"] for item in BUILTIN_PROMPTS}
    return {str(key) for key in raw if str(key) in known}


async def _save_hidden_builtin_keys(session: AsyncSession, keys: set[str]) -> None:
    """按 BUILTIN_PROMPTS 的声明顺序存，读回来是稳定的顺序（JSON 里存 set 会乱序）。"""
    ordered = [item["key"] for item in BUILTIN_PROMPTS if item["key"] in keys]
    row = await session.get(UserPref, HIDDEN_BUILTIN_PREF_KEY)
    if row is None:
        session.add(UserPref(key=HIDDEN_BUILTIN_PREF_KEY, value={"keys": ordered}))
    else:
        row.value = {"keys": ordered}
    await session.commit()


async def set_builtin_hidden(session: AsyncSession, prompt_id: int, hidden: bool) -> dict:
    """隐藏或恢复一条内置模板，回这条的最新视图。"""
    item = BUILTIN_BY_ID.get(prompt_id)
    if item is None:
        raise StudioPromptError(f"提示词不存在：{prompt_id}", status=404)
    keys = await hidden_builtin_keys(session)
    if hidden:
        keys.add(item["key"])
    else:
        keys.discard(item["key"])
    await _save_hidden_builtin_keys(session, keys)
    return builtin_view(prompt_id, item, hidden=hidden)


# ---- 条目 ----


def _clean_title(title: str) -> str:
    cleaned = (title or "").strip()
    if not cleaned:
        raise StudioPromptError("标题不能为空")
    return cleaned[:MAX_TITLE]


def _clean_body(body: str) -> str:
    cleaned = (body or "").strip()
    if not cleaned:
        raise StudioPromptError("提示词正文不能为空")
    if len(cleaned) > MAX_BODY:
        raise StudioPromptError(f"提示词正文超上限（{len(cleaned)} > {MAX_BODY} 字）")
    return cleaned


async def _get_prompt(session: AsyncSession, prompt_id: int) -> StudioPrompt:
    """取自建条目。内置 id 在这里就拦下，别让调用方各自判一次负号。"""
    if is_builtin(prompt_id):
        if prompt_id in BUILTIN_BY_ID:
            raise StudioPromptError(BUILTIN_READONLY)
        raise StudioPromptError(f"提示词不存在：{prompt_id}", status=404)
    row = await session.get(StudioPrompt, prompt_id)
    if row is None:
        raise StudioPromptError(f"提示词不存在：{prompt_id}", status=404)
    return row


def _matches(item: dict, needle: str) -> bool:
    fields = ("title", "body", "scene", "negative")
    if any(needle in str(item.get(field, "")).lower() for field in fields):
        return True
    # 分类名也算命中：搜「光影」能搜出电影级光影校正，而它的标题里没有这两个字
    return needle in CATEGORY_NAMES.get(str(item.get("category") or ""), "").lower()


async def list_prompts(
    session: AsyncSession,
    *,
    group_id: int | None = None,
    q: str | None = None,
    favorite: bool | None = None,
    builtin: bool | None = None,
    category: str | None = None,
    include_hidden: bool = False,
) -> list[dict]:
    """自建 + 内置合并，**内置排在后面**。

    内置条目没有归属也没有收藏状态，所以 `group_id` / `favorite=True` 这两个筛选
    天然把它们排除在外——不是特判，是它们本来就不满足条件。反过来 `category` 是内置
    模板才有的属性，给了它就只剩内置条目。

    **隐藏的内置模板默认不回**：隐藏就是「别再让我看见」，套用浮层、画布侧栏这些
    消费方不该各自记得过滤一次。只有提示词库自己要管理它们，才带 `include_hidden`。
    """
    needle = (q or "").strip().lower()

    items: list[dict] = []
    if builtin is not True:
        query = select(StudioPrompt)
        if group_id is not None:
            query = query.where(StudioPrompt.group_id == group_id)
        if favorite is not None:
            query = query.where(StudioPrompt.favorite.is_(favorite))
        if needle:
            like = f"%{needle}%"
            query = query.where(
                or_(
                    StudioPrompt.title.ilike(like),
                    StudioPrompt.body.ilike(like),
                    StudioPrompt.scene.ilike(like),
                    StudioPrompt.negative.ilike(like),
                )
            )
        # 收藏的置顶，其余按最近改过排——「我刚写的那条」永远在手边
        query = query.order_by(
            StudioPrompt.favorite.desc(), StudioPrompt.updated_at.desc(), StudioPrompt.id.desc()
        )
        rows = (await session.execute(query)).scalars().all()
        items = [prompt_view(row) for row in rows]

    if builtin is False or group_id is not None or favorite is True:
        return items

    hidden = await hidden_builtin_keys(session)
    for prompt_id, item in BUILTIN_BY_ID.items():
        is_hidden = item["key"] in hidden
        if is_hidden and not include_hidden:
            continue
        if category is not None and item.get("category") != category:
            continue
        if needle and not _matches(item, needle):
            continue
        items.append(builtin_view(prompt_id, item, hidden=is_hidden))
    return items


async def create_prompt(
    session: AsyncSession,
    *,
    title: str,
    body: str,
    negative: str = "",
    scene: str = "",
    group_id: int | None = None,
    variables: Any = None,
) -> dict:
    if group_id is not None:
        await _get_group(session, group_id)
    cleaned_body = _clean_body(body)
    cleaned_negative = (negative or "").strip()
    row = StudioPrompt(
        group_id=group_id,
        title=_clean_title(title),
        body=cleaned_body,
        negative=cleaned_negative,
        scene=(scene or "").strip()[:MAX_SCENE],
        variables=check_variable_limit(
            sync_variables(cleaned_body, cleaned_negative, variables)
        ),
        version=1,
    )
    session.add(row)
    # 先 flush 拿 id，版本链的第一版和条目本身同一个事务落库：
    # 分两次提交的话，中间挂掉就会留下一条没有任何历史的条目
    await session.flush()
    await studio_revisions.record(
        session,
        studio_revisions.ENTITY_PROMPT,
        row.id,
        snapshot=_snapshot(row),
        note="新建",
        version=1,
    )
    await session.commit()
    await session.refresh(row)
    return prompt_view(row)


async def patch_prompt(
    session: AsyncSession,
    prompt_id: int,
    *,
    title: str | None = None,
    body: str | None = None,
    negative: str | None = None,
    scene: str | None = None,
    favorite: bool | None = None,
    group_id: int | None = None,
    move_group: bool = False,
    variables: Any = None,
    note: str | None = None,
    hidden: bool | None = None,
) -> dict:
    """改自建条目。内置 id 走 `_get_prompt` 直接 400（连同该怎么办一起说清）。

    内容真的变了才追加一版。收藏、改归组不进版本链——它们不是「这条提示词写成什么样」，
    收藏一下就多一版会把历史面板淹掉，真想回退的那几版反而翻不到。

    **内置条目唯一放行的字段是 `hidden`**：它改的不是模板内容（那是常量），而是
    「这台部署要不要在列表里看见它」，改了也不会被下次升级冲掉。其余字段照旧 400。
    """
    if is_builtin(prompt_id):
        if prompt_id not in BUILTIN_BY_ID:
            raise StudioPromptError(f"提示词不存在：{prompt_id}", status=404)
        touched_content = any(
            value is not None
            for value in (title, body, negative, scene, favorite, variables, note)
        ) or move_group
        if touched_content or hidden is None:
            raise StudioPromptError(BUILTIN_READONLY)
        return await set_builtin_hidden(session, prompt_id, hidden)

    row = await _get_prompt(session, prompt_id)
    before = _snapshot(row)
    if move_group:
        if group_id is not None:
            await _get_group(session, group_id)
        row.group_id = group_id
    if title is not None:
        row.title = _clean_title(title)
    if body is not None:
        row.body = _clean_body(body)
    if negative is not None:
        row.negative = negative.strip()
    if scene is not None:
        row.scene = scene.strip()[:MAX_SCENE]
    if favorite is not None:
        row.favorite = favorite
    # 正文或负向变了要重新对齐占位；只改说明时按传进来的声明合并
    if body is not None or negative is not None or variables is not None:
        row.variables = check_variable_limit(
            sync_variables(row.body, row.negative or "", variables)
        )
    row.updated_at = _now()

    if _snapshot(row) != before:
        await studio_revisions.ensure_baseline(
            session,
            studio_revisions.ENTITY_PROMPT,
            row.id,
            snapshot=before,
            note="首次编辑前的内容",
        )
        row.version = await studio_revisions.next_version(
            session, studio_revisions.ENTITY_PROMPT, row.id
        )
        await studio_revisions.record(
            session,
            studio_revisions.ENTITY_PROMPT,
            row.id,
            snapshot=_snapshot(row),
            note=note,
            version=row.version,
        )
    await session.commit()
    await session.refresh(row)
    return prompt_view(row)


async def delete_prompt(session: AsyncSession, prompt_id: int) -> None:
    row = await _get_prompt(session, prompt_id)
    await studio_revisions.drop_entity(session, studio_revisions.ENTITY_PROMPT, row.id)
    await session.delete(row)
    await session.commit()


# ---- 版本历史 ----


async def list_prompt_revisions(session: AsyncSession, prompt_id: int) -> list[dict]:
    if is_builtin(prompt_id):
        # 内置模板不落库也就没有历史。空列表而不是 400：界面照常渲染一个空面板，
        # 不用为「这条有没有历史」再判一次
        if prompt_id not in BUILTIN_BY_ID:
            raise StudioPromptError(f"提示词不存在：{prompt_id}", status=404)
        return []
    await _get_prompt(session, prompt_id)
    return await studio_revisions.list_revisions(
        session, studio_revisions.ENTITY_PROMPT, prompt_id
    )


async def restore_prompt(session: AsyncSession, prompt_id: int, version: int) -> dict:
    """回滚到某一版：把旧内容重新提交成**新的一版**，而不是把版本号退回去。

    这样回滚本身也在历史里留痕，回滚回滚得回来；版本号一旦倒退，
    同一个号码就会先后指向两份内容，导出物上写的版本号也就失去意义。
    """
    row = await _get_prompt(session, prompt_id)
    revision = await studio_revisions.get_revision(
        session, studio_revisions.ENTITY_PROMPT, prompt_id, version
    )
    snapshot = revision.snapshot or {}
    row.title = _clean_title(str(snapshot.get("title") or ""))
    row.body = _clean_body(str(snapshot.get("body") or ""))
    row.negative = str(snapshot.get("negative") or "").strip()
    row.scene = str(snapshot.get("scene") or "").strip()[:MAX_SCENE]
    row.variables = sync_variables(row.body, row.negative, snapshot.get("variables"))
    row.updated_at = _now()
    row.version = await studio_revisions.next_version(
        session, studio_revisions.ENTITY_PROMPT, prompt_id
    )
    await studio_revisions.record(
        session,
        studio_revisions.ENTITY_PROMPT,
        prompt_id,
        snapshot=_snapshot(row),
        note=f"回滚到第 {version} 版",
        version=row.version,
    )
    await session.commit()
    await session.refresh(row)
    return prompt_view(row)


async def pin_prompt_revision(
    session: AsyncSession, prompt_id: int, version: int, pinned: bool
) -> dict:
    await _get_prompt(session, prompt_id)
    return await studio_revisions.set_pinned(
        session, studio_revisions.ENTITY_PROMPT, prompt_id, version, pinned
    )


async def render_by_id(
    session: AsyncSession, prompt_id: int, values: dict[str, Any] | None
) -> dict:
    """按 id 渲染一条提示词。内置条目也能渲染——它们只是没有变量而已。"""
    if is_builtin(prompt_id):
        item = BUILTIN_BY_ID.get(prompt_id)
        if item is None:
            raise StudioPromptError(f"提示词不存在：{prompt_id}", status=404)
        # 说明（标签、必填、默认值）由模板自带的声明提供，名单仍按正文现算
        return fill_variables(
            item["body"], item["negative"], list(item.get("variables") or ()), values
        )
    row = await _get_prompt(session, prompt_id)
    return fill_variables(row.body, row.negative or "", row.variables, values)


async def fork_prompt(session: AsyncSession, prompt_id: int) -> dict:
    """复制成一条自建条目。内置模板要改就走这条路；自建条目也能复制着改。"""
    if is_builtin(prompt_id):
        item = BUILTIN_BY_ID.get(prompt_id)
        if item is None:
            raise StudioPromptError(f"提示词不存在：{prompt_id}", status=404)
        source = builtin_view(prompt_id, item)
        group_id = None
    else:
        row = await _get_prompt(session, prompt_id)
        source = prompt_view(row)
        group_id = row.group_id

    title = (source["title"] + FORK_SUFFIX)[:MAX_TITLE]
    fork = StudioPrompt(
        group_id=group_id,
        title=title,
        body=source["body"],
        negative=source["negative"],
        scene=source["scene"],
        # 变量声明跟着一起复制：副本的正文一模一样，占位当然也一样，
        # 让用户再把每个变量的说明重打一遍没有道理
        variables=sync_variables(source["body"], source["negative"], source.get("variables")),
        version=1,
    )
    session.add(fork)
    await session.flush()
    await studio_revisions.record(
        session,
        studio_revisions.ENTITY_PROMPT,
        fork.id,
        snapshot=_snapshot(fork),
        note=f"复制自 #{prompt_id}",
        version=1,
    )
    await session.commit()
    await session.refresh(fork)
    return prompt_view(fork)


async def use_prompt(session: AsyncSession, prompt_id: int) -> int:
    """套用一次，返回累计次数。

    内置条目不计数但也不报错：套用是「用户点了一下套用按钮」，为了一个统计数字
    去打断这个动作没有道理（前端的 usePrompt 本来就是 fire-and-forget）。
    计数不刷 updated_at——用一次不该把条目在列表里顶到最前（同 BR-146 的精神）。
    """
    if is_builtin(prompt_id):
        if prompt_id not in BUILTIN_BY_ID:
            raise StudioPromptError(f"提示词不存在：{prompt_id}", status=404)
        return 0
    row = await _get_prompt(session, prompt_id)
    row.used_count = (row.used_count or 0) + 1
    await session.commit()
    return row.used_count


# ---- AI 写一条 ----

# 写提示词这件事本身就是「创作」，与工坊 GPT 对话同一个脑子，复用它的能力绑定。
# 不为它新起一个能力名：`capability_binding` 每多一个能力名，用户就要在
# 设置 · 模型服务里多绑一次，而绑漏了的表现是「点了没反应，报未绑定」。
COMPOSE_CAPABILITY = "chat-general"

MAX_INTENT = 2000
#: 扩写时喂回去的原稿上限。比 MAX_BODY 略松没有意义——超过这个长度的正文，
#: 模型要做的已经不是扩写而是重写了
MAX_COMPOSE_DRAFT = MAX_BODY

COMPOSE_MODES = ("create", "expand", "polish")

#: 产出正文的语种。生图模型对英文提示词的响应普遍更准，默认英文；
#: 中文是给「模型本来就吃中文」的场景留的（国产生图、文案类）
COMPOSE_LANGUAGES = {"en": "English", "zh": "简体中文"}

_MODE_TASK = {
    "create": "根据用户的描述，从零写一条可直接使用的提示词。",
    "expand": "把用户给的原稿扩写成完整提示词：保留原稿已经写死的一切内容与意图，只补齐缺的维度。",
    "polish": "润色用户给的原稿：结构、措辞、冗余重复。不要改变它想画的东西。",
}

COMPOSE_SYSTEM = """你是生图提示词工程师。产出会被原样发给文生图模型。

只输出一个 JSON 对象，字段固定：
{"title": "", "scene": "", "body": "", "negative": "", "variables": []}

- title：中文短标题，不超过 20 字，说清这条是干什么的。
- scene：中文一句话，说清什么时候该用它，不超过 40 字。
- body：正向提示词全文，就是要发给模型的那一段。写成逗号分隔的短语流，
  覆盖主体、构图与视角、光线、材质与质感、色彩、镜头或画风。不要写"请你""帮我"
  这类对话口吻，不要解释，不要 markdown。
- negative：负向提示词，逗号分隔的英文短语；用户说了不要负向就给空字符串。
- variables：给正文里留的占位补中文说明，每项 {"name","label","description"}。
  name 必须与正文里 {{name}} 的写法一字不差。正文没留占位就给空数组。

占位规则：只有在被要求留占位时才写，语法是双花括号 {{名字}}，名字可用中文。
一条最多留 3 个占位，只留真正每次都要换的那一两个词（主体、产品名），
画风光线这些模板的价值所在绝不留成占位。"""


def _compose_user_prompt(
    *,
    intent: str,
    draft: str,
    negative: str,
    mode: str,
    language: str,
    with_negative: bool,
    with_variables: bool,
) -> str:
    lang = COMPOSE_LANGUAGES.get(language, COMPOSE_LANGUAGES["en"])
    lines = [_MODE_TASK.get(mode, _MODE_TASK["create"]), "", f"正文（body）用{lang}写。"]
    lines.append(
        "留占位：正文里把每次都要换的那一两个词写成 {{名字}}，并在 variables 里给中文说明。"
        if with_variables
        else "不要留任何占位，正文要能直接发给模型。"
    )
    lines.append("要写负向提示词。" if with_negative else "negative 给空字符串。")
    if intent:
        lines += ["", "用户想要的：", intent]
    if draft:
        lines += ["", "用户已有的正向原稿：", draft]
    if negative:
        lines += ["", "用户已有的负向原稿：", negative]
    return "\n".join(lines)


def _compose_text(raw: Any, limit: int) -> str:
    """模型偶尔把 body 吐成数组（一行一个短语）。拼回去而不是丢掉——
    内容是对的，只是形状不对，丢掉的话用户看到的是空编辑器。"""
    if isinstance(raw, list):
        parts = [str(item).strip() for item in raw if str(item).strip()]
        return ", ".join(parts)[:limit]
    return str(raw or "").strip()[:limit]


def normalize_composed(parsed: Any) -> dict:
    """把模型吐的 JSON 收敛成编辑器能直接吃的草稿。

    **变量名单仍由正文派生**（`sync_variables`），与保存路径同一条口径：
    模型很爱在 variables 里多列几个正文里根本没有的名字，照单全收的话，
    用户在编辑器里会看到几个填了也没用的空格子，存一次又自己消失。
    """
    data = parsed if isinstance(parsed, dict) else {}
    body = _compose_text(data.get("body"), MAX_BODY)
    negative = _compose_text(data.get("negative"), MAX_BODY)
    declared = data.get("variables")
    return {
        "title": _clean_text_or_empty(data.get("title"), MAX_TITLE),
        "scene": _clean_text_or_empty(data.get("scene"), MAX_SCENE),
        "body": body,
        "negative": negative,
        "variables": sync_variables(body, negative, declared),
    }


def _clean_text_or_empty(raw: Any, limit: int) -> str:
    return str(raw or "").strip()[:limit]


async def compose_prompt(
    *,
    intent: str = "",
    draft: str = "",
    negative: str = "",
    mode: str = "create",
    language: str = "en",
    with_negative: bool = True,
    with_variables: bool = False,
    deployment_id: int | None = None,
) -> dict:
    """让模型写一条提示词草稿。**只产出，不入库**。

    返回的东西直接落进编辑器供人改，改完走常规的 create / patch 才落库。
    自动入库看着少一步，实际是把「模型写的」和「我认可的」混成一堆——
    生成质量参差是常态，库里一旦混进没人看过的条目，整个库就不敢直接套用了。

    `model` 回的是上游真实模型名（核心原则 6），界面上「模型」那一位显示它。
    """
    intent = (intent or "").strip()[:MAX_INTENT]
    draft = (draft or "").strip()[:MAX_COMPOSE_DRAFT]
    negative = (negative or "").strip()[:MAX_COMPOSE_DRAFT]
    if mode not in COMPOSE_MODES:
        mode = "create"
    # 有原稿却没说要干什么，默认是扩写：用户点的是正文旁边那个按钮
    if mode == "create" and draft:
        mode = "expand"
    if not intent and not draft:
        raise StudioPromptError("说一句想要什么，或者先写点正文再让 AI 接着写")

    user = _compose_user_prompt(
        intent=intent,
        draft=draft,
        negative=negative,
        mode=mode,
        language=language if language in COMPOSE_LANGUAGES else "en",
        with_negative=with_negative,
        with_variables=with_variables,
    )
    parsed, model, latency_ms = await llm.complete_json(
        COMPOSE_CAPABILITY, COMPOSE_SYSTEM, user, deployment_id=deployment_id
    )
    composed = normalize_composed(parsed)
    if composed["body"] == "":
        raise StudioPromptError("模型没给出正文，换个说法再试一次", status=502)
    # 数量闸门与保存路径同一条：这里不拦的话，用户改半天再点保存才被拒
    check_variable_limit(composed["variables"])
    composed["mode"] = mode
    composed["model"] = model
    composed["latency_ms"] = latency_ms
    return composed
