"""``generate_video`` 工具：文生视频 / 图生视频，落到统一执行器的 ``video.generate``。

视频部署不让模型挑：合同上 ``deployment_id`` 是必填，但对话里模型不可能知道有哪些部署，
所以由宿主按 ``video-generate`` 的能力绑定解析。没绑定就当场把话说清楚，别提交一个注定
失败的任务。
"""

from __future__ import annotations

from domain.agent_tools.submit import (
    AgentToolError,
    SubmitBrief,
    SubmittedTask,
    TaskToolTurn,
    build_submit_tool,
    host_payload,
    submit_operation,
)
from domain.model_catalog import bound_deployment_id

TOOL_NAME = "generate_video"
OPERATION = "video.generate"
LABEL = "视频生成"
# 视频走既有语义别名，与控制台、画布同一条绑定
VIDEO_CAPABILITY = "video-generate"

WITHHELD = {
    "deployment_id": "按 video-generate 的能力绑定解析，模型不知道有哪些部署",
    "reference_asset_id": "旧的单参考写法，与 references 二选一，统一走 references",
    "media_references": "视频 / 音频多模态参考只有即梦与火山支持，且要媒体资产 id",
}

DESCRIPTION = (
    "生成一段视频。用户要「动起来」「做个几秒的片段」「把这张图变成视频」时调它。"
    "纯文字描述就是文生视频；给了 references 就是图生视频——首帧决定画面从哪儿开始，"
    "尾帧决定收在哪儿。视频要跑几十秒到几分钟，提交后先回话，跑完自动贴回对话。"
    "只想要一张静态图就用 generate_image，别用这个。"
)

BRIEF = SubmitBrief(
    name=TOOL_NAME,
    operation=OPERATION,
    label=LABEL,
    description=DESCRIPTION,
    withheld=WITHHELD,
    describe={
        "prompt": (
            "英文描述，重点写**动**：主体做什么动作、镜头怎么运动、时间上先后发生什么，"
            "再补光线与画风。不要写时长和比例，那是单独的参数。"
        ),
        "duration": "秒数，默认 4。上游多半只支持 4~10 秒，别写更长除非用户点名要。",
        "aspect_ratio": "画幅比例，如 16:9 / 9:16 / 1:1，默认 16:9。竖屏内容用 9:16。",
        "resolution": "分辨率档，如 480p / 720p / 1080p，默认 720p。",
        "references": (
            "参考图，元素是 {asset_id, role}；role 取 first_frame（首帧）、"
            "last_frame（尾帧）或 reference_image（风格/主体参考）。"
            "资产 id 必须来自对话里已有的图，不要凭空编。"
        ),
        "options": (
            "开关，常用两个：generate_audio=true 同时生成声音，watermark=true 打水印。"
            "其余项只有特定上游支持，用户没点名就别填。"
        ),
    },
)


async def run(args, turn: TaskToolTurn) -> SubmittedTask:
    deployment_id = await bound_deployment_id(turn.session, VIDEO_CAPABILITY)
    if deployment_id is None:
        raise AgentToolError(
            f"还没有可用的视频模型：到设置 · 模型服务把 {VIDEO_CAPABILITY} 绑到一条视频部署上"
        )
    payload = host_payload(args, deployment_id=deployment_id)
    return await submit_operation(OPERATION, payload, turn=turn, label=LABEL)


GENERATE_VIDEO = build_submit_tool(BRIEF, run)

__all__ = [
    "BRIEF",
    "DESCRIPTION",
    "GENERATE_VIDEO",
    "LABEL",
    "OPERATION",
    "TOOL_NAME",
    "VIDEO_CAPABILITY",
    "WITHHELD",
    "run",
]
