/** 交付：把草稿另存成新文件，绝不覆盖既有文件。 */

import { basename, extname, join } from 'node:path'
import { DomainError } from './errors.js'

export type Delivery = {
  taskId: string
  name: string
  path: string
  size: number
  sha256: string
  createdAt: string
}

export type DeliveryTarget = { name: string; path: string }

/**
 * 交付目标命名：同名文件已存在就依次试 `(2)`、`(3)`…，绝不覆盖。
 * 「存在」由调用方注入，便于用真实 stat 或测试替身判断。
 */
export function pickDeliveryTarget(
  dir: string,
  sourceName: string,
  exists: (path: string) => boolean,
  maxTries = 99,
): DeliveryTarget {
  const ext = extname(sourceName)
  const stem = basename(sourceName, ext) === '' ? 'document' : basename(sourceName, ext)
  for (let n = 1; n <= maxTries; n += 1) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`
    const path = join(dir, name)
    if (!exists(path)) return { name, path }
  }
  throw new DomainError('deliver-failed', `目标目录里同名文件太多，请换一个目录：${dir}`)
}
