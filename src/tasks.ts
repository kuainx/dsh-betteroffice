/** 任务注册表：一个任务 = 一个文档身份 + 一个 MCP 实例，绑定到发起打开的会话。 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createCheckpoint, type Checkpoint } from './checkpoint.js'
import type { ConfigData } from './config.js'
import { DomainError } from './errors.js'
import { createToolInvoker, readToolJson, waitForTool, type ToolView } from './invoke.js'
import type { MountHandle, MountSpec } from './mount.js'
import { sha256File, type ResolvedDoc } from './paths.js'
import { planRoot, type RootKind, type RootPlan } from './root.js'
import { appendCheckpoint, createWorkspace, type TaskLedger } from './workspace.js'

export type OpenInput = { path: string; cwd: string; mode?: 'read' | 'edit'; workspace?: boolean }

export type TaskRecord = {
  taskId: string
  sessionId: string
  serverName: string
  doc: ResolvedDoc
  documentId: string
  openedPath: string
  root: string
  rootKind: RootKind
  readOnly: boolean
  workspaceDir: string | null
  createdAt: Date
}

type Entry = { record: TaskRecord; handle: MountHandle; tempDir: string | null; scope: unknown }

export type TaskRegistryDeps = {
  mounter: { mount(scope: unknown, spec: MountSpec): Promise<MountHandle> }
  resolveRuntime: () => { command: string; cliPath: string }
  config: () => ConfigData
  makeTempDir: () => Promise<string>
  now: () => Date
  newTaskId: () => string
  resolveDocument: (path: string, cwd: string) => Promise<ResolvedDoc>
  toolViewFor?: (scope: unknown) => ToolView | undefined
  copyFile?: (from: string, to: string) => Promise<void>
  createWorkspaceDir?: typeof createWorkspace
  waitToolTimeoutMs?: number
  logger?: (message: string, error?: unknown) => void
}

export type TaskRegistry = {
  open(scope: unknown, sessionId: string, input: OpenInput): Promise<TaskRecord>
  checkpoint(sessionId: string, taskId: string): Promise<Checkpoint>
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

  async function openInMcp(
    scope: unknown,
    serverName: string,
    root: string,
    openedPath: string,
    rollback: () => Promise<void>,
  ): Promise<string> {
    const tools = deps.toolViewFor?.(scope)
    if (tools === undefined) return ''
    const toolName = `mcp__${serverName}__office_open`
    try {
      await waitForTool(tools, scope, toolName, { timeoutMs: deps.waitToolTimeoutMs ?? 15_000 })
      const result = await createToolInvoker(tools, scope).invoke(toolName, { path: relative(root, openedPath) })
      const payload = readToolJson(result) as { document?: unknown } | undefined
      if (typeof payload?.document !== 'string' || payload.document === '') {
        throw new DomainError(
          'open-failed',
          `文档已挂载，但 BetterOffice 没有返回文档 id：${JSON.stringify(payload ?? result)}`,
        )
      }
      return payload.document
    } catch (error) {
      await rollback()
      throw error
    }
  }

  return {
    async open(scope, sessionId, input) {
      const mode = input.mode ?? 'read'
      const doc = await deps.resolveDocument(input.path, input.cwd)
      const config = deps.config()
      const taskId = deps.newTaskId()
      const serverName = `bo_${taskId}`
      const at = deps.now()
      const wantsWorkspace =
        mode === 'edit' &&
        (config.workspaceMode === 'always' || (config.workspaceMode === 'auto' && input.workspace === true))

      let tempDir: string | null = null
      let workspaceDir: string | null = null
      if (wantsWorkspace) {
        const ledger: TaskLedger = {
          taskId,
          sessionId,
          sourcePath: doc.absPath,
          sourceHash: doc.sha256,
          mode,
          rootKind: 'workspace',
          workspaceDir: null,
          createdAt: at.toISOString(),
          status: 'open',
          mcpVersion: config.runtimeVersion,
        }
        const makeWorkspace = deps.createWorkspaceDir ?? createWorkspace
        workspaceDir = (await makeWorkspace({ sourcePath: doc.absPath, taskId, at, ledger })).dir
      } else if (mode === 'edit') {
        tempDir = await deps.makeTempDir()
      }

      let plan: RootPlan
      try {
        plan = planRoot({
          doc,
          mode,
          config,
          tempDir: tempDir ?? '',
          workspaceDir,
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

      const rollback = async (): Promise<void> => {
        await handle.dispose().catch((error: unknown) => {
          deps.logger?.(`回滚 ${serverName} 时出错`, error)
        })
        if (tempDir !== null) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
        // 工作文件夹是本次独占创建的，回滚时删掉，免得留下空目录。
        if (workspaceDir !== null) await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined)
      }

      // 编辑副本：把源文件复制进临时目录，之后一律只动副本。
      let openedPath = doc.absPath
      if (plan.rootKind === 'temp') {
        openedPath = join(plan.root, doc.name)
        try {
          await (deps.copyFile ?? copyFile)(doc.absPath, openedPath)
        } catch (error) {
          await rollback()
          throw new DomainError('copy-failed', `复制文档到临时目录失败：${openedPath}（${String(error)}）`)
        }
      }

      const documentId = await openInMcp(scope, serverName, plan.root, openedPath, rollback)

      const record: TaskRecord = {
        taskId,
        sessionId,
        serverName,
        doc,
        documentId,
        openedPath,
        root: plan.root,
        rootKind: plan.rootKind,
        readOnly: plan.readOnly,
        workspaceDir: plan.rootKind === 'workspace' ? plan.root : null,
        createdAt: deps.now(),
      }
      entries.set(taskId, { record, handle, tempDir, scope })
      return record
    },

    async checkpoint(sessionId, taskId) {
      const entry = lookup(sessionId, taskId)
      const { record } = entry
      const tools = deps.toolViewFor?.(entry.scope)
      if (tools === undefined) {
        throw new DomainError('checkpoint-failed', '宿主没有提供工具视图，无法导出检查点')
      }
      const dir =
        record.workspaceDir === null
          ? join(record.root, 'checkpoints')
          : join(record.workspaceDir, 'checkpoints')
      const checkpoint = await createCheckpoint({
        dir,
        root: record.root,
        serverName: record.serverName,
        documentId: record.documentId,
        sourceName: record.doc.name,
        now: deps.now,
        exists: existsSync,
        mkdir: async (path) => {
          await mkdir(path, { recursive: true })
        },
        stat: async (path) => ({ size: (await stat(path)).size }),
        sha256: sha256File,
        invoke: (name, args) => createToolInvoker(tools, entry.scope).invoke(name, args),
      })
      if (record.workspaceDir !== null) {
        try {
          await appendCheckpoint(record.workspaceDir, checkpoint)
        } catch (error) {
          deps.logger?.(`检查点已落盘但写台账失败：${record.workspaceDir}`, error)
        }
      }
      return checkpoint
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
