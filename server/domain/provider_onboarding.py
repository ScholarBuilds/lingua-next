"""供应商授权引导（需求 17 §4.4 · CR-005 §3.9）。

配置中心里每个供应商都要回答四件事，缺一件用户就得自己去搜：

1. **这是什么** —— 平台定位、能提供哪些能力、怎么收费；
2. **怎么拿到凭据** —— 分步骤，**每一步配一个跳转按钮直达官方页面**；
3. **每个字段填什么** —— Base URL 要不要带 ``/v1``、Key 长什么样、区域怎么选；
4. **填错了会怎样** —— 常见错误与对应的修法。

数据与表单定义（``credentials.PROVIDER_TYPES``）分开放：表单是「录什么」，
这里是「怎么弄到手」。两者变更频率完全不同——表单跟着协议走，
引导跟着人家官网改版走。

.. warning::

   **链接一律要现场核对过再写。** 本仓有过教训：内置频道的 5 个 YouTube
   channel_id 凭记忆写，其中 3 个是 404。这里的原则是：

   - 只写**确信存在**的页面；拿不准就给控制台首页 + 一句「在左侧找 API Keys」，
     而不是编一个看起来很像的深链；
   - 每条链接都要能被 ``scripts/check_provider_links.py`` 探活；
   - 官网改版导致 404 时，宁可退回根域名也不留死链。
"""

from __future__ import annotations

from typing import TypedDict


class OnboardStep(TypedDict, total=False):
    """一个操作步骤。``url`` 可省——不是每步都要跳出去。"""

    title: str
    detail: str
    url: str
    url_label: str


class Onboarding(TypedDict, total=False):
    """一个供应商的完整引导。"""

    #: 这个平台是什么、能干什么
    summary: str
    #: 怎么收费。写不清楚就别写，含糊的计费说明比没有更误导
    pricing: str
    #: 官网首页。所有步骤链接失效时的兜底
    home: str
    #: 分步操作
    steps: list[OnboardStep]
    #: 字段名 → 这个字段该填什么
    field_help: dict[str, str]
    #: 常见错误 → 怎么修
    troubles: dict[str, str]


