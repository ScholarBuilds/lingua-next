/* 尺寸选择器的纯函数守卫（模块 17）。
 *
   这几个函数的错法都是**静默的**：算出一个服务端会拒的尺寸、
   或者反查不到导致弹层高亮不上，界面上都不报错。 */

import { describe, expect, it } from 'vitest'

import { AUTO_SIZE, matchPreset, sizeFor, sizeLabel } from './ui/size-picker'

describe('比例 + 档位 → 尺寸', () => {
  it('方图各档', () => {
    expect(sizeFor('1:1', '1k')).toBe('1024x1024')
    expect(sizeFor('1:1', '2k')).toBe('2048x2048')
  })

  it('竖图长边在高上', () => {
    const got = sizeFor('9:16', '1k') as string
    const [w, h] = got.split('x').map(Number)
    expect(h).toBeGreaterThan(w)
    expect(h).toBe(1024)
  })

  it('横图长边在宽上', () => {
    const [w, h] = (sizeFor('16:9', '1k') as string).split('x').map(Number)
    expect(w).toBeGreaterThan(h)
    expect(w).toBe(1024)
  })

  it('所有组合都满足服务端的硬约束', () => {
    /* 服务端 validate_size：16 的倍数、单边 ≤3840、比例在 1:3~3:1。
       算出不合法的值不会在这里报错——要等用户点了出图才被服务端拒 */
    for (const r of ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '9:21']) {
      for (const t of ['1k', '2k', '4k']) {
        const size = sizeFor(r, t)
        expect(size, `${r} ${t}`).not.toBeNull()
        const [w, h] = (size as string).split('x').map(Number)
        expect(w % 16, `${r} ${t} 宽不是 16 的倍数`).toBe(0)
        expect(h % 16, `${r} ${t} 高不是 16 的倍数`).toBe(0)
        expect(Math.max(w, h), `${r} ${t} 超长边`).toBeLessThanOrEqual(3840)
        const ratio = w / h
        expect(ratio, `${r} ${t} 比例越界`).toBeGreaterThanOrEqual(1 / 3)
        expect(ratio, `${r} ${t} 比例越界`).toBeLessThanOrEqual(3)
      }
    }
  })

  it('不认识的比例或档位返回 null，不瞎算', () => {
    expect(sizeFor('7:3', '1k')).toBeNull()
    expect(sizeFor('1:1', '8k')).toBeNull()
  })
})

describe('反查：尺寸 → 比例 + 档位', () => {
  it('preset 生成的尺寸一定反查得到', () => {
    // 反查不到的话弹层里高亮不上，用户看到的是"我明明选了却没选中"
    for (const r of ['1:1', '2:3', '9:16', '21:9']) {
      for (const t of ['1k', '2k', '4k']) {
        expect(matchPreset(sizeFor(r, t) as string), `${r} ${t}`).toEqual({ ratio: r, tier: t })
      }
    }
  })

  it('自定义尺寸反查不到', () => {
    expect(matchPreset('1000x600')).toBeNull()
  })
})

describe('胶囊上的文字', () => {
  it('auto 与空串都显示"画幅自动"', () => {
    // 空串是老节点存的值，与 auto 同义（见 canvasStore.sizeParam）
    expect(sizeLabel(AUTO_SIZE)).toBe('画幅自动')
    expect(sizeLabel('')).toBe('画幅自动')
  })

  it('preset 显示"比例 · 档位"', () => {
    expect(sizeLabel(sizeFor('2:3', '1k') as string)).toBe('2:3 · 1K')
    expect(sizeLabel(sizeFor('16:9', '4k') as string)).toBe('16:9 · 4K')
  })

  it('档位按长边算，所以旧节点存的尺寸会落到"自定义"', () => {
    /* 老的画幅下拉用的是 `1024x1536` 这一族（照抄 gpt-image 的官方档），
       新的按"长边 = 1024/2048/3840"算（与蓝本一致），两边对不上。
       **这不是缺陷**：值本身照常有效，只是打开弹层时落在自定义页、
       输入框里是那个数。重新选一次就归位。记在这里免得被当成 bug 修掉。 */
    expect(matchPreset('1024x1536')).toBeNull()
    expect(sizeLabel('1024x1536')).toBe('1024x1536')
  })

  it('自定义尺寸原样显示', () => {
    expect(sizeLabel('1000x600')).toBe('1000x600')
  })
})

describe('档位是用户的意图，不是值的属性', () => {
  /* 这一组锁的是两个实测抓到的 bug，形态相同：
     `scope` 完全由 `scopeOf(value)` 反推时，只要用户在自定义档填的值
     恰好等于某个 preset，tab 就会当场弹回系统参数。

     第一次发作是点「自定义」时预填 1024×1024（正好是 1:1 · 1K）；
     修掉预填之后第二次发作是用户自己填了 1024×1024——同一个洞，只是延后。

     组件里的解法是 `pickedScope` 存意图 + `mine` 区分"外部改的/自己改的"。
     这里守的是**为什么需要它**：反推函数确实会把那些值判成 preset。 */

  it('1024x1024 这类"自定义值"确实会被反推成 preset', () => {
    expect(matchPreset('1024x1024')).toEqual({ ratio: '1:1', tier: '1k' })
    // 所以 scope 不能只看值——看值的话用户永远待不住自定义档
    expect(sizeLabel('1024x1024')).toBe('1:1 · 1K')
  })

  it('恰好落在 preset 上的自定义尺寸不止一个', () => {
    // 说明这不是"1024 这一个特例"，而是整类问题
    const collisions = ['1024x1024', '2048x2048'].filter((s) => matchPreset(s) !== null)
    expect(collisions.length).toBeGreaterThan(1)
  })
})
