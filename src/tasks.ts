/** 任务注册表：一个任务 = 一个文档身份 + 一个 MCP 实例，绑定到发起打开的会话。 */

import { rm } from 'node:fs/promises'
import type { ConfigData } from './config.js'
import { DomainError } from './errors.js'
import type { MountHandle, MountSpec } from './mount.js'
import type { ResolvedDoc } from './paths.js'
import { planRoot, type RootKind, type RootPlan } from './root.js'

export type OpenInput = { path: string; cwd: string; mode?: 'read' | 'edit'; workspace?: boolean }

export type TaskRecord = {
  taskId: string
  sessionId: string
  serverName: string
  doc: ResolvedDoc
  root: string
  rootKind: RootKind
  readOnly: boolean
  workspaceDir: string | null
  createdAt: Date
}

type Entry = { record: TaskRecord; handle: MountHandle; tempDir: string | null }

export type TaskRegistryDeps = {
  mounter: { mount(scope: unknown, spec: MountSpec): Promise<MountHandle> }
  resolveRuntime: () => { command: string; cliPath: string }
  config: () => ConfigData
  makeTempDir: () => Promise<string>
  now: () => Date
  newTaskId: () => string
  resolveDocument: (path: string, cwd: string) => Promise<ResolvedDoc>
  logger?: (message: string, error?: unknown) => void
}

export type TaskRegistry = {
  open(scope: unknown, sessionId: string, input: OpenInput): Promise<TaskRecord>
  close(scope: unknown, sessionId: string, taskId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  get(sessionId: string, taskId: string): TaskRecord
  list(sessionId: string): TaskRecord[]
}

export function createTaskRegistry(deps: TaskRegistryDeps): TaskRegistry {
  const entries = new Map<string, Entry>()

  function lookup(sessionId: string, taskId: string): Entry {
    const entry = entries.get(taskId)
    if (entry === undefined) throw new DomainError('task-not-found', `任务不存在或已关闭：${taskId}`)
    if (entry.record.sessionId !== sessionId) {
      throw new DomainError('task-foreign', `任务 ${taskId} 属于别的会话，不能操作`)
    }
    return entry
  }

  async function disposeEntry(entry: Entry): Promise<void> {
    entries.delete(entry.record.taskId)
    try {
      await entry.handle.dispose()
    } catch (error) {
      deps.logger?.(`关闭 ${entry.record.serverName} 时出错`, error)
    }
    if (entry.tempDir !== null) {
      await rm(entry.tempDir, { recursive: true, force: true }).catch((error: unknown) => {
        deps.logger?.(`清理临时目录失败：${entry.tempDir}`, error)
      })
    }
  }

  return {
    async open(scope, sessionId, input) {
      const mode = input.mode ?? 'read'
      const doc = await deps.resolveDocument(input.path, input.cwd)
      const config = deps.config()
      const taskId = deps.newTaskId()
      const serverName = `bo_${taskId}`

      // shortcut: 这里复刻了 planRoot 的 workspace 判定，只为避免白建临时目录；阶段 2 接入
      // 工作文件夹创建后改成先建目录再 planRoot，届时删掉这段判断。
      const wantsWorkspace =
        mode === 'edit' &&
        (config.workspaceMode === 'always' || (config.workspaceMode === 'auto' && input.workspace === true))

      let tempDir: string | null = null
      if (mode === 'edit' && !wantsWorkspace) tempDir = await deps.makeTempDir()

      let plan: RootPlan
      try {
        plan = planRoot({
          doc,
          mode,
          config,
          tempDir: tempDir ?? '',
          workspaceDir: null,
          workspaceRequested: input.workspace,
        })
      } catch (error) {
        if (tempDir !== null) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }

      const runtime = deps.resolveRuntime()
      let handle: MountHandle
      try {
        handle = await deps.mounter.mount(scope, {
          serverName,
          command: runtime.command,
          args: [runtime.cliPath, ...plan.args],
          cwd: plan.root,
        })
      } catch (error) {
        if (tempDir !== null) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }

      const record: TaskRecord = {
        taskId,
        sessionId,
        serverName,
        doc,
        root: plan.root,
        rootKind: plan.rootKind,
        readOnly: plan.readOnly,
        workspaceDir: plan.rootKind === 'workspace' ? plan.root : null,
        createdAt: deps.now(),
      }
      entries.set(taskId, { record, handle, tempDir })
      return record
    },

    async close(_scope, sessionId, taskId) {
      await disposeEntry(lookup(sessionId, taskId))
    },

    async closeSession(sessionId) {
      const owned = [...entries.values()].filter((entry) => entry.record.sessionId === sessionId)
      for (const entry of owned) await disposeEntry(entry)
    },

    get(sessionId, taskId) {
      return lookup(sessionId, taskId).record
    },

    list(sessionId) {
      return [...entries.values()]
        .filter((entry) => entry.record.sessionId === sessionId)
        .map((entry) => entry.record)
    },
  }
}
