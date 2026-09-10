/* 供应商授权引导卡（需求 17 §4.4 · CR-005 §3.9）。
 *
   录凭据这一步以前只有一行 `notes`，用户要自己去搜「这个平台的 Key 在哪拿」。
   这张卡回答四件事：

   1. **这是什么** —— 平台定位、能干什么、怎么收费；
   2. **怎么拿到凭据** —— 分步骤，每一步一个按钮直达官方页面；
   3. **每个字段填什么** —— Base URL 要不要带 /v1、Key 长什么样；
   4. **报错了怎么办** —— 常见错误与对应修法。

   数据全部来自 `/config/provider-types` 的 `onboarding` 字段，
   前端不硬编码任何链接——链接的正确性由 `scripts/check_provider_links.py` 探活守住
   （本仓踩过「凭记忆写外部 ID，5 个里 3 个 404」的坑）。 */

import { useState } from 'react'
import { ChevronDown, ExternalLink } from '@/components/NexusIcon'

import type { ProviderOnboarding } from '../../lib/api-config'

import './settings.css'

/** 把 `**加粗**` 渲染成 <strong>。引导文案里用它标「这一条最容易出错」。
 *
 *  不引 markdown 渲染器：这里只需要一种标记，而任何一个 md 库都比这段代码大三个数量级。 */
function emphasize(text: string): (string | JSX.Element)[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  )
}

export function OnboardingCard({
  guide,
  /** 表单上真实存在的字段名。只显示对得上号的说明——
   *  写错字段名的说明显示出来只会让人对着一个不存在的输入框找 */
  fieldNames,
}: {
  guide: ProviderOnboarding
  fieldNames: string[]
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const [troublesOpen, setTroublesOpen] = useState(false)

  const fields = Object.entries(guide.field_help ?? {}).filter(
    ([name]) => fieldNames.includes(name) || name === 'model',
  )
  const troubles = Object.entries(guide.troubles ?? {})

  return (
    <section className="onb">
      <button type="button" className="onb-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="onb-title">怎么拿到这个平台的凭据</span>
        <ChevronDown className={open ? 'onb-chev onb-chev-open' : 'onb-chev'} />
      </button>

      {open && (
        <div className="onb-body">
          {guide.summary !== undefined && guide.summary !== '' && (
            <p className="onb-summary">{emphasize(guide.summary)}</p>
          )}
          {guide.pricing !== undefined && guide.pricing !== '' && (
            <p className="onb-pricing">{emphasize(guide.pricing)}</p>
          )}

          <ol className="onb-steps">
            {(guide.steps ?? []).map((step, i) => (
              <li className="onb-step" key={`${step.title}-${i}`}>
                <span className="onb-step-no">{i + 1}</span>
                <span className="onb-step-text">
                  <b>{step.title}</b>
                  <span className="onb-step-detail">{emphasize(step.detail ?? '')}</span>
                  {step.url !== undefined && step.url !== '' && (
                    <a className="onb-link" href={step.url} target="_blank" rel="noreferrer noopener">
                      {step.url_label ?? '打开'}
                      <ExternalLink />
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ol>

          {fields.length > 0 && (
            <div className="onb-fields">
              <span className="onb-sub">每个字段填什么</span>
              <dl>
                {fields.map(([name, help]) => (
                  <div className="onb-field" key={name}>
                    <dt>{name}</dt>
                    <dd>{emphasize(help)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {troubles.length > 0 && (
            <div className="onb-troubles">
              <button
                type="button"
                className="onb-sub onb-sub-btn"
                onClick={() => setTroublesOpen((v) => !v)}
                aria-expanded={troublesOpen}
              >
                报错了怎么办（{troubles.length}）
                <ChevronDown className={troublesOpen ? 'onb-chev onb-chev-open' : 'onb-chev'} />
              </button>
              {troublesOpen && (
                <dl>
                  {troubles.map(([symptom, fix]) => (
                    <div className="onb-field" key={symptom}>
                      <dt className="onb-symptom">{symptom}</dt>
                      <dd>{emphasize(fix)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}

          {guide.home !== undefined && guide.home !== '' && (
            <a className="onb-home" href={guide.home} target="_blank" rel="noreferrer noopener">
              官网首页
              <ExternalLink />
            </a>
          )}
        </div>
      )}
    </section>
  )
}
