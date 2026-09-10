/* 控制台左栏（模块 16 FR-443 / FR-448）。

   四轮之前这里是一列摊开的下拉框。摊开的问题不是难看，是**长不大**：画风有一百多个、
   比例要能预览、高级参数还在增加，全塞进 320px 的竖列只会越挤越糟。
   改成「设置行」：一行给一个配置，行上显示**当前值**与**一句话后果**，点开进各自的弹窗。

   五轮把这些行按因果顺序编了号，六轮又把分组的界线重划了一次。

   原来按「设置类型」分：想法/画风/提示词一组、比例一组、高级一组。这条界线是错的，
   因为**画幅属于画面本身**——手机整屏就是竖的、横幅就是宽的、头像就是方的，
   它由画什么决定，不是个人偏好。而且它实打实写进提示词正文的 `layout.canvas`，
   换了比例提示词就得重写，和换画风是同一类事。

   改成按「画什么 vs 怎么发」分：
   ① 画什么 = 想法 + 画风 + 画幅 + 提示词（四样互相决定，点开都进同一个创作台）
   ② 怎么发 = 质量档、张数、输出格式、背景、审核（跟画面无关，是这次调用的参数）

   四行摆在一起而不是合成一行，是因为四样都要能一眼看见当前值——尤其是提示词的状态，
   它决定画风与画幅到底生不生效。

   这个面板依旧不认识任何一个具体应用：显示哪几行完全由 `app.inputs` 与 `app.engine` 决定。 */

import type { ImageApp, StylePreset } from '@/lib/api-image'

import type { PromptState } from './consoleStore'

/** 点开哪个弹窗。弹窗本体由 ImagePage 渲染，这里只负责发起 */
export type ConfigDialog = 'prompt' | 'style' | 'ratio' | 'advanced'

export interface RefImage {
  id: string
  url: string
  file: File
}

export interface CostPreview {
  /** 纯前端处理，在浏览器里算 */
  free: boolean
  /** 只调视觉模型看图，不出图 */
  visionOnly: boolean
  calls: number
  tier: string
  quality: string
  /** 2K/4K 或 high 档，在按钮上标出来（BR-120） */
  hot: boolean
}

