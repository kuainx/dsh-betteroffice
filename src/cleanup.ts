/** 工作文件夹清理：只有在「草稿已交付」或「用户放弃草稿」且目录里没有未登记文件时才删。 */

import { basename } from 'node:path'
import { LEDGER_FILE, type TaskLedger } from './workspace.js'

export type CleanupMode = 'off' | 'auto' | 'on'

export type CleanupDecision = { remove: boolean; reason: string }

function normalize(path: string): string {
  return path.split('\\').join('/')
}

function allowedFiles(ledger: TaskLedger): Set<string> {
  const allowed = new Set<string>([LEDGER_FILE])
  allowed.add(`draft/${basename(ledger.sourcePath)}`)
  for (const checkpoint of ledger.checkpoints ?? []) allowed.add(`checkpoints/${checkpoint.name}`)
  return allowed
}

export function cleanupDecision(opts: {
  mode: CleanupMode
  ledger: TaskLedger | undefined
  files: readonly string[]
  discard?: boolean
}): CleanupDecision {
  if (opts.mode === 'off') return { remove: false, reason: '已在设置里禁用工作文件夹清理' }
  if (opts.ledger === undefined) {
    return { remove: false, reason: '台账缺失，无法确认这个目录是插件创建的' }
  }
  const delivered = (opts.ledger.deliveries ?? []).length > 0
  if (!delivered && opts.discard !== true) {
    return { remove: false, reason: '还没有已验证的交付，保留草稿' }
  }
  const allowed = allowedFiles(opts.ledger)
  const unknown = opts.files.map(normalize).filter(file => !allowed.has(file))
  if (unknown.length > 0) {
    return { remove: false, reason: `有未登记的文件，保留目录：${unknown.slice(0, 3).join('、')}` }
  }
  return {
    remove: true,
    reason:
      opts.discard === true
        ? '用户放弃草稿，且目录里没有未登记的文件'
        : '草稿已交付且目录里没有未登记的文件',
  }
}

export async function cleanupWorkspace(opts: {
  mode: CleanupMode
  dir: string
  discard?: boolean
  readLedger: (dir: string) => Promise<TaskLedger | undefined>
  listFiles: (dir: string) => Promise<readonly string[]>
  removeDir: (dir: string) => Promise<void>
  logger?: (message: string, error?: unknown) => void
}): Promise<CleanupDecision> {
  const ledger = await opts.readLedger(opts.dir).catch(() => undefined)
  let files: readonly string[]
  try {
    files = await opts.listFiles(opts.dir)
  } catch (error) {
    opts.logger?.(`读不出目录内容，保留工作文件夹：${opts.dir}`, error)
    return { remove: false, reason: '无法读取目录内容' }
  }
  const decision = cleanupDecision({ mode: opts.mode, ledger, files, discard: opts.discard })
  if (!decision.remove) {
    opts.logger?.(`保留工作文件夹 ${opts.dir}：${decision.reason}`)
    return decision
  }
  try {
    await opts.removeDir(opts.dir)
  } catch (error) {
    opts.logger?.(`删除工作文件夹失败：${opts.dir}`, error)
  }
  return decision
}
