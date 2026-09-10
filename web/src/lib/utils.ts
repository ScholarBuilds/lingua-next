import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui 组件的类名合并工具 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
