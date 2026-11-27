/** 任务注册表：一个任务 = 一个文档身份 + 一个 MCP 实例，绑定到发起打开的会话。 */

import { constants, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { createCheckpoint, type Checkpoint } from './checkpoint.js'
import { cleanupWorkspace, type CleanupDecision } from './cleanup.js'
import type { ConfigData } from './config.js'
import { pickDeliveryTarget, type Delivery } from './deliver.js'
import { DomainError } from './errors.js'
import { createToolInvoker, readToolJson, waitForTool, type ToolView } from './invoke.js'
import type { MountHandle, MountSpec } from './mount.js'
import { sha256File, type ResolvedDoc } from './paths.js'
import { replaceOriginal } from './replace.js'
import { planRoot, type RootKind, type RootPlan } from './root.js'
import { appendCheckpoint, appendDelivery, createWorkspace, readLedger, type TaskLedger } from './workspace.js'

/** 交付中转目录：先导出到 root 内的这里，再用独占复制搬到用户指定的目录。 */
const STAGING_DIR = '.deliver'

async function copyFileExcl(from: string, to: string): Promise<void> {
  await copyFile(from, to, constants.COPYFILE_EXCL)
}

/**
 * 把绝对路径换成 MCP 认的相对路径：分隔符统一成 `/`，且必须落在 root 之内。
 * 越界（`..` 开头或变成绝对路径）直接失败——宁可不编辑，也不能让 MCP 摸到 root 外的文件。
 */
export function mcpRelativePath(root: string, target: string): string {
  const path = relative(root, target).split('\\').join('/')
  if (path === '' || path.startsWith('..') || isAbsolute(path)) {
    throw new DomainError('path-outside-root', `内部路径越出了 MCP 根目录：${target}（根目录 ${root}）`)
  }
  return path
}

/** 交付目录只允许是源文件所在目录或其子目录。 */
export function assertInsideDir(parent: string, target: string): void {
  const path = relative(parent, target)
  if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) return
  throw new DomainError('delivery-outside', `只能在源文件所在目录或其子目录里交付：${target}`)
}

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

export type ReplaceOutcome = { taskId: string; path: string; sha256: string; bytes: number }

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
  copyExcl?: (from: string, to: string) => Promise<void>
  createWorkspaceDir?: typeof createWorkspace
  waitToolTimeoutMs?: number
  home?: string
  recycle?: (path: string) => Promise<void>
  replaceFile?: typeof replaceOriginal
  cleanupWorkspace?: (opts: Parameters<typeof cleanupWorkspace>[0]) => Promise<CleanupDecision>
  logger?: (message: string, error?: unknown) => void
}

export type TaskRegistry = {
  open(scope: unknown, sessionId: string, input: OpenInput): Promise<TaskRecord>
  checkpoint(sessionId: string, taskId: string): Promise<Checkpoint>
  deliver(sessionId: string, taskId: string, input?: { dir?: string }): Promise<Delivery>
  replace(sessionId: string, taskId: string, input?: { confirm?: boolean }): Promise<ReplaceOutcome>
  close(scope: unknown, sessionId: string, taskId: string, input?: { discard?: boolean }): Promise<void>
  closeSession(sessionId: string): Promise<void>
  get(sessionId: string, taskId: string): TaskRecord
  list(sessionId: string): TaskRecord[]
}

