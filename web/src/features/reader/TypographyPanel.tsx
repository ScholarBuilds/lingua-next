/* 排版面板（FR-375）：字体族 / 字号 / 行距 / 栏宽 / 段距 / 字距 / 两端对齐 / 纸张主题。

   全部写进 prefStore.reader，服务端整包持久化，换设备也在。改动即时生效——
   正文容器读同一批 CSS 变量，不做"确定/取消"那种二段式（业内阅读器一律实时预览）。 */

import { IconClose } from '../../components/icons'

import { useEscapeClose } from '../../components/Overlay'
import type { PaperTheme, ReaderFont } from '../../lib/prefStore'
import { usePrefStore } from '../../lib/prefStore'

const FONTS: Array<{ value: ReaderFont; label: string; hint: string }> = [
  { value: 'serif', label: '衬线', hint: '长文默认，笔画有粗细变化，行间更好跟' },
  { value: 'sans', label: '无衬线', hint: '屏幕锐利，短篇与译文对照更清爽' },
  { value: 'mono', label: '等宽', hint: '逐词对齐，抄写与核对时用' },
  { value: 'dyslexic', label: '易读体', hint: '字形差异放大，减少形近字母误读' },
]

const PAPERS: Array<{ value: PaperTheme; label: string }> = [
  { value: 'auto', label: '跟随' },
  { value: 'paper', label: '纸白' },
  { value: 'sepia', label: '米黄' },
  { value: 'green', label: '护眼' },
  { value: 'night', label: '夜间' },
  { value: 'contrast', label: '高对比' },
]

interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}

function SliderRow({ label, value, min, max, step, format, onChange }: SliderRowProps) {
  return (
    <label className="tp-row">
      <span className="tp-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <b className="tp-val">{format(value)}</b>
    </label>
  )
}

export function TypographyPanel({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose)
  const r = usePrefStore((s) => s.prefs.reader)
  const set = usePrefStore((s) => s.update)
  const patch = (p: Partial<typeof r>) => set({ reader: p })

  return (
    <div className="tp-pop" onClick={(e) => e.stopPropagation()}>
      <div className="tp-head">
        <b>阅读排版</b>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="tp-sec">
        <div className="tp-sec-t">正文字体</div>
        <div className="tp-fonts">
          {FONTS.map((f) => (
            <button
              key={f.value}
              className={`tp-font f-${f.value}${r.font === f.value ? ' on' : ''}`}
              title={f.hint}
              onClick={() => patch({ font: f.value })}
            >
              <em>Aa</em>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tp-sec">
        <SliderRow
          label="字号"
          value={r.fontSize}
          min={14}
          max={34}
          step={1}
          format={(v) => `${v}px`}
          onChange={(v) => patch({ fontSize: v })}
        />
        <SliderRow
          label="行距"
          value={r.lineHeight}
          min={1.3}
          max={2.6}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) => patch({ lineHeight: v })}
        />
        <SliderRow
          label="栏宽"
          value={r.pageWidth}
          min={520}
          max={1200}
          step={20}
          format={(v) => `${v}px`}
          onChange={(v) => patch({ pageWidth: v })}
        />
        <SliderRow
          label="段距"
          value={r.paragraphGap}
          min={0.4}
          max={2.6}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(v) => patch({ paragraphGap: v })}
        />
        <SliderRow
          label="字距"
          value={r.letterSpacing}
          min={-0.3}
          max={2}
          step={0.1}
          format={(v) => `${v.toFixed(1)}px`}
          onChange={(v) => patch({ letterSpacing: v })}
        />
      </div>

      <div className="tp-sec">
        <div className="tp-sec-t">纸张</div>
        <div className="tp-papers">
          {PAPERS.map((p) => (
            <button
              key={p.value}
              className={`tp-paper p-${p.value}${r.paperTheme === p.value ? ' on' : ''}`}
              onClick={() => patch({ paperTheme: p.value })}
            >
              <i />
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tp-sec tp-switches">
        <label className="tp-sw">
          <input
            type="checkbox"
            checked={r.justify}
            onChange={(e) => patch({ justify: e.target.checked })}
          />
          <span>两端对齐</span>
        </label>
        <label className="tp-sw">
          <input
            type="checkbox"
            checked={r.wordLens}
            onChange={(e) => patch({ wordLens: e.target.checked })}
          />
          <span title="生词上方浮出中文小字，不用点开卡片">生词小译</span>
        </label>
      </div>

      <div className="tp-foot">
        <button
          className="btn btn-soft btn-sm"
          onClick={() =>
            patch({
              font: 'serif',
              fontSize: 19,
              lineHeight: 1.9,
              pageWidth: 760,
              paragraphGap: 1,
              letterSpacing: 0,
              justify: false,
              paperTheme: 'auto',
            })
          }
        >
          恢复默认
        </button>
      </div>
    </div>
  )
}