ONBOARDING: dict[str, Onboarding] = {
    "openai": {
        "summary": "OpenAI 官方接口。聊天、生图（gpt-image 系列）、视频（Sora）、语音"
                   "都在同一把 Key 下。",
        "pricing": "按 token / 按张计费，需要先充值；用量与账单在 Usage 页看。",
        "home": "https://platform.openai.com",
        "steps": [
            {
                "title": "注册并登录开发者平台",
                "detail": "个人账号即可，登录后才能建 Key。",
                "url": "https://platform.openai.com/signup",
                "url_label": "打开注册页",
            },
            {
                "title": "充值",
                "detail": "余额为 0 时所有请求都会被拒，报错是 insufficient_quota "
                          "而不是「没充值」。",
                "url": "https://platform.openai.com/settings/organization/billing/overview",
                "url_label": "打开账单页",
            },
            {
                "title": "创建 API Key",
                "detail": "建完只显示一次，当场复制。丢了只能重建，不能找回。",
                "url": "https://platform.openai.com/api-keys",
                "url_label": "打开 API Keys",
            },
        ],
        "field_help": {
            "api_key": "sk- 开头的一长串。项目级 Key 是 sk-proj- 开头，两种都能用。",
            "api_base": "留空就是官方地址。只有走自建代理时才需要填，**要带 /v1**。",
        },
        "troubles": {
            "401 Incorrect API key": "Key 抄漏了或者已被删除，回 API Keys 页重建一个。",
            "429 insufficient_quota": "不是限速，是余额不足或没绑支付方式，去账单页充值。",
        },
    },
    "deepseek": {
        "summary": "DeepSeek 官方，OpenAI 兼容接口。只有聊天/推理模型，没有生图。",
        "pricing": "按 token 计费，价格显著低于同级别模型；有免费额度。",
        "home": "https://platform.deepseek.com",
        "steps": [
            {
                "title": "注册并登录",
                "detail": "支持手机号注册。",
                "url": "https://platform.deepseek.com/sign_in",
                "url_label": "打开登录页",
            },
            {
                "title": "创建 API Key",
                "detail": "在左侧「API keys」里新建，同样只显示一次。",
                "url": "https://platform.deepseek.com/api_keys",
                "url_label": "打开 API Keys",
            },
        ],
        "field_help": {
            "api_key": "sk- 开头。",
            "api_base": "留空即可。要填就填 https://api.deepseek.com/v1（带 /v1）。",
        },
        "troubles": {
            "找不到生图模型": "DeepSeek 没有生图能力，出图请配别的供应商。",
        },
    },
    "openai_compatible": {
        "summary": "任何实现了 OpenAI 协议的网关或中转。绝大多数第三方聚合站都属于这一类。",
        "pricing": "看各家自己的定价，通常按官方价打折或按次计费。",
        "home": "",
        "steps": [
            {
                "title": "在你用的中转站拿到 Base URL 与 Key",
                "detail": "两个值都在它自己的控制台里，本项目不预设是哪一家。",
            },
            {
                "title": "填进来后点「测试连接」",
                "detail": "测试会打一次 /v1/models；通不过多半是 Base URL 少了或多了 /v1。",
            },
        ],
        "field_help": {
            "api_base": "**多数中转要带 /v1**（如 https://your-relay.com/v1）。"
                        "填错时 /v1/models 会 404。",
            "api_key": "中转站发的 Key，格式各家不同。",
        },
        "troubles": {
            "404 Not Found": "Base URL 的 /v1 多了或少了，两种都试一次。",
            "模型列表拉不到": "有些中转不开放 /v1/models，可以手动添加模型部署。",
        },
    },
    "ollama": {
        "summary": "本机跑开源模型。不联网、不花钱，但要自己的显卡扛。",
        "pricing": "免费。成本是本机的显存与电。",
        "home": "https://ollama.com",
        "steps": [
            {
                "title": "装 Ollama",
                "detail": "macOS/Windows/Linux 都有安装包。",
                "url": "https://ollama.com/download",
                "url_label": "打开下载页",
            },
            {
                "title": "拉一个模型",
                "detail": "命令行 `ollama pull qwen3` 之类；模型库里能看到全部可用模型与体积。",
                "url": "https://ollama.com/library",
                "url_label": "打开模型库",
            },
            {
                "title": "确认服务在跑",
                "detail": "默认监听 11434 端口。浏览器打开 http://localhost:11434 "
                          "能看到 Ollama is running。",
            },
        ],
        "field_help": {
            "api_base": "本机默认 http://localhost:11434/v1。装在别的机器上就换成那台的地址。"
                        "本机跑不需要 Key，表单上也就没有这一项。",
        },
        "troubles": {
            "连接被拒": "Ollama 没启动，或者装在别的机器上而地址还写着 localhost。",
        },
    },
    "modelscope": {
        "summary": "阿里魔搭社区的推理服务，OpenAI 兼容。聊天与生图共用一把令牌，"
                   "生图侧有 Z-Image、Qwen-Image、FLUX 等开源模型。",
        "pricing": "**每天有免费额度**，额度内不花钱；超出后按量计费。国内直连，不需要科学上网。",
        "home": "https://modelscope.cn",
        "steps": [
            {
                "title": "注册魔搭账号",
                "detail": "支持阿里云账号或手机号。要绑定阿里云账号才能用推理 API。",
                "url": "https://modelscope.cn",
                "url_label": "打开魔搭",
            },
            {
                "title": "创建访问令牌",
                "detail": "在「我的页面 → 访问令牌」里新建。这一个令牌同时管聊天与生图。",
                "url": "https://www.modelscope.cn/my/myaccesstoken",
                "url_label": "打开访问令牌页",
            },
        ],
        "field_help": {
            "api_key": "魔搭的访问令牌（不是阿里云 AccessKey）。",
            "api_base": "留空即可，默认 https://api-inference.modelscope.cn/v1。",
            "model": "模型名**带命名空间**，例如 Qwen/Qwen3-235B-A22B、Tongyi-MAI/Z-Image-Turbo。"
                     "只写后半截会 404。",
        },
        "troubles": {
            "模型不存在": "模型名少了命名空间前缀（要写成 组织/模型名 的形式）。",
            "额度用完": "免费额度按天刷新，等第二天或改用别的供应商。",
        },
    },
    "gemini_image": {
        "summary": "Google Gemini 的图像能力（Imagen / Gemini 原生生图）。",
        "pricing": "按张计费，有免费额度；额度与配额在 AI Studio 里看。",
        "home": "https://aistudio.google.com",
        "steps": [
            {
                "title": "登录 Google AI Studio",
                "detail": "用 Google 账号直接登录。部分地区需要科学上网。",
                "url": "https://aistudio.google.com",
                "url_label": "打开 AI Studio",
            },
            {
                "title": "创建 API Key",
                "detail": "在「Get API key」里新建，绑定一个 Google Cloud 项目。",
                "url": "https://aistudio.google.com/apikey",
                "url_label": "打开 API Key 页",
            },
        ],
        "field_help": {
            "api_key": "AIza 开头。",
            "api_base": "留空走官方。Gemini 用的是自己的协议，不是 OpenAI 协议。",
        },
        "troubles": {
            "User location is not supported": "该地区不支持，需要换出口或改用别的供应商。",
        },
    },
    "volcengine_video": {
        "summary": "火山方舟的视频生成（Seedance 等）。国内直连，不需要科学上网。",
        "pricing": "按秒/按次计费，需要在方舟控制台开通对应模型。",
        "home": "https://console.volcengine.com/ark",
        "steps": [
            {
                "title": "注册火山引擎并实名",
                "detail": "国内平台，个人也要实名认证才能用。",
                "url": "https://www.volcengine.com/",
                "url_label": "打开火山引擎",
            },
            {
                "title": "在方舟控制台开通模型",
                "detail": "**没开通的模型调用会直接失败**，而且报错不会说「未开通」。"
                          "逐个开通要用的。",
                "url": "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement",
                "url_label": "打开模型开通页",
            },
            {
                "title": "创建 API Key",
                "detail": "方舟的 Key 与账号的 AK/SK 是两套东西，这里要的是方舟 API Key。",
                "url": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
                "url_label": "打开 API Key 页",
            },
        ],
        "field_help": {
            "api_key": "方舟 API Key，不是账号的 AccessKey。",
            "api_base": "留空即可，默认 https://ark.cn-beijing.volces.com/api/v3。",
        },
        "troubles": {
            "模型不存在 / 无权限": "多半是没在「模型开通」页开通这个模型。",
        },
    },
    "volc_speech": {
        "summary": "火山引擎语音：实时对话、TTS 合成、录音文件识别（ASR）。同一把 key 三样都用。",
        "pricing": (
            "按时长计费。流式语音识别与录音文件识别**各有 20 小时免费试用额度**，"
            "但官方计费概述明写「免费试用及服务开通等操作均需手动前往豆包语音控制台开启」"
            "——不去点就不生效，直接按量计费。"
        ),
        "home": "https://console.volcengine.com/speech",
        "steps": [
            {
                "title": "开通语音技术服务",
                "detail": (
                    "在语音控制台里逐项开通要用的能力"
                    "（实时对话、语音合成、录音文件识别各自独立）。"
                ),
                "url": "https://console.volcengine.com/speech/app",
                "url_label": "打开语音控制台",
            },
            {
                "title": "领 20 小时免费额度",
                "detail": (
                    "免费试用要手动开启，开通服务后按预付费→后付费扣费。"
                    "额度耗尽时上游会拒（4500 开头的错误码），转写会自动降级到本地 whisper，"
                    "管线不会挂——但会悄悄变慢，跑量前先看一眼这一页。"
                ),
                "url": "https://console.volcengine.com/speech/new/overview?projectName=default",
                "url_label": "打开新版控制台总览",
            },
            {
                "title": "拿到 App ID 与 Access Token",
                "detail": "在应用详情里。语音服务用的是这两个值，不是方舟 API Key。",
            },
        ],
        "field_help": {
            "app_id": "语音应用的 App ID。",
            "access_key": (
                "同一个应用详情页里的 Access Token（表单字段名是 access_key）。"
                "这是**旧版控制台**的口径；新版控制台合并成了一个 X-Api-Key，"
                "本项目走的是旧版那一套，在新版页面里找不到「Access Token」是正常的。"
            ),
        },
        "troubles": {
            "音色不可用": "TTS 2.0 只认 uranus / saturn 系列音色，别的会报错。",
            "TTS 通了但转写报未授权": (
                "语音合成与录音文件识别是两项独立开通的服务，同一把 key 过了前者"
                "不代表过了后者。去控制台确认「录音文件识别」已开通并领了免费额度。"
            ),
        },
    },
    "comfyui": {
        "summary": "本机或局域网的 ComfyUI。工作流全在自己机器上跑，模型也是自己的。",
        "pricing": "免费。成本是本机显卡。",
        "home": "https://comfy.org",
        "steps": [
            {
                "title": "装 ComfyUI 并启动",
                "detail": "官方桌面版或源码都行，启动后记下监听地址。",
                "url": "https://comfy.org/download",
                "url_label": "打开下载页",
            },
            {
                "title": "确认能从本项目访问到",
                "detail": "装在别的机器上时要用 --listen 启动，否则只有那台机器自己能连。",
            },
        ],
        "field_help": {
            "api_base": "默认 http://127.0.0.1:8188。局域网的另一台机器就填它的 IP。",
        },
        "troubles": {
            "连不上": "ComfyUI 默认只监听 127.0.0.1，跨机器要加 --listen 0.0.0.0。",
        },
    },
    "runninghub": {
        "summary": "云端 ComfyUI：别人的显卡跑你的工作流，还带一批现成的 AI 应用。",
        "pricing": "积分制。有免费额度，也可以钱包付费跑收费节点。",
        "home": "https://www.runninghub.ai",
        "steps": [
            {
                "title": "注册账号",
                "detail": "注册后有免费积分可以先试。",
                "url": "https://www.runninghub.ai/",
                "url_label": "打开 RunningHub",
            },
            {
                "title": "在控制台拿 API Key",
                "detail": "免费额度与钱包是两套 Key，按你要跑的工作流类型选。",
            },
        ],
        "field_help": {
            "api_key": "免费额度用的 Key。",
            "wallet_api_key": "钱包（付费）Key。跑收费模型/节点时才需要。",
        },
        "troubles": {
            "积分不足": "免费额度用完了，换钱包 Key 或等额度刷新。",
        },
    },
    "google_oauth_client": {
        "summary": "Gmail 收件箱、发信与日历都经这一个 OAuth 客户端授权；"
        "每个 Google 账号授权后各自的刷新令牌另存。",
        "pricing": "免费。Gmail 与 Calendar API 的个人用量在免费额度内。",
        "home": "https://console.cloud.google.com/",
        "steps": [
            {
                "title": "建一个项目（已有就跳过）",
                "detail": "任意名字，比如 lingua。",
                "url": "https://console.cloud.google.com/projectcreate",
                "url_label": "新建项目",
            },
            {
                "title": "启用 Gmail API 与 Google Calendar API",
                "detail": "两个都要点「启用」。",
                "url": "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
                "url_label": "Gmail API",
            },
            {
                "title": "配置 OAuth 同意屏幕",
                "detail": "用户类型选「外部」，把自己的邮箱加进测试用户。"
                "测试状态下刷新令牌 7 天过期，个人使用可以直接点「发布应用」进入生产状态"
                "（不需要通过验证，授权时多一页「未验证」提示）。",
                "url": "https://console.cloud.google.com/apis/credentials/consent",
                "url_label": "同意屏幕",
            },
            {
                "title": "创建 OAuth 客户端 ID，类型选「桌面应用」",
                "detail": "桌面应用类型允许 loopback 回调，不用登记回调地址。"
                "把 Client ID 与 Client Secret 填到下面。",
                "url": "https://console.cloud.google.com/apis/credentials",
                "url_label": "凭据页",
            },
        ],
        "field_help": {
            "client_id": "形如 1234-abcd.apps.googleusercontent.com。",
            "client_secret": "GOCSPX- 开头。只在创建时显示一次，丢了就重建一个客户端。",
        },
        "troubles": {
            "授权页报 access_denied": "邮箱不在同意屏幕的测试用户里，或应用还没发布。",
            "同步时报 invalid_grant": "刷新令牌过期了（测试状态 7 天），到账号页重新授权；"
            "要根治就把应用发布到生产。",
            "Google 没有返回刷新令牌": "之前授权过一次且没撤销。"
            "到 myaccount.google.com 的第三方访问里撤销本应用，再授权。",
        },
    },
    "youtube": {
        "summary": "视频学习模块的取材来源。只用来下载字幕与片段，不产生 AI 调用。",
        "pricing": "免费。",
        "home": "https://www.youtube.com",
        "steps": [
            {
                "title": "登录一个 YouTube 账号",
                "detail": "登录态用来绕过部分视频的年龄/地区校验，纯公开视频不需要。",
                "url": "https://www.youtube.com",
                "url_label": "打开 YouTube",
            },
        ],
        "field_help": {},
        "troubles": {
            "取不到字幕": "该视频没有字幕轨，或者只有自动生成的滚动字幕（本项目会改用语音转写）。",
        },
    },
}


def onboarding_for(provider_type: str) -> Onboarding | None:
    """取一个供应商的引导。没有就返回 None——UI 据此决定要不要显示引导卡，
    不要拿空壳去渲染一张什么都没有的卡片。"""
    return ONBOARDING.get(provider_type)


def all_links() -> list[tuple[str, str]]:
    """全部外链，给探活脚本用。返回 (provider_type, url)。"""
    out: list[tuple[str, str]] = []
    for ptype, guide in ONBOARDING.items():
        home = guide.get("home", "")
        if home:
            out.append((ptype, home))
        for step in guide.get("steps", []):
            url = step.get("url", "")
            if url:
                out.append((ptype, url))
    return out
