import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DomainError } from './errors.js'

/**
 * 替换事务的阶段。任何一步崩溃后，恢复逻辑都靠这三个阶段判断"原件还在不在"：
 * prepared = 原件未动；recycled = 原件已进回收站、副本可用；published = 新文件已就位待校验。
 */
export type CommitPhase = 'prepared' | 'recycled' | 'published'

export interface CommitRecord {
  version: 1
  taskId: string
  phase: CommitPhase
  originalPath: string
  originalSha256: string
  backupPath: string
  backupSha256: string
  candidatePath: string | null
  candidateSha256: string | null
  startedAt: string
  updatedAt: string
}

export interface Lock {
  path: string
  release(): Promise<void>
}

const PHASES: readonly string[] = ['prepared', 'recycled', 'published']

export function journalPath(dir: string, taskId: string): string {
  return join(dir, `${taskId}.json`)
}

function parse(text: string): CommitRecord | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Partial<CommitRecord>
    if (record.version !== 1) return undefined
    if (typeof record.taskId !== 'string' || record.taskId === '') return undefined
    if (typeof record.phase !== 'string' || !PHASES.includes(record.phase)) return undefined
    if (typeof record.originalPath !== 'string' || typeof record.backupPath !== 'string') return undefined
    return record as CommitRecord
  } catch {
    return undefined
  }
}

export async function writeJournal(dir: string, record: CommitRecord): Promise<void> {
  await mkdir(dir, { recursive: true })
  const target = journalPath(dir, record.taskId)
  const tmp = `${target}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
    // 断电时日志可能还没落盘；同步一次再改名，保证启动恢复看得到现场。
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, target)
}

export async function readJournal(dir: string, taskId: string): Promise<CommitRecord | undefined> {
  try {
    return parse(await readFile(journalPath(dir, taskId), 'utf8'))
  } catch {
    return undefined
  }
}

export async function clearJournal(dir: string, taskId: string): Promise<void> {
  await rm(journalPath(dir, taskId), { force: true })
}

export async function listJournals(dir: string): Promise<CommitRecord[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const records: CommitRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const record = await readJournal(dir, name.slice(0, -'.json'.length))
    if (record !== undefined) records.push(record)
  }
  return records.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
}

export function lockPath(dir: string, target: string): string {
  const digest = createHash('sha1').update(target).digest('hex').slice(0, 16)
  return join(dir, `${digest}.lock`)
}

/** 用独占创建（'wx'）做锁：同一目标同时只允许一个替换事务。上次进程已死留下的锁会被接管一次。 */
export async function acquireLock(dir: string, target: string, now = new Date()): Promise<Lock> {
  await mkdir(dir, { recursive: true })
  const path = lockPath(dir, target)
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await isStaleLock(path))) {
      throw new DomainError('commit-locked', `这个文件正在进行替换（锁文件：${path}），请等它结束再试。`)
    }
    await rm(path, { force: true })
    try {
      handle = await open(path, 'wx')
    } catch {
      throw new DomainError('commit-locked', `这个文件正在进行替换（锁文件：${path}），请等它结束再试。`)
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, target, startedAt: now.toISOString() })}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  return { path, release: async () => await rm(path, { force: true }) }
}

/** 锁里记着 pid：进程已经不在了就认为锁是陈旧的。读不出内容时按"不陈旧"处理，宁可多等一次。 */
async function isStaleLock(path: string): Promise<boolean> {
  let pid: number
  try {
    const text = await readFile(path, 'utf8')
    const value = JSON.parse(text) as { pid?: unknown }
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return false
    pid = value.pid
  } catch {
    return false
  }
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