export function createTaskRegistry(deps: TaskRegistryDeps): TaskRegistry {
  const entries = new Map<string, Entry>()

  /** 用独占复制把草稿搬到目标目录：目标已存在就重新挑名字，绝不覆盖。 */
  async function placeOutside(from: string, dir: string, sourceName: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const target = pickDeliveryTarget(dir, sourceName, existsSync)
      try {
        await (deps.copyExcl ?? copyFileExcl)(from, target.path)
        return target.path
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw new DomainError('deliver-failed', `交付到 ${target.path} 失败：${(error as Error).message}`)
      }
    }
    throw new DomainError('deliver-failed', `目标目录被并发占用，请重试：${dir}`)
  }

  function lookup(sessionId: string, taskId: string): Entry {
    const entry = entries.get(taskId)
    if (entry === undefined) throw new DomainError('task-not-found', `任务不存在或已关闭：${taskId}`)
    if (entry.record.sessionId !== sessionId) {
      throw new DomainError('task-foreign', `任务 ${taskId} 属于别的会话，不能操作`)
    }
    return entry
  }

  async function listWorkspaceFiles(dir: string): Promise<readonly string[]> {
    const found = await readdir(dir, { recursive: true, withFileTypes: true })
    return found
      .filter(item => item.isFile())
      .map(item => relative(dir, join(item.parentPath, item.name)))
  }

  /** 工作文件夹只在「已交付」或「用户放弃草稿」且没有未登记文件时才删。 */
  async function maybeCleanup(entry: Entry, discard: boolean | undefined): Promise<void> {
    const dir = entry.record.workspaceDir
    if (dir === null) return
    const cleanup = deps.cleanupWorkspace ?? cleanupWorkspace
    try {
      await cleanup({
        mode: deps.config().cleanupMode,
        dir,
        discard,
        readLedger,
        listFiles: listWorkspaceFiles,
        removeDir: target => rm(target, { recursive: true, force: true }),
        logger: deps.logger,
      })
    } catch (error) {
      deps.logger?.(`清理工作文件夹时出错：${dir}`, error)
    }
  }

  async function disposeEntry(entry: Entry, discard?: boolean): Promise<void> {
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
    await maybeCleanup(entry, discard)
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
      const result = await createToolInvoker(tools, scope).invoke(toolName, {
        path: mcpRelativePath(root, openedPath),
      })
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

      // 编辑副本：把源文件复制进 MCP 能看到的位置（临时目录或工作文件夹的 draft/），之后一律只动副本。
      // 绝不把原件路径交给 MCP——否则 agent 能绕过替换事务直接改原件。
      let openedPath = doc.absPath
      if (plan.rootKind !== 'parent') {
        const targetDir = plan.rootKind === 'workspace' ? join(plan.root, 'draft') : plan.root
        openedPath = join(targetDir, doc.name)
        try {
          await mkdir(targetDir, { recursive: true })
          await (deps.copyFile ?? copyFile)(doc.absPath, openedPath)
        } catch (error) {
          await rollback()
          throw new DomainError('copy-failed', `复制文档到编辑副本失败：${openedPath}（${String(error)}）`)
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
      if (record.readOnly) {
        throw new DomainError('checkpoint-failed', '只读任务不产出检查点；请用 mode:"edit" 打开后再存档。')
      }
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

    async deliver(sessionId, taskId, input) {
      const entry = lookup(sessionId, taskId)
      const { record } = entry
      if (record.readOnly) {
        throw new DomainError('deliver-failed', '只读任务不产出新文件；请用 mode:"edit" 打开后再改。')
      }
      const tools = deps.toolViewFor?.(entry.scope)
      if (tools === undefined) {
        throw new DomainError('deliver-failed', '宿主没有提供工具视图，无法导出草稿')
      }
      const deliveryDir = resolve(record.doc.dir, input?.dir ?? '.')
      assertInsideDir(record.doc.dir, deliveryDir)
      await mkdir(deliveryDir, { recursive: true })
      const stagingDir = join(record.root, STAGING_DIR)
      try {
        const staging = pickDeliveryTarget(stagingDir, record.doc.name, existsSync)
        await mkdir(stagingDir, { recursive: true })
        const relativePath = relative(record.root, staging.path).split('\\').join('/')
        await createToolInvoker(tools, entry.scope).invoke(
          `mcp__${record.serverName}__office_export`,
          { document: record.documentId, path: relativePath },
        )
        const info = await stat(staging.path).catch(() => {
          throw new DomainError('deliver-failed', `BetterOffice 没有写出草稿：${staging.path}`)
        })
        const sha256 = await sha256File(staging.path)
        const targetPath = await placeOutside(staging.path, deliveryDir, record.doc.name)
        const delivery: Delivery = {
          taskId,
          name: basename(targetPath),
          path: targetPath,
          size: info.size,
          sha256,
          createdAt: deps.now().toISOString(),
        }
        if (record.workspaceDir !== null) {
          await appendDelivery(record.workspaceDir, delivery).catch((error: unknown) => {
            deps.logger?.(`交付已落盘但写台账失败：${record.workspaceDir}`, error)
          })
        }
        return delivery
      } finally {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },

    async replace(sessionId, taskId, input) {
      const entry = lookup(sessionId, taskId)
      const { record } = entry
      if (input?.confirm !== true) {
        throw new DomainError(
          'confirm-required',
          '替换原文件必须先得到用户同意：先向用户说明这一点，用户明确同意后再带 confirm:true 重试。',
        )
      }
      if (record.readOnly) {
        throw new DomainError('replace-failed', '只读任务不能替换原文件；请用 mode:"edit" 打开后再改。')
      }
      if (deps.home === undefined) {
        throw new DomainError('replace-failed', '插件没有拿到 DSH 主目录，无法安全记录替换事务。')
      }
      const recycle = deps.recycle
      if (recycle === undefined) {
        throw new DomainError('recycle-unavailable', '没有可用的回收站实现，只能另存为新文件。')
      }
      const tools = deps.toolViewFor?.(entry.scope)
      if (tools === undefined) {
        throw new DomainError('replace-failed', '宿主没有提供工具视图，无法导出草稿')
      }
      const stagingDir = join(record.root, STAGING_DIR)
      const candidate = join(stagingDir, record.doc.name)
      try {
        await mkdir(stagingDir, { recursive: true })
        await rm(candidate, { force: true })
        const relativePath = relative(record.root, candidate).split('\\').join('/')
        await createToolInvoker(tools, entry.scope).invoke(
          `mcp__${record.serverName}__office_export`,
          { document: record.documentId, path: relativePath },
        )
        await stat(candidate).catch(() => {
          throw new DomainError('replace-failed', `BetterOffice 没有写出草稿：${candidate}`)
        })
        const result = await (deps.replaceFile ?? replaceOriginal)(
          {
            taskId,
            sourcePath: record.doc.absPath,
            candidatePath: candidate,
            expectedSourceSha256: record.doc.sha256,
          },
          { home: deps.home, recycle },
        )
        return { taskId, path: result.path, sha256: result.sha256, bytes: result.bytes }
      } finally {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
      }
    },

    async close(_scope, sessionId, taskId, input) {
      await disposeEntry(lookup(sessionId, taskId), input?.discard)
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
