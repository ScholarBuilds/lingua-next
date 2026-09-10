/* AI 语法分析的成分角色：把任意 role 串收敛到固定枚举。

   模型原先对 role 没有任何约束，prompt 里只写了「中文成分名，如 定语从句/状语」。
   实测线上缓存 **108 个成分吐出 70 种不同 role**：「主语」11 次、「宾语」10 次之后
   就是一条长尾——「后置定语（过去分词短语，修饰 a truth）」「help 的宾语」
   「谓语，固定搭配，表示"来自"」「系表结构/被动表达」。

   > [!danger] role 不固定，颜色就没有意义
   >
   > 前端只硬映射 18 个词，认不出的按 `下标 % 4` 轮换颜色。于是同一句重新分析一次，
   > 模型把「宾语从句」写成「宾语性从句」，颜色就换一个；「时间状语」和「地点状语」
   > 可能同色，「主语」和「并列连词」也可能同色。
   > **靠颜色记结构这个学习方式，在 role 自由的前提下根本不成立。**

   所以两头都收：prompt 端要求 role 只能取下面的枚举、解释另放 `note` 字段；
   这里再兜一道底，把历史缓存和模型跑偏时的自由文本归一化过来。 */

export const GRAM_ROLES = [
  '主语',
  '谓语',
  '宾语',
  '表语',
  '定语',
  '状语',
  '连接词',
  '分句',
  '其他',
] as const

export type GramRole = (typeof GRAM_ROLES)[number]

/* 归一化规则表，**顺序即优先级**，命中即返回。

   顺序是照着真实的 70 种 role 串排的，几个关键的先后不能调换：
   - 「定语」要排在「从句」前面：`定语从句，修饰 factors` 是定语，不是分句
   - 「状语」要排在「从句」前面：`时间/条件状语从句（含省略）` 是状语
   - 「补足语」要排在「宾语」前面：`宾语补足成分/不定式补足语` 归宾语一侧
   - 「连词」要排在「分句」前面：`并列连词，表示转折` 是连接词不是分句
   - 「介词短语 / 副词」垫底：只有前面全不命中时才按状语算，
     否则 `介词 of 的宾语` 会被误判成状语 */
const RULES: ReadonlyArray<readonly [RegExp, GramRole]> = [
  [/定语/, '定语'],
  [/同位/, '定语'],
  [/状语/, '状语'],
  [/表语/, '表语'],
  [/系表/, '谓语'],
  [/补足语|补语|宾补/, '宾语'],
  [/宾语/, '宾语'],
  [/主语/, '主语'],
  [/谓语|系动词|助动词|情态动词|实义动词/, '谓语'],
  [/连词|关系词|引导词|连接/, '连接词'],
  [/分句|主句|从句|句子/, '分句'],
  [/介词短语|副词/, '状语'],
]

const EXACT = new Set<string>(GRAM_ROLES)

/** 把任意 role 串收敛到枚举；认不出的落到「其他」，绝不再按下标轮换颜色。 */
export function normalizeRole(role: string | undefined): GramRole {
  const raw = (role ?? '').trim()
  if (raw === '') return '其他'
  if (EXACT.has(raw)) return raw as GramRole
  for (const [re, out] of RULES) if (re.test(raw)) return out
  return '其他'
}

/* 枚举 → 高亮色类名。一一对应，不再有两个角色抢同一个色
   （旧表里 表语 和 宾语 同为 gr-o、定语 和 状语 同为 gr-x）。 */
const ROLE_CLASS: Record<GramRole, string> = {
  主语: 'gr-s',
  谓语: 'gr-v',
  宾语: 'gr-o',
  表语: 'gr-c',
  定语: 'gr-a',
  状语: 'gr-x',
  连接词: 'gr-j',
  分句: 'gr-l',
  其他: 'gr-n',
}

export function roleClass(role: string | undefined): string {
  return ROLE_CLASS[normalizeRole(role)]
}

/** 图例色卡取值：与 CSS 里的 .gr-* 同源，避免两处各写一份颜色。 */
export const ROLE_COLOR: Record<GramRole, string> = {
  主语: 'var(--hl-blue)',
  谓语: 'var(--hl-pink)',
  宾语: 'var(--hl-green)',
  表语: 'var(--hl-teal)',
  定语: 'var(--hl-purple)',
  状语: 'var(--hl-yellow)',
  连接词: 'var(--hl-orange)',
  分句: 'var(--hl-slate)',
  其他: 'var(--hl-slate)',
}

/** 成分上要显示的补充说明：模型给了 note 就用 note，
    否则退回原始 role 串——历史缓存把解释写在 role 里（「后置定语，修饰 ladies」），
    归一化之后那半信息只能从原串里找回来。 */
export function roleNote(role: string | undefined, note: string | undefined): string {
  const n = (note ?? '').trim()
  if (n !== '') return n
  const raw = (role ?? '').trim()
  return EXACT.has(raw) ? '' : raw
}
