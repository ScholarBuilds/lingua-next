/* 成分角色归一化。

   守两件事：
   1. 线上真实出现过的 **70 种 role 串**，落到「其他」的比例要低（否则等于没收敛）
   2. 几条容易调换的优先级不能被后人无意改掉（定语 vs 从句、补足语 vs 宾语…） */

import { describe, expect, it } from 'vitest'

import realRoles from './__fixtures__/grammar-roles.json'
import { GRAM_ROLES, normalizeRole, roleClass, roleNote, ROLE_COLOR } from './grammarRole'

describe('normalizeRole', () => {
  it('枚举值原样返回', () => {
    for (const r of GRAM_ROLES) expect(normalizeRole(r)).toBe(r)
  })

  it.each([
    ['时间状语', '状语'],
    ['地点状语', '状语'],
    ['方式状语', '状语'],
    ['句首插入状语', '状语'],
    ['状语（时间/程度）', '状语'],
    ['形式主语', '主语'],
    ['真正主语', '主语'],
    ['从句主语', '主语'],
    ['省略主语', '主语'],
    ['系动词', '谓语'],
    ['助动词，用于一般现在时疑问句', '谓语'],
    ['情态动词 + 系动词/谓语部分', '谓语'],
    ['谓语动词（祈使）', '谓语'],
    ['help 的宾语', '宾语'],
    ['介词 of 的宾语', '宾语'],
    ['并列连词，表示转折', '连接词'],
    ['并列分句1', '分句'],
    ['主句', '分句'],
    ['倒装句，主句', '分句'],
  ] as const)('%s → %s', (raw, want) => {
    expect(normalizeRole(raw)).toBe(want)
  })

  describe('优先级：顺序调换就会错', () => {
    it('定语从句是定语，不是分句', () => {
      expect(normalizeRole('定语从句，修饰 factors')).toBe('定语')
      expect(normalizeRole('省略关系词的定语从句，修饰 everything')).toBe('定语')
      expect(normalizeRole('后置定语（过去分词短语，修饰 a truth）')).toBe('定语')
    })
    it('状语从句是状语，不是分句', () => {
      expect(normalizeRole('时间/条件状语从句（含省略）')).toBe('状语')
      expect(normalizeRole('时间状语从句')).toBe('状语')
    })
    it('表语从句是表语，不是分句', () => {
      expect(normalizeRole('表语从句（what 引导的名词性从句）')).toBe('表语')
    })
    it('宾语从句是宾语，不是分句', () => {
      expect(normalizeRole('considering 的宾语从句')).toBe('宾语')
      expect(normalizeRole('宾语从句核心结构')).toBe('宾语')
    })
    it('补足语归宾语一侧', () => {
      expect(normalizeRole('宾语补足成分/不定式补足语')).toBe('宾语')
      expect(normalizeRole('不定式，作补足语')).toBe('宾语')
    })
    it('连词优先于分句', () => {
      expect(normalizeRole('并列连词')).toBe('连接词')
    })
    it('介词短语垫底：介词 of 的宾语仍然是宾语', () => {
      expect(normalizeRole('介词 of 的宾语')).toBe('宾语')
      expect(normalizeRole('介词短语，表示“在家务方面/做家务”')).toBe('状语')
    })
    it('同位语算定语', () => {
      expect(normalizeRole('their neighbour 的同位语')).toBe('定语')
    })
    it('系表结构算谓语', () => {
      expect(normalizeRole('系表结构/被动表达')).toBe('谓语')
    })
  })

  it('空 / undefined 落其他', () => {
    expect(normalizeRole(undefined)).toBe('其他')
    expect(normalizeRole('   ')).toBe('其他')
  })
})

describe('线上真实 role 串（70 种）', () => {
  const roles = realRoles as string[]

  it('fixture 不是空的', () => {
    expect(roles.length).toBeGreaterThanOrEqual(60)
  })

  it('每一条都能归到枚举里', () => {
    for (const r of roles) expect(GRAM_ROLES).toContain(normalizeRole(r))
  })

  it('落到「其他」的不超过 5%（否则等于没收敛）', () => {
    const other = roles.filter((r) => normalizeRole(r) === '其他')
    expect(other.length / roles.length).toBeLessThanOrEqual(0.05)
  })
})

describe('roleClass / ROLE_COLOR', () => {
  it('九个角色九个类名，不重复（旧表里表语和宾语同色）', () => {
    const classes = GRAM_ROLES.map((r) => roleClass(r))
    // 分句与其他共用中性色，其余互不相同
    expect(new Set(classes).size).toBe(GRAM_ROLES.length)
  })

  it('同一个 role 串永远同色（旧实现按下标轮换）', () => {
    expect(roleClass('时间状语')).toBe(roleClass('地点状语'))
    expect(roleClass('宾语从句核心结构')).toBe(roleClass('宾语'))
  })

  it('每个枚举都有色卡', () => {
    for (const r of GRAM_ROLES) expect(ROLE_COLOR[r]).toMatch(/^var\(--hl-/)
  })
})

describe('roleNote', () => {
  it('有 note 用 note', () => {
    expect(roleNote('定语', '修饰 ladies')).toBe('修饰 ladies')
  })
  it('没 note 时，历史缓存写在 role 里的解释要留下来', () => {
    expect(roleNote('后置定语，修饰 ladies', undefined)).toBe('后置定语，修饰 ladies')
  })
  it('role 本来就是干净枚举时不重复显示', () => {
    expect(roleNote('主语', undefined)).toBe('')
  })
})
