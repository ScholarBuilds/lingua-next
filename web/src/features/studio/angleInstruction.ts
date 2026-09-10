/* 机位参数 → 中文指令（模块 17 FR-475）。

   为什么这段逻辑留在前端：它是**拖动滑杆时的实时呈现**——手指按住不放的一秒里
   要重算几十次，每次都要立刻显示在提示词框里。而它本身只是「三个数 → 一句话」的
   确定性映射，没有任何提示词工程成分，服务端拿不出更好的版本。

   细节增强的强度档提示词正相反：那是提示词工程产物，要能版本化、能测、能随模型
   调，所以归服务端（`apiStudio.catalog()` 的 `enhance_presets`），前端一个字都不硬
   编码。两个工具页看着像，这一处的归属恰好相反。 */

export interface AnglePose {
  /** 水平机位：>0 相机向右转，<0 向左，单位度 */
  yaw: number
  /** 垂直机位：>0 俯视，<0 仰视，单位度 */
  pitch: number
  /** 相机距离；源页面以 4 为标准位，小于 4 特写、大于 4 广角 */
  distance: number
}

/** 距离换镜头。4 是源页面唯一中性点。 */
function lensOf(distance: number): string {
  if (distance > 4) return '广角镜头'
  if (distance < 4) return '特写镜头'
  return ''
}

/** 机位 → 源 `angle.html` 使用的中文指令；全中性时返回空字符串。 */
export function buildAngleInstruction(pose: AnglePose): string {
  const yaw = Math.round(pose.yaw)
  const pitch = Math.round(pose.pitch)
  const moves: string[] = []
  if (yaw !== 0) moves.push(`向${yaw > 0 ? '右' : '左'}旋转${Math.abs(yaw)}度`)
  if (pitch !== 0) moves.push(`${pitch > 0 ? '俯视' : '仰视'}${Math.abs(pitch)}度`)
  const lens = lensOf(pose.distance)
  let instruction = moves.length === 0 ? '' : `将相机${moves.join('，')}`
  if (lens !== '') instruction += `${instruction === '' ? '将相机' : '，'}使用${lens}`
  return instruction
}

/** 指令行的样子：整行以「将相机」或「保持原机位」开头，吃到行尾。
 *  不用 `$` + m 是为了避开 \r\n 的行尾歧义——直接吃掉除换行外的一切。 */
const INSTRUCTION_LINE = /^(?:将相机|保持原机位)[^\n]*/m

/** 把新指令写进提示词：**原位替换**已有的那一行，其余内容一个字不动。
 *
 *  用户在指令行前后写的补充（主体描述、禁止项、风格要求）是他自己的劳动，
 *  拖一下滑杆就被整框覆盖是最恼人的那种「智能」。 */
export function applyAngleInstruction(text: string, instruction: string): string {
  // 替换用函数形式，免得指令里出现 $& 之类被当成替换模式解释
  if (INSTRUCTION_LINE.test(text)) {
    return text
      .replace(INSTRUCTION_LINE, () => instruction)
      .replace(/^\n|\n$/g, '')
      .replace(/\n{3,}/g, '\n\n')
  }
  if (instruction === '') return text
  const kept = text.replace(/\s+$/, '')
  return kept === '' ? instruction : `${kept}\n${instruction}`
}