export function ParamPanel(props: {
  app: ImageApp
  idea: string
  prompt: string
  style: StylePreset | undefined
  /** 当前是不是「明确不指定画风」。与「没选」不是一回事 */
  noStyle: boolean
  /** 比例没钉住，由立意按画面内容挑 */
  autoRatio: boolean
  ratioLabel: string
  ratioSub: string
  advancedSummary: string
  advancedChips: string[]
  /** 提示词当前处于什么状态，决定画风到底生不生效 */
  promptState: PromptState
  /** stale 时提示词是按哪个画风生成的（中文名） */
  staleStyleLabel: string
  /** 有中文意图才重写得了。没有的话只能提醒，不能假装能自动修 */
  canRewrite: boolean
  /** 按当前画风重新写提示词 */
  onRegenPrompt: () => void
  regenerating: boolean
  refs: RefImage[]
  cost: CostPreview
  running: boolean
  onOpen: (which: ConfigDialog) => void
  onAddRefs: () => void
  onRemoveRef: (id: string) => void
  onSubmit: () => void
  onPlan: () => void
  onCollapse: () => void
}) {
  const { app, cost } = props
  const wantsPrompt = app.inputs.includes('prompt')
  const multi = app.inputs.includes('images')
  const tuneable = app.engine !== 'local' && app.engine !== 'vision'

  const ideaSummary = props.idea.trim() || '还没写'

  // 提示词那一行：值与后果都跟着状态走。这四种情况下画风的待遇完全不同，
  // 说成一句「画风决定风格」在其中两种里是错的（STD-UI-006）
  const promptRow = (() => {
    const chars = props.prompt.length
    switch (props.promptState.kind) {
      case 'empty':
        return { v: '出图时自动写', sub: '出图前 AI 会按上面的想法和画风译写成英文', tone: '' }
      case 'fresh':
        return {
          v: `${chars} 字符 · 已按当前画风写好`,
          sub: '出图直接用它。想看懂它要画什么，点开让 AI 讲',
          tone: 'ok',
        }
      case 'stale':
        return {
          v: `${chars} 字符 · ${props.promptState.wasStyle ? '画风' : '画幅'}变了`,
          sub: props.regenerating
            ? '正在按新画风重写…'
            : props.canRewrite
              ? '出图时会按当前画风重写'
              : '没有中文想法，自动重写不了',
          tone: 'warn',
        }
      default:
        // 手打的和跟 AI 聊出来的都算「你定的」，待遇一样：原样发、画风不参与
        return {
          v: `${chars} 字符 · 你定的`,
          sub: '原样发给模型，画风不参与',
          tone: 'warn',
        }
    }
  })()

  const styleValue = props.noStyle ? '不指定画风' : (props.style?.label ?? '未选')
  const styleSub = props.promptState.kind === 'hand'
    ? '当前不生效——提示词是你自己定的'
    : props.noStyle
      ? '不注入风格描述词，风格由你的想法和模型决定'
      : (props.style?.hint ?? '决定这批图看起来像同一个人画的')

  return (
    <>
      <div className="imgc-sec">
        当前应用
        <button onClick={props.onCollapse} title="收起参数栏">◀ 收起</button>
      </div>
      <div className="imgc-row locked">
        <span className="imgc-row-k">{app.label}</span>
        <span className="imgc-row-sub">{app.hint}</span>
      </div>

      {app.needs_image && (
        <>
          <div className="imgc-sec">{multi ? '参考图（至少 2 张）' : '原图'}</div>
          <div className="imgc-refs">
            {props.refs.map((ref) => (
              <div className="imgc-ref" key={ref.id}>
                <img src={ref.url} alt="" />
                <button onClick={() => props.onRemoveRef(ref.id)} title="移除">×</button>
              </div>
            ))}
            {(multi || props.refs.length === 0) && (
              <button className="imgc-ref-add" onClick={props.onAddRefs}>+ 选图</button>
            )}
          </div>
          {app.needs_mask && (
            <p className="imgc-note">选好图后在中间画布上涂出要改的区域，涂过的地方交给模型重画。</p>
          )}
          {app.inputs.includes('outpaint') && (
            <p className="imgc-note">选好图后在中间拖动边框决定往外扩多少，扩出来的区域由模型补。</p>
          )}
        </>
      )}

      {wantsPrompt && (
        <>
          <div className="imgc-sec">
            <b className="imgc-no">1</b>
            画什么
          </div>

          <button className="imgc-row" onClick={() => props.onOpen('prompt')}>
            <span className="imgc-row-k">想法</span>
            <span className="imgc-row-v">{ideaSummary}</span>
            <span className="imgc-row-sub">中文写一句要画什么、给谁看、用在哪里</span>
            <span className="imgc-row-go">›</span>
          </button>

          {tuneable && (
            <button className="imgc-row" onClick={() => props.onOpen('style')}>
              <span className="imgc-row-k">画风</span>
              <span className="imgc-row-v">{styleValue}</span>
              <span className="imgc-row-sub">{styleSub}</span>
              {props.style && !props.noStyle && props.style.source !== '自制'
                && props.promptState.kind !== 'hand' && (
                <span className="imgc-chips">
                  <span className="imgc-chip">{props.style.source}</span>
                </span>
              )}
              <span className="imgc-row-go">›</span>
            </button>
          )}

          {tuneable && (
            <button
              className={app.ratio ? 'imgc-row locked' : 'imgc-row'}
              onClick={app.ratio ? undefined : () => props.onOpen('ratio')}
            >
              <span className="imgc-row-k">画幅</span>
              <span className="imgc-row-v">{props.ratioLabel}</span>
              <span className="imgc-row-sub">
                {app.ratio
                  ? `这个应用锁定 ${app.ratio}——画幅由展示它的那块 UI 决定，不是偏好`
                  : props.ratioSub}
              </span>
              <span className="imgc-row-go">›</span>
            </button>
          )}

          <button className="imgc-row" onClick={() => props.onOpen('prompt')}>
            <span className="imgc-row-k">英文提示词</span>
            <span className={promptRow.tone ? `imgc-row-v ${promptRow.tone}` : 'imgc-row-v'}>
              {promptRow.v}
            </span>
            <span className="imgc-row-sub">{promptRow.sub}</span>
            <span className="imgc-row-go">›</span>
          </button>

          {/* 提示词一旦有内容，出图就**原样用它**，风格预设完全不参与。
              不说出来的话，用户改了画风、界面也显示新画风，出来的图却一直是旧的。 */}
          {props.promptState.kind === 'hand' && tuneable && (
            <div className="imgc-warn">
              <b>画风不生效：提示词是你自己定的</b>
              <span>
                手写的、或者跟 AI 聊着改出来的提示词，都会原样发给模型，风格预设不参与。
                要用画风就把它清空，让 AI 按画风重写一份。
              </span>
            </div>
          )}
          {props.promptState.kind === 'stale' && tuneable && !props.canRewrite && (
            <div className="imgc-warn">
              <b>
                提示词还是按{props.promptState.wasStyle
                  ? `「${props.staleStyleLabel}」`
                  : '上一个画幅'}写的
              </b>
              <span>
                没有中文想法，重写不出来。出图时它会被丢掉、由 AI 按当前画风从头写一份；
                想先看看写成什么样，就到创作台补一句想法。
              </span>
            </div>
          )}
        </>
      )}

      {tuneable && (
        <>
          <div className="imgc-sec">
            <b className="imgc-no">2</b>
            怎么发这一次
          </div>

          <button className="imgc-row" onClick={() => props.onOpen('advanced')}>
            <span className="imgc-row-k">高级</span>
            <span className="imgc-row-v">{props.advancedSummary}</span>
            <span className="imgc-row-sub">质量档、张数、输出格式、背景、审核强度</span>
            {props.advancedChips.length > 0 && (
              <span className="imgc-chips">
                {props.advancedChips.map((chip) => (
                  <span key={chip} className={chip.includes('2K') || chip.includes('4K') || chip === 'high' ? 'imgc-chip hot' : 'imgc-chip'}>
                    {chip}
                  </span>
                ))}
              </span>
            )}
            <span className="imgc-row-go">›</span>
          </button>
        </>
      )}

      <div className="imgc-sec">开出</div>

      <div className={cost.free ? 'imgc-cost free' : 'imgc-cost'}>
        {cost.free ? (
          <span>在浏览器里处理，<b>即时出结果</b></span>
        ) : cost.visionOnly ? (
          <span>调一次视觉模型看图，不出图</span>
        ) : (
          <>
            <span>本次调用</span>
            <b>{cost.calls}</b>
            <span>次 · {cost.tier.toUpperCase()} / {cost.quality}</span>
            {cost.hot && <span className="imgc-chip hot">高档</span>}
          </>
        )}
      </div>

      <div className="imgc-go">
        <button className="imgc-cta" disabled={props.running} onClick={props.onSubmit}>
          {props.running
            ? '执行中…'
            : app.engine === 'local'
              ? '打开编辑器'
              : app.engine === 'vision'
                ? '反推提示词'
                : `出图 ${cost.calls} 张`}
        </button>
        {tuneable && (
          <button className="btn btn-outline" onClick={props.onPlan}>
            一句话拆成一批 →
          </button>
        )}
      </div>

      <p className="imgc-note">
        {cost.free
          ? '改完的图照常入库，可以检索、复用、设为封面。'
          : '创作台里的写词、解读、对话都只调文本模型，出图才真的开始画。'}
      </p>
    </>
  )
}
