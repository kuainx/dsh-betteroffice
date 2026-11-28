import { join, relative as relativePath } from 'node:path'
import { DomainError } from './errors.js'
import { formatStamp } from './workspace.js'

/**
 * 检查点文件名：`<源文件主名>-<YYMMDD-HHmmss>-v<版本>.<扩展名>`。
 * 带版本号是为了永远不覆盖已有检查点；时间戳让同一任务的多轮检查点可排序。
 */
export function checkpointName(sourceName: string, at: Date, version: number): string {
  const dot = sourceName.lastIndexOf('.')
  const rawStem = dot > 0 ? sourceName.slice(0, dot) : sourceName
  const ext = dot > 0 ? sourceName.slice(dot) : ''
  const stem = rawStem.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/[. ]+$/, '')
  return `${stem === '' ? 'document' : stem}-${formatStamp(at)}-v${version}${ext}`
}

export type CheckpointDeps = {
  /** checkpoints/ 目录的绝对路径 */
  dir: string
  /** MCP 的 root，导出路径要相对它 */
  root: string
  serverName: string
  documentId: string
  sourceName: string
  now: () => Date
  exists: (path: string) => boolean
  mkdir: (path: string) => Promise<void>
  stat: (path: string) => Promise<{ size: number }>
  sha256: (path: string) => Promise<string>
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

export type Checkpoint = { name: string; path: string; size: number; sha256: string; createdAt: string }

export async function createCheckpoint(deps: CheckpointDeps): Promise<Checkpoint> {
  try {
    await deps.mkdir(deps.dir)
  } catch (error) {
    throw new DomainError('checkpoint-failed', `无法创建检查点目录：${deps.dir}（${String(error)}）`)
  }

  // 一次检查点只取一次时间：文件名里的时间戳与 createdAt 必须是同一刻。
  const at = deps.now()
  for (let version = 1; version <= 999; version += 1) {
    const name = checkpointName(deps.sourceName, at, version)
    const path = join(deps.dir, name)
    if (deps.exists(path)) continue
    const relPath = relativePath(deps.root, path).replaceAll('\\', '/')
    try {
      await deps.invoke('office_export', {
        document: deps.documentId,
        path: relPath,
      })
    } catch (error) {
      throw new DomainError('checkpoint-failed', `保存检查点失败：${relPath}（${String(error)}）`)
    }
    let size: number
    try {
      size = (await deps.stat(path)).size
    } catch {
      throw new DomainError('checkpoint-failed', `导出后没有找到检查点文件：${path}`)
    }
    return {
      name,
      path,
      size,
      sha256: await deps.sha256(path),
      createdAt: at.toISOString(),
    }
  }
  throw new DomainError('checkpoint-failed', `检查点版本号冲突过多：${deps.dir}`)
}
