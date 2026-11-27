import { constants } from 'node:fs'
import { copyFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clearJournal, listJournals, type CommitRecord } from './journal.js'
import { sha256File } from './paths.js'

export type RecoveryAction = 'cleared' | 'restored' | 'kept'

export interface RecoveryOutcome {
  taskId: string
  action: RecoveryAction
  detail: string
}

export interface RecoveryDeps {
  home: string
  sha256?: (path: string) => Promise<string>
  copy?: (from: string, to: string) => Promise<void>
  remove?: (path: string) => Promise<void>
  logger?: (message: string) => void
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 启动时按事务日志收尾（DESIGN §5.2 步骤 4）：日志没清掉说明上次替换过程中进程没了。
 * 三种阶段各有确定答案，绝不猜：prepared 原件未动；recycled 用副本回滚；published 校验新文件。
 */
export async function recoverCommits(deps: RecoveryDeps): Promise<RecoveryOutcome[]> {
  const commitsDir = join(deps.home, 'betteroffice', 'commits')
  const records = await listJournals(commitsDir)
  const outcomes: RecoveryOutcome[] = []
  for (const record of records) {
    outcomes.push(await recoverOne(record, deps, commitsDir))
  }
  return outcomes
}

async function recoverOne(record: CommitRecord, deps: RecoveryDeps, commitsDir: string): Promise<RecoveryOutcome> {
  const sha256 = deps.sha256 ?? sha256File
  const copy = deps.copy ?? ((from: string, to: string) => copyFile(from, to, constants.COPYFILE_EXCL))
  const remove = deps.remove ?? (async (path: string) => await rm(path, { force: true }))
  const hasBackup = await exists(record.backupPath)

  if (record.phase === 'prepared') {
    await clearJournal(commitsDir, record.taskId)
    if (hasBackup) await remove(record.backupPath)
    deps.logger?.(`betteroffice: ${record.taskId} 上次替换未开始动原件，已清理日志`)
    return { taskId: record.taskId, action: 'cleared', detail: '原件未受影响' }
  }

  if (record.phase === 'recycled') {
    if (!hasBackup) {
      return {
        taskId: record.taskId,
        action: 'kept',
        detail: `恢复副本丢失，原件可能还在回收站：${record.originalPath}。日志保留供人工处理。`,
      }
    }
    if (!(await exists(record.originalPath))) {
      await copy(record.backupPath, record.originalPath)
      deps.logger?.(`betteroffice: ${record.taskId} 已用副本还原 ${record.originalPath}`)
      await clearJournal(commitsDir, record.taskId)
      await remove(record.backupPath)
      return { taskId: record.taskId, action: 'restored', detail: `已还原 ${record.originalPath}` }
    }
    await clearJournal(commitsDir, record.taskId)
    await remove(record.backupPath)
    return { taskId: record.taskId, action: 'cleared', detail: '原件已存在，无需还原' }
  }

  // published：新文件应当已就位，校验通过才算成功
  const current = await sha256(record.originalPath).catch(() => undefined)
  if (current !== undefined && record.candidateSha256 !== null && current === record.candidateSha256) {
    await clearJournal(commitsDir, record.taskId)
    if (hasBackup) await remove(record.backupPath)
    return { taskId: record.taskId, action: 'cleared', detail: '新文件已就位并通过校验' }
  }
  if (!hasBackup) {
    return {
      taskId: record.taskId,
      action: 'kept',
      detail: `新文件校验失败且恢复副本丢失：${record.originalPath}。日志保留供人工处理。`,
    }
  }
  await remove(record.originalPath).catch(() => undefined)
  await copy(record.backupPath, record.originalPath)
  await clearJournal(commitsDir, record.taskId)
  await remove(record.backupPath)
  deps.logger?.(`betteroffice: ${record.taskId} 新文件校验失败，已用副本还原原件`)
  return { taskId: record.taskId, action: 'restored', detail: `已还原 ${record.originalPath}` }
}
