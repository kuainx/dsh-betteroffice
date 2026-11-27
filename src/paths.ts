/** 把 agent 给的路径变成可验证的身份：绝对路径 + 真实路径 + 大小 + 哈希。 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { DomainError } from './errors.js'

export type DocExt = '.docx' | '.xlsx' | '.pptx'

const SUPPORTED = new Set<string>(['.docx', '.xlsx', '.pptx'])

export type ResolvedDoc = {
  absPath: string
  realPath: string
  dir: string
  name: string
  ext: DocExt
  size: number
  sha256: string
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function resolveDocumentPath(input: string, cwd: string): Promise<ResolvedDoc> {
  const absPath = resolve(cwd, input)
  let info
  try {
    info = await stat(absPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DomainError('not-found', `找不到文件：${absPath}`)
    }
    throw error
  }
  if (!info.isFile()) throw new DomainError('not-a-file', `不是文件：${absPath}`)
  const ext = extname(absPath).toLowerCase()
  if (!SUPPORTED.has(ext)) {
    throw new DomainError('unsupported-format', `只支持 .docx / .xlsx / .pptx：${absPath}`)
  }
  // 真实路径与规范化路径不一致 = 中间环节有符号链接/目录联接，身份无法证明，拒绝。
  const realPath = await realpath(absPath)
  if (!samePath(realPath, absPath)) {
    throw new DomainError('path-redirected', `路径经链接指向别处，拒绝处理：${absPath} -> ${realPath}`)
  }
  const sha256 = await sha256File(absPath)
  return {
    absPath,
    realPath,
    dir: dirname(absPath),
    name: basename(absPath),
    ext: ext as DocExt,
    size: info.size,
    sha256,
  }
}
