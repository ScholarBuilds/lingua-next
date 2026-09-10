/* 完成提示音（模块 17 · 蓝本对账 P2）。
 *
   出图动辄跑一两分钟，用户多半切走干别的了。跑完不出声，他要么一直守着、
   要么半小时后才想起来回来看。

   为什么不放音频文件：一个 mp3 要么走网络（首次播放延迟，而这一下正需要即时）、
   要么打进包里（几十 KB 换一声「叮」不划算）。WebAudio 现场合成两个正弦音，
   零字节、零延迟、音色可调。

   > [!warning] 自动播放策略
   >
   > 浏览器要求 AudioContext 由用户手势创建/恢复。任务是用户点「出图」发起的，
   > 那次点击已经解锁了音频，所以这里能出声；但**页面加载后从没交互过**的场合
   > （例如刷新页面后自动恢复的任务跑完）会被静默拦住。
   > 这属于浏览器规则，不做绕过——出声失败不该让调用方看到任何报错。 */

let ctx: AudioContext | null = null

/** 开关。存 localStorage，用户嫌吵可以永久关掉 */
const KEY = 'lingua.chime'

export function chimeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    // 隐私模式下 localStorage 可能抛异常。默认开着，别因为读不到设置就哑了
    return true
  }
}

export function setChimeEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // 存不下就算了，本次会话仍然按传入值走
  }
}

/** 出一声「叮」。失败静默——提示音出不来不该打断任何流程 */
export function chime(kind: 'done' | 'fail' = 'done'): void {
  if (!chimeEnabled()) return
  try {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (Ctor === undefined) return
    ctx ??= new Ctor()
    if (ctx.state === 'suspended') void ctx.resume()

    const now = ctx.currentTime
    // 成功是上行两音（C6→E6），失败是下行（E5→A4）——不看屏也听得出结果
    const notes = kind === 'done' ? [1046.5, 1318.5] : [659.3, 440]
    notes.forEach((hz, i) => {
      const osc = ctx!.createOscillator()
      const gain = ctx!.createGain()
      osc.type = 'sine'
      osc.frequency.value = hz
      const at = now + i * 0.11
      // 指数衰减而不是线性：线性收尾会有一声「咔」
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26)
      osc.connect(gain).connect(ctx!.destination)
      osc.start(at)
      osc.stop(at + 0.28)
    })
  } catch {
    // 上下文创建失败、被自动播放策略拦住等等，都不该冒泡
  }
}
