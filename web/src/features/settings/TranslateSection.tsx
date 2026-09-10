/* 翻译引擎：链式降级顺序（llm / google / bing）。
   顺序与启停由 BindingTable 的翻译链分组编辑，保存写 translate-chain 绑定的 params.chain */

import { BindingTable } from './BindingTable'
import { CGroup, SecHead } from './shared'
import { ServiceProbeButton } from './ServiceProbeButton'
import { apiConfig } from '../../lib/api-config'

export function TranslateSection() {
  return (
    <>
      <SecHead
        title="翻译引擎"
        desc="句子点译与双语对照按此顺序尝试：排前的引擎失败或超时，自动降级到下一个。"
      />

      <CGroup>降级顺序</CGroup>

      <BindingTable groups={['translate']} />
      <CGroup>引擎测试</CGroup>
      <p className="muted">分别翻译一条固定英文，显示完成耗时；“当前顺序”会显示实际使用的引擎。免费网页翻译接口可能受限。</p>
      <div className="translation-probes">
        {(['auto', 'llm', 'google', 'bing'] as const).map((engine) => <div className="translation-probe-row" key={engine}>
          <strong>{{ auto: '当前顺序', llm: '大模型翻译', google: 'Google 翻译', bing: 'Bing 翻译' }[engine]}</strong>
          <ServiceProbeButton run={() => apiConfig.translationProbe(engine)} />
        </div>)}
      </div>
    </>
  )
}
