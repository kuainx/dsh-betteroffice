/** 工作文件夹名：`dsh-<原文件名含扩展名>-<YYMMDD-HHmmss>-<任务 id>`。 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Checkpoint } from './checkpoint.js'
import type { Delivery } from './deliver.js'
import { WorkspaceExistsError } from './errors.js'

export const WORKSPACE_PREFIX = 'dsh-'
/** 目录名上限（字节）。留余量给路径总长限制与同级目录。 */
export const MAX_NAME_BYTES = 200
export const LEDGER_FILE = '.betteroffice-task.json'

// oxlint-disable-next-line no-control-regex -- 文件名里必须剔掉控制字符，否则 exFAT/同步盘上会炸
const ILLEGAL_RUN = /[<>:"/\\|?*\u0000-\u001f]+/g

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** 本地时间的 `YYMMDD-HHmmss`。 */
export function formatStamp(at: Date): string {
  const date = `${pad(at.getFullYear() % 100, 2)}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}`
  const time = `${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`
  return `${date}-${time}`
}

function stripTrailingDotsAndSpaces(name: string): string {
  return name.replace(/[ .]+$/u, '')
}

/** 把 Windows 非法字符/控制字符的连续片段压成一个 `_`，并去掉尾随空格与点。 */
function sanitize(fileName: string): string {
  return stripTrailingDotsAndSpaces(fileName.replace(ILLEGAL_RUN, '_'))
}

function splitExt(name: string): [string, string] {
  const at = name.lastIndexOf('.')
  if (at <= 0 || at === name.length - 1) return [name, '']
  const ext = name.slice(at)
  if (ext.length > 12 || /[\\/]/u.test(ext)) return [name, '']
  return [name.slice(0, at), ext]
}

export function workspaceDirName(sourceFileName: string, taskId: string, at: Date): string {
  const suffix = `-${formatStamp(at)}-${taskId}`
  const budget = MAX_NAME_BYTES - Buffer.byteLength(WORKSPACE_PREFIX, 'utf8') - Buffer.byteLength(suffix, 'utf8')
  let name = sanitize(sourceFileName)
  if (Buffer.byteLength(name, 'utf8') > budget) {
    // 超长时只裁文件名主体，保住扩展名与 `-时间-任务id` 尾部：这两个是恢复时唯一的线索。
    const [stem, ext] = splitExt(name)
    const chars = [...stem]
    while (chars.length > 0 && Buffer.byteLength(chars.join('') + ext, 'utf8') > budget) chars.pop()
    name = stripTrailingDotsAndSpaces(chars.join('')) + ext
  }
  return `${WORKSPACE_PREFIX}${name}${suffix}`
}

/** 工作文件夹台账，跨会话/跨重启的恢复依据。 */
export type TaskLedger = {
  taskId: string
  sessionId: string
  sourcePath: string
  sourceHash: string
  mode: 'read' | 'edit'
  rootKind: 'parent' | 'temp' | 'workspace'
  workspaceDir: string | null
  createdAt: string
  status: 'open' | 'closed'
  mcpVersion: string
  /** 已验证落盘的检查点，按时间追加；失败候选绝不写进来。 */
  checkpoints?: Checkpoint[]
  /** 已成功另存出去的交付物。 */
  deliveries?: Delivery[]
}

export type WorkspaceDirs = {
  dir: string
  draftDir: string
  checkpointsDir: string
  ledgerPath: string
}

/**
 * 在源文件同级目录独占创建工作文件夹。已存在即失败——绝不接管、绝不复用别人的目录。
 */
export async function createWorkspace(opts: {
  sourcePath: string
  taskId: string
  at: Date
  ledger: TaskLedger
}): Promise<WorkspaceDirs> {
  const dir = join(dirname(opts.sourcePath), workspaceDirName(basename(opts.sourcePath), opts.taskId, opts.at))
  try {
    await mkdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceExistsError(dir)
    throw error
  }
  const draftDir = join(dir, 'draft')
  const checkpointsDir = join(dir, 'checkpoints')
  await mkdir(draftDir)
  await mkdir(checkpointsDir)
  const ledgerPath = join(dir, LEDGER_FILE)
  const record: TaskLedger = { ...opts.ledger, workspaceDir: dir }
  await writeFile(ledgerPath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' })
  return { dir, draftDir, checkpointsDir, ledgerPath }
}

export async function readLedger(dir: string): Promise<TaskLedger> {
  const path = join(dir, LEDGER_FILE)
  try {
    return JSON.parse(await readFile(path, 'utf8')) as TaskLedger
  } catch (error) {
    throw new Error(`台账缺失或损坏：${path}（${(error as Error).message}）`)
  }
}

/** 检查点落盘并验证之后才记账：台账里的 checkpoints 就是「可信最新版本」的清单。 */
export async function appendCheckpoint(dir: string, checkpoint: Checkpoint): Promise<TaskLedger> {
  return patchLedger(dir, (ledger) => ({
    ...ledger,
    checkpoints: [...(ledger.checkpoints ?? []), checkpoint],
  }))
}

/** 交付成功后记账，供清理与恢复判断「草稿是否已经交出去」。 */
export async function appendDelivery(dir: string, delivery: Delivery): Promise<TaskLedger> {
  return patchLedger(dir, (ledger) => ({
    ...ledger,
    deliveries: [...(ledger.deliveries ?? []), delivery],
  }))
}

async function patchLedger(dir: string, patch: (ledger: TaskLedger) => TaskLedger): Promise<TaskLedger> {
  const next = patch(await readLedger(dir))
  await writeFile(join(dir, LEDGER_FILE), JSON.stringify(next, null, 2), 'utf8')
  return next
}
