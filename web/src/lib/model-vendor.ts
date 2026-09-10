/* 上游模型名 → 厂商。模型选择器按厂商分组时的唯一判据。
 *
 * 为什么不用 `provider_type`：它记的是**接入协议**不是厂商。开发库里五个凭据有四个是
 * `openai_compatible`（gpt 中转 / 智谱中转 / 个人中转 / DeepSeek 官方），按它分组等于不分组，
 * 而同一个中转站后面同时挂着 OpenAI、DeepSeek、GLM、Qwen、Kimi、MiniMax 六家的模型。
 * 厂商这件事只有模型名自己知道。
 *
 * 规则按「先长后短」排：`k3-256k` 要在 `kimi` 之后仍能命中月之暗面，而 `codestral` 不能被
 * `command` 抢走。改动这张表前先跑一遍 model-vendor.test.ts——它拿开发库里真实的 46 个模型名对账。
 */

export interface Vendor {
  key: string
  /** 分组标题用的中文名 */
  name: string
  /** 圆标底色，取各家官方主色；只在这里定义，组件不许再写死颜色 */
  color: string
  /** 圆标里的字，一到两个字符 */
  abbr: string
}

/** 认不出厂商时的归属。不猜、不硬塞进某一家——宁可单列一组 */
export const UNKNOWN_VENDOR: Vendor = {
  key: 'unknown',
  name: '其它',
  color: '#8B8378',
  abbr: '?',
}

/** 不是对话模型的那些（嵌入、重排、语音识别），单列一组并排在最后 */
export const NON_CHAT_VENDOR: Vendor = {
  key: 'non-chat',
  name: '非对话模型',
  color: '#9DA4AA',
  abbr: '—',
}

const VENDORS: Array<{ vendor: Vendor; match: RegExp }> = [
  // 嵌入 / 重排放最前：embedding-3 这类名字不带厂商前缀，落到后面会被当成对话模型摆给用户选
  { vendor: NON_CHAT_VENDOR, match: /embedding|^bge-|^rerank|^text-embedding|^whisper|^tts-/ },
  { vendor: { key: 'openai', name: 'OpenAI', color: '#10A37F', abbr: 'AI' }, match: /^(gpt|chatgpt|codex|o[1-9](-|$)|dall-e|sora)/ },
  { vendor: { key: 'anthropic', name: 'Anthropic', color: '#D97757', abbr: 'CL' }, match: /^claude/ },
  { vendor: { key: 'google', name: 'Google', color: '#4285F4', abbr: 'G' }, match: /^(gemini|gemma|imagen|palm)/ },
  { vendor: { key: 'deepseek', name: 'DeepSeek', color: '#4D6BFE', abbr: 'DS' }, match: /^deepseek/ },
  { vendor: { key: 'zhipu', name: '智谱 GLM', color: '#0F6FDE', abbr: '智' }, match: /^(glm|chatglm|cogview|cogvideo)/ },
  { vendor: { key: 'qwen', name: '通义千问', color: '#615CED', abbr: '通' }, match: /^(qwen|qwq|qvq|tongyi)/ },
  { vendor: { key: 'moonshot', name: '月之暗面 Kimi', color: '#0F1114', abbr: 'K' }, match: /^(kimi|moonshot|k[0-9])/ },
  { vendor: { key: 'minimax', name: 'MiniMax', color: '#E8452C', abbr: 'MM' }, match: /^(minimax|abab)/ },
  { vendor: { key: 'bytedance', name: '火山豆包', color: '#1664FF', abbr: '豆' }, match: /^(doubao|seed-|skylark)/ },
  { vendor: { key: 'meta', name: 'Meta Llama', color: '#0668E1', abbr: 'La' }, match: /^(llama|codellama)/ },
  { vendor: { key: 'mistral', name: 'Mistral', color: '#FA520F', abbr: 'Mi' }, match: /^(mistral|mixtral|codestral|ministral)/ },
  { vendor: { key: 'xai', name: 'xAI Grok', color: '#0F1114', abbr: 'xA' }, match: /^grok/ },
  { vendor: { key: 'baidu', name: '百度文心', color: '#2932E1', abbr: '文' }, match: /^(ernie|wenxin)/ },
  { vendor: { key: 'stepfun', name: '阶跃星辰', color: '#0057FF', abbr: '阶' }, match: /^step-/ },
  { vendor: { key: '01ai', name: '零一万物', color: '#003425', abbr: '零' }, match: /^yi-/ },
  { vendor: { key: 'cohere', name: 'Cohere', color: '#39594D', abbr: 'Co' }, match: /^command/ },
  { vendor: { key: 'tencent', name: '腾讯混元', color: '#0052D9', abbr: '混' }, match: /^hunyuan/ },
  { vendor: { key: 'iflytek', name: '讯飞星火', color: '#0057FF', abbr: '讯' }, match: /^(spark|generalv)/ },
]

/** 上游真实模型名 → 厂商；认不出返回「其它」，绝不猜。 */
export function vendorOf(upstreamModelId: string): Vendor {
  const name = upstreamModelId.trim().toLowerCase()
  if (name === '') return UNKNOWN_VENDOR
  for (const { vendor, match } of VENDORS) {
    if (match.test(name)) return vendor
  }
  return UNKNOWN_VENDOR
}

/** 分组排序：认得出的按 VENDORS 的顺序，「其它」倒数第二，非对话模型垫底 */
export function vendorRank(key: string): number {
  if (key === NON_CHAT_VENDOR.key) return 900
  if (key === UNKNOWN_VENDOR.key) return 800
  const idx = VENDORS.findIndex((v) => v.vendor.key === key)
  return idx === -1 ? 800 : idx
}

/** 同一厂商内的模型排序：新版本在前（数字大的在前），同版本按名字。
 *
 *  纯字典序会把 glm-4 排在 glm-5.2 前面、gpt-5.2 排在 gpt-5.6 前面——用户要的几乎总是最新那个。
 *  版本号按「点分数字」逐段比，取模型名里第一串数字开始的部分。 */
export function compareModelName(a: string, b: string): number {
  const va = versionParts(a)
  const vb = versionParts(b)
  const len = Math.max(va.length, vb.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (vb[i] ?? -1) - (va[i] ?? -1)
    if (diff !== 0) return diff
  }
  return a.localeCompare(b)
}

function versionParts(name: string): number[] {
  const m = /(\d+(?:\.\d+)*)/.exec(name)
  if (m === null) return []
  return m[1].split('.').map((part) => Number(part))
}
