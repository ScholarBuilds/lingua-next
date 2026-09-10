import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

import { blinkAmount, mouthOpening } from './avatarMotion'
import type { PartnerStatus } from './avatarMotion'

interface AvatarState {
  status: PartnerStatus
  level: number
  reducedMotion: boolean
  brightness?: number
}

function disposeModel(model: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>()
  const materials = new Set<THREE.Material>()
  model.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    node.geometry.dispose()
    if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose()
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material)
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value)
      }
    }
  })
  for (const texture of textures) {
    texture.dispose()
    if (texture.image instanceof ImageBitmap) texture.image.close()
  }
  for (const material of materials) material.dispose()
}

export function createAvatarScene(
  host: HTMLElement,
  readState: () => AvatarState,
  onReady: () => void,
  onError: () => void,
): () => void {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  host.appendChild(canvas)

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb6bdca, 1))
  const key = new THREE.DirectionalLight(0xffffff, 0.9)
  key.position.set(-2, 3, 4)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xdcecff, 0.25)
  fill.position.set(2, 2, 1)
  scene.add(fill)
  const rim = new THREE.DirectionalLight(0xffffff, 0.6)
  rim.position.set(0, 3, -2)
  scene.add(rim)

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 20)
  const target = new THREE.Vector3(0, 1.4, 0)
  let model: THREE.Object3D | null = null
  let avatar: VRM | undefined
  let head: THREE.Object3D | undefined
  let headRest = new THREE.Quaternion()
  const headTurn = new THREE.Quaternion()
  const headEuler = new THREE.Euler()
  const gaze = new THREE.Object3D()
  const pointer = new THREE.Vector2()
  const pointerMove = (event: PointerEvent) => {
    const bounds = host.getBoundingClientRect()
    pointer.set(
      THREE.MathUtils.clamp((event.clientX - bounds.left) / bounds.width * 2 - 1, -1, 1),
      THREE.MathUtils.clamp(1 - (event.clientY - bounds.top) / bounds.height * 2, -1, 1),
    )
  }
  const pointerLeave = () => pointer.set(0, 0)
  host.addEventListener('pointermove', pointerMove)
  host.addEventListener('pointerleave', pointerLeave)
  let disposed = false
  let frame = 0
  let lastFrame = 0
  let elapsed = 1
  let jaw = 0
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 20_000)

  const resize = () => {
    const w = Math.max(1, host.clientWidth)
    const h = Math.max(1, host.clientHeight)
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.position.set(target.x, target.y + 0.02, Math.max(1.5, 0.85 / camera.aspect))
    camera.lookAt(target)
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()

  const draw = (now: number) => {
    if (disposed || document.hidden) return
    frame = requestAnimationFrame(draw)
    if (now - lastFrame < 1000 / 30) return
    const dt = Math.min(0.1, (now - lastFrame) / 1000)
    lastFrame = now
    elapsed += dt
    const state = readState()
    jaw = mouthOpening(jaw, state.level, state.status, dt)
    const brightness = Math.min(1, Math.max(0, state.brightness ?? 0.5))
    const expressions = avatar?.expressionManager
    expressions?.setValue('aa', jaw * (1 - Math.abs(brightness - 0.5)))
    expressions?.setValue('ih', jaw * brightness * 0.45)
    expressions?.setValue('ou', jaw * (1 - brightness) * 0.55)
    const blink = state.reducedMotion ? 0 : blinkAmount(elapsed)
    expressions?.setValue('blink', blink)
    expressions?.setValue('happy', state.status === 'listening' ? 0.12 : 0.025)
    expressions?.setValue('relaxed', state.status === 'thinking' ? 0.12 : 0.025)
    if (head) {
      const motion = state.reducedMotion ? 0 : 1
      headEuler.set(
        (Math.sin(elapsed * 1.3) * 0.015 - pointer.y * 0.025) * motion,
        (Math.sin(elapsed * 0.55) * 0.025 + pointer.x * 0.045) * motion,
        (state.status === 'thinking' ? -0.045 : 0.015) * motion,
      )
      headTurn.setFromEuler(headEuler).premultiply(headRest)
      head.quaternion.slerp(headTurn, 1 - Math.exp(-8 * dt))
    }
    gaze.position.copy(camera.position)
    if (!state.reducedMotion) {
      gaze.position.x += pointer.x * 0.25
      gaze.position.y += pointer.y * 0.15
    }
    if (model) model.position.y = state.reducedMotion ? 0 : Math.sin(elapsed * 1.7) * 0.002
    avatar?.update(dt)
    renderer.render(scene, camera)
  }
  const visibility = () => {
    cancelAnimationFrame(frame)
    if (!document.hidden && model && !disposed) {
      lastFrame = performance.now()
      frame = requestAnimationFrame(draw)
    }
  }
  document.addEventListener('visibilitychange', visibility)

  const dispose = () => {
    if (disposed) return
    disposed = true
    controller.abort()
    clearTimeout(timeout)
    cancelAnimationFrame(frame)
    observer.disconnect()
    document.removeEventListener('visibilitychange', visibility)
    host.removeEventListener('pointermove', pointerMove)
    host.removeEventListener('pointerleave', pointerLeave)
    canvas.removeEventListener('webglcontextlost', contextLost)
    if (model) disposeModel(model)
    renderer.dispose()
    renderer.forceContextLoss()
    canvas.remove()
  }
  const contextLost = (event: Event) => {
    event.preventDefault()
    dispose()
    onError()
  }
  canvas.addEventListener('webglcontextlost', contextLost)

  void (async () => {
    const response = await fetch('/avatars/partner.vrm', { signal: controller.signal })
    if (!response.ok) throw new Error(`Avatar HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    if (disposed) return
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    const gltf = await loader.parseAsync(bytes, '/avatars/')
    if (disposed) {
      disposeModel(gltf.scene)
      return
    }
    model = gltf.scene
    avatar = gltf.userData.vrm as VRM | undefined
    if (!avatar) throw new Error('Model has no VRM humanoid')
    VRMUtils.rotateVRM0(avatar)
    for (const [bone, angle] of [['leftUpperArm', 1.25], ['rightUpperArm', -1.25]] as const) {
      const arm = avatar.humanoid.getNormalizedBoneNode(bone)
      if (arm) arm.rotation.z = angle
    }
    avatar.update(0)
    model.updateMatrixWorld(true)
    head = avatar.humanoid.getNormalizedBoneNode('head') ?? undefined
    if (head) {
      headRest = head.quaternion.clone()
      head.getWorldPosition(target)
      target.y -= 0.18
    }
    if (avatar.lookAt) avatar.lookAt.target = gaze
    scene.add(model)
    resize()
    gaze.position.copy(camera.position)
    renderer.render(scene, camera)
    clearTimeout(timeout)
    onReady()
    visibility()
  })().catch(() => {
    if (!disposed) {
      dispose()
      onError()
    }
  })

  return dispose
}
