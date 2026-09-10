import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PartnerStatus } from './avatarMotion'
import { createAvatarScene } from './avatarScene'

const mocks = vi.hoisted(() => ({ parse: vi.fn(), render: vi.fn(), dispose: vi.fn(), resize: vi.fn(), expression: vi.fn(), update: vi.fn() }))
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({ GLTFLoader: class { register() { return this } parseAsync = mocks.parse } }))
vi.mock('@pixiv/three-vrm', () => ({ VRMLoaderPlugin: class {}, VRMUtils: { rotateVRM0: vi.fn() } }))
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>()
  return { ...actual, WebGLRenderer: class {
    domElement = Object.assign(new EventTarget(), { setAttribute: vi.fn(), remove: vi.fn() })
    setPixelRatio = vi.fn()
    setSize = mocks.resize
    render = mocks.render
    dispose = mocks.dispose
    forceContextLoss = vi.fn()
  } }
})

let model: THREE.Group
let mesh: THREE.Mesh
let host: HTMLElement
let avatar: { humanoid: { getNormalizedBoneNode: (name: string) => THREE.Object3D | undefined }; expressionManager: { setValue: typeof mocks.expression }; update: typeof mocks.update }
let frameCallbacks: Map<number, FrameRequestCallback>
let state: { status: PartnerStatus; level: number; reducedMotion: boolean }

beforeEach(() => {
  vi.clearAllMocks()
  frameCallbacks = new Map()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frameCallbacks.set(++nextFrame, cb)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frameCallbacks.delete(id))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }))
  vi.stubGlobal('window', { devicePixelRatio: 3, setTimeout, clearTimeout })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('ImageBitmap', class {})
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ArrayBuffer(8))))
  model = new THREE.Group()
  const head = new THREE.Object3D()
  head.name = 'Head'
  head.position.y = 1.6
  model.add(head)
  mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
  mesh.morphTargetDictionary = { jawOpen: 0, eyeBlinkLeft: 1 }
  mesh.morphTargetInfluences = [0, 0]
  model.add(mesh)
  avatar = { humanoid: { getNormalizedBoneNode: (name) => name === 'head' ? head : undefined }, expressionManager: { setValue: mocks.expression }, update: mocks.update }
  mocks.parse.mockResolvedValue({ scene: model, userData: { vrm: avatar } })
  host = Object.assign(new EventTarget(), { clientWidth: 600, clientHeight: 480, appendChild: vi.fn() }) as unknown as HTMLElement
  state = { status: 'speaking', level: 1, reducedMotion: false }
})

afterEach(() => vi.unstubAllGlobals())

function draw() {
  const entry = [...frameCallbacks.entries()].at(-1)
  if (!entry) throw new Error('No scheduled frame')
  frameCallbacks.delete(entry[0])
  entry[1](performance.now() + 100)
}

describe('数字人渲染生命周期', () => {
  it('减少动态效果时关闭眨眼与呼吸，保留说话口型', async () => {
    state.reducedMotion = true
    const ready = vi.fn()
    const stop = createAvatarScene(host, () => state, ready, vi.fn())
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    draw()
    expect(mocks.expression).toHaveBeenCalledWith('blink', 0)
    expect(mocks.expression.mock.calls.find(([name]) => name === 'aa')?.[1]).toBeGreaterThan(0)
    expect(model.position.y).toBe(0)
    stop()
  })

  it('加载后使用播放电平；打断立即闭嘴，卸载释放图形资源', async () => {
    const ready = vi.fn()
    const error = vi.fn()
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose')
    const stop = createAvatarScene(host, () => state, ready, error)
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    draw()
    expect(mocks.expression.mock.calls.find(([name]) => name === 'aa')?.[1]).toBeGreaterThan(0)
    expect(mocks.update).toHaveBeenCalled()
    state.status = 'listening'
    // 下一帧须跨过 30fps 间隔。
    const entry = [...frameCallbacks.entries()].at(-1)!
    frameCallbacks.delete(entry[0])
    entry[1](performance.now() + 200)
    expect(mocks.expression.mock.calls.filter(([name]) => name === 'aa').at(-1)?.[1]).toBe(0)
    stop()
    stop()
    expect(geometryDispose).toHaveBeenCalledOnce()
    expect(mocks.dispose).toHaveBeenCalledOnce()
    expect(frameCallbacks.size).toBe(0)
    expect(error).not.toHaveBeenCalled()
  })

  it('载入失败只报告数字人错误并清理画布', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }))
    const ready = vi.fn()
    const error = vi.fn()
    const stop = createAvatarScene(host, () => state, ready, error)
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(ready).not.toHaveBeenCalled()
    expect(mocks.dispose).toHaveBeenCalledOnce()
    stop()
  })

  it('卸载后到达的模型只释放资源，不重新挂载或启动动画', async () => {
    let finish!: (value: { scene: THREE.Group }) => void
    mocks.parse.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const ready = vi.fn()
    const error = vi.fn()
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose')
    const stop = createAvatarScene(host, () => state, ready, error)
    await vi.waitFor(() => expect(mocks.parse).toHaveBeenCalledOnce())
    stop()
    finish({ scene: model })
    await vi.waitFor(() => expect(geometryDispose).toHaveBeenCalledOnce())
    expect(ready).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(frameCallbacks.size).toBe(0)
  })

  it('页面隐藏暂停帧循环，恢复后重新调度', async () => {
    const ready = vi.fn()
    const stop = createAvatarScene(host, () => state, ready, vi.fn())
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    Object.assign(document, { hidden: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frameCallbacks.size).toBe(0)
    Object.assign(document, { hidden: false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frameCallbacks.size).toBe(1)
    stop()
  })

  it('WebGL 上下文丢失后退出渲染，并允许界面重试', async () => {
    const ready = vi.fn()
    const error = vi.fn()
    const stop = createAvatarScene(host, () => state, ready, error)
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    const canvas = vi.mocked(host.appendChild).mock.calls[0][0]
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(error).toHaveBeenCalledOnce()
    expect(frameCallbacks.size).toBe(0)
    expect(mocks.dispose).toHaveBeenCalledOnce()
    stop()
  })

  it('普通 GLB 缺少 VRM 骨骼时返回明确的资源失败', async () => {
    mocks.parse.mockResolvedValue({ scene: model, userData: {} })
    const error = vi.fn()
    const ready = vi.fn()
    const stop = createAvatarScene(host, () => state, ready, error)
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(ready).not.toHaveBeenCalled()
    expect(mocks.dispose).toHaveBeenCalledOnce()
    stop()
  })
})
