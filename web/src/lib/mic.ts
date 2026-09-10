/* 取麦克风的统一入口。

   浏览器只在安全上下文（https 或 localhost）下挂载 navigator.mediaDevices，
   局域网 http://IP 访问时它是 undefined——直接取 .getUserMedia 抛的是 TypeError，
   各处的 catch 只认 DOMException，最后都提示成"检查设备与浏览器设置"，
   而设备和权限其实都没问题。先判断先说清，别让人白折腾。 */

export async function requireMic(
  constraints: MediaStreamConstraints = { audio: true },
): Promise<MediaStream> {
  if (!window.isSecureContext || navigator.mediaDevices === undefined) {
    throw new Error(
      `浏览器只在 https 或 localhost 下开放麦克风，当前是 ${location.origin}。` +
        '请改用 https 地址访问，或在本机 localhost 上使用。',
    )
  }
  return navigator.mediaDevices.getUserMedia(constraints)
}
