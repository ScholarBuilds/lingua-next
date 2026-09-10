import { beforeEach, expect, it } from 'vitest'
import { useWordModalStore } from './wordModalStore'

beforeEach(() => useWordModalStore.getState().close())

it('听读推进替换当前词卡，不叠加面包屑；关闭解除联动', () => {
  const modal = useWordModalStore.getState()
  modal.openWord('one', 'one example')
  useWordModalStore.setState({ followListen: true })
  modal.replaceWord('two', 'two example')
  expect(useWordModalStore.getState().followListen).toBe(true)
  expect(useWordModalStore.getState().stack).toHaveLength(1)
  expect(useWordModalStore.getState().stack[0]).toMatchObject({ word: 'two', context: 'two example' })
  modal.close()
  expect(useWordModalStore.getState().followListen).toBe(false)
})

it('手动查其他词或词组时退出自动跟随', () => {
  useWordModalStore.setState({ followListen: true })
  useWordModalStore.getState().openWord('other', 'another context')
  expect(useWordModalStore.getState().followListen).toBe(false)
  useWordModalStore.setState({ followListen: true })
  useWordModalStore.getState().openPhrase('look up', 'look up a word')
  expect(useWordModalStore.getState().followListen).toBe(false)
})
