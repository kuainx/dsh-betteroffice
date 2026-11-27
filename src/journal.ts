import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
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
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
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

/** 用独占创建（'wx'）做锁：同一目标同时只允许一个替换事务。 */
export async function acquireLock(dir: string, target: string, now = new Date()): Promise<Lock> {
  await mkdir(dir, { recursive: true })
  const path = lockPath(dir, target)
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DomainError('commit-locked', `这个文件正在进行替换（锁文件：${path}），请等它结束再试。`)
    }
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, target, startedAt: now.toISOString() })}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  return { path, release: async () => await rm(path, { force: true }) }
}
