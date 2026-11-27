import { constants } from 'node:fs'
import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DomainError } from './errors.js'
import {
  acquireLock,
  clearJournal,
  writeJournal,
  type CommitRecord,
} from './journal.js'
import { sha256File } from './paths.js'

export interface ReplaceDeps {
  home: string
  platform?: NodeJS.Platform
  recycle: (path: string) => Promise<void>
  sha256?: (path: string) => Promise<string>
  link?: (from: string, to: string) => Promise<void>
  copy?: (from: string, to: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  remove?: (path: string) => Promise<void>
  statSize?: (path: string) => Promise<number>
  now?: () => Date
}

export interface ReplaceInput {
  taskId: string
  sourcePath: string
  candidatePath: string
  /** 打开文档时记下的源文件哈希；不符说明源文件在编辑期间被换过。 */
  expectedSourceSha256?: string
}

export interface ReplaceResult {
  path: string
  sha256: string
  bytes: number
  recycled: true
  backupPath: string
}

export interface ReplacePaths {
  commitsDir: string
  backupsDir: string
}

export function replacePaths(home: string): ReplacePaths {
  return {
    commitsDir: join(home, 'betteroffice', 'commits'),
    backupsDir: join(home, 'betteroffice', 'backups'),
  }
}

/**
 * DESIGN §5.2 的替换事务：备份 → 日志 → 回收原件 → 硬链接发布（EEXIST 即失败，绝不做"看起来空着"的判断）→ 校验 → 收尾。
 * 任一步失败都从备份恢复原件；恢复不了的错误里写明备份路径。
 */
export async function replaceOriginal(input: ReplaceInput, deps: ReplaceDeps): Promise<ReplaceResult> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    throw new DomainError('recycle-unavailable', `这个平台（${platform}）没有可用的回收站，只能另存为新文件。`)
  }

  const sha256 = deps.sha256 ?? sha256File
  const copy = deps.copy ?? ((from: string, to: string) => copyFile(from, to, constants.COPYFILE_EXCL))
  const publish = deps.link ?? ((from: string, to: string) => link(from, to))
  const remove = deps.remove ?? (async (path: string) => await rm(path, { force: true }))
  const statSize = deps.statSize ?? (async (path: string) => (await stat(path)).size)
  const now = deps.now ?? (() => new Date())
  const { commitsDir, backupsDir } = replacePaths(deps.home)

  await mkdir(commitsDir, { recursive: true })
  await mkdir(backupsDir, { recursive: true })
  const lock = await acquireLock(commitsDir, input.sourcePath, now())

  const record: CommitRecord = {
    version: 1,
    taskId: input.taskId,
    phase: 'prepared',
    originalPath: input.sourcePath,
    originalSha256: '',
    backupPath: join(backupsDir, `${input.taskId}${extname(input.sourcePath) || '.docx'}`),
    backupSha256: '',
    candidatePath: input.candidatePath,
    candidateSha256: null,
    startedAt: now().toISOString(),
    updatedAt: now().toISOString(),
  }

  try {
    record.originalSha256 = await sha256(input.sourcePath).catch((error: unknown) => {
      throw new DomainError('source-changed', `读不到源文件（${basename(input.sourcePath)}）：${describe(error)}`)
    })
    if (input.expectedSourceSha256 !== undefined && record.originalSha256 !== input.expectedSourceSha256) {
      throw new DomainError(
        'source-changed',
        '源文件在打开后被改动（哈希不一致），为免覆盖别人的修改，这次不替换。请重新打开文档再试。',
      )
    }
    record.candidateSha256 = await sha256(input.candidatePath)
    // 无论内容是否相同都留恢复副本，绝不因为"看起来一样"跳过
    await copy(input.sourcePath, record.backupPath)
    record.backupSha256 = await sha256(record.backupPath)
    if (record.backupSha256 !== record.originalSha256) {
      await remove(record.backupPath)
      throw new DomainError('backup-failed', '恢复副本校验失败，已放弃这次替换，原件未改动。')
    }

    await writeJournal(commitsDir, record)

    await deps.recycle(input.sourcePath)
    record.phase = 'recycled'
    record.updatedAt = now().toISOString()
    await writeJournal(commitsDir, record)

    await publish(input.candidatePath, input.sourcePath).catch(async (error: unknown) => {
      await restore(record, deps, copy)
      throw new DomainError('publish-failed', `发布新文件失败（不会覆盖已存在的文件）：${describe(error)}`)
    })

    const published = await sha256(input.sourcePath)
    if (record.candidateSha256 !== null && published !== record.candidateSha256) {
      await restore(record, deps, copy)
      throw new DomainError('publish-failed', '发布后校验失败，已用恢复副本还原原件。')
    }

    record.phase = 'published'
    record.updatedAt = now().toISOString()
    await writeJournal(commitsDir, record)

    await remove(input.candidatePath)
    const bytes = await statSize(input.sourcePath)
    await clearJournal(commitsDir, record.taskId)
    await remove(record.backupPath)
    return {
      path: input.sourcePath,
      sha256: published,
      bytes,
      recycled: true,
      backupPath: record.backupPath,
    }
  } catch (error) {
    await clearJournal(commitsDir, record.taskId).catch(() => undefined)
    throw error
  } finally {
    await lock.release().catch(() => undefined)
  }
}

/** 失败路径：把备份复制回原路径（不是移动，备份留着直到确认成功）。 */
async function restore(record: CommitRecord, deps: ReplaceDeps, copy: (from: string, to: string) => Promise<void>): Promise<void> {
  const remove = deps.remove ?? (async (path: string) => await rm(path, { force: true }))
  await remove(record.originalPath).catch(() => undefined)
  try {
    await copy(record.backupPath, record.originalPath)
  } catch (error) {
    throw new DomainError(
      'restore-failed',
      `替换失败且自动还原也失败。原件副本在：${record.backupPath}（把它复制回 ${record.originalPath} 即可）。原因：${describe(error)}`,
    )
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
