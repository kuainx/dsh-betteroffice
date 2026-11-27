/** 暴露给 agent 的 5 个任务级工具。路径只在 open 时出现，其余都用任务 id。 */

import type { ConfigData } from './config.js'
import { DomainError } from './errors.js'
import type { TaskRecord, TaskRegistry } from './tasks.js'

export const TOOL_NAMES = [
  'betteroffice_open',
  'betteroffice_list',
  'betteroffice_checkpoint',
  'betteroffice_deliver',
  'betteroffice_replace',
  'betteroffice_close',
] as const

export type TextBlock = { type: 'text'; text: string }

export type ToolDefinition = {
  name: string
  description: string
  parameters: unknown
  output: { schema: unknown; render(args: unknown, value: unknown): TextBlock[] }
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
  timeoutMs?: number
}

export type ToolDeps = {
  registry: TaskRegistry
  sessionId: string
  config: () => ConfigData
  scope?: unknown
  cwd?: () => string
}

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function renderJson(_args: unknown, value: unknown): TextBlock[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function requiredString(args: Record<string, unknown>, key: string, label: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('invalid-arguments', `缺少参数 ${key}（${label}）`)
  }
  return value
}

export type TaskView = {
  taskId: string
  serverName: string
  document: string
  openedPath: string
  root: string
  rootKind: string
  readOnly: boolean
  workspaceDir: string | null
  sourceSha256: string
}

function view(task: TaskRecord): TaskView {
  return {
    taskId: task.taskId,
    serverName: task.serverName,
    document: task.documentId,
    openedPath: task.openedPath,
    root: task.root,
    rootKind: task.rootKind,
    readOnly: task.readOnly,
    workspaceDir: task.workspaceDir,
    sourceSha256: task.doc.sha256,
  }
}

export function createToolDefinitions(deps: ToolDeps): ToolDefinition[] {
  const cwdOf = () => (deps.cwd ?? (() => process.cwd()))()

  const open: ToolDefinition = {
    name: 'betteroffice_open',
    description:
      '打开一个 .docx/.xlsx/.pptx 文档并创建 BetterOffice 任务。这是唯一接受文件路径的工具；' +
      'mode=read 只在文档所在目录上以只读方式挂载，绝不修改原文件；mode=edit 在副本或工作文件夹里改。' +
      '返回的 taskId 之后所有操作都用它。相对路径按当前会话工作目录解析。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档路径，绝对路径或相对会话工作目录的路径' },
        mode: { type: 'string', enum: ['read', 'edit'], default: 'read', description: 'read 只读检查，edit 进入编辑草稿' },
        workspace: { type: 'boolean', description: 'edit 时是否要求使用工作文件夹保存草稿与检查点' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const mode = args.mode === 'edit' ? 'edit' : 'read'
      const task = await deps.registry.open(deps.scope, deps.sessionId, {
        path: requiredString(args, 'path', '文档路径'),
        cwd: cwdOf(),
        mode,
        workspace: args.workspace === true,
      })
      return view(task)
    },
  }

  const list: ToolDefinition = {
    name: 'betteroffice_list',
    description: '列出当前会话已打开的 BetterOffice 任务（taskId、文档、挂载根、是否只读）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute() {
      return { tasks: deps.registry.list(deps.sessionId).map(view) }
    },
  }

  const checkpoint: ToolDefinition = {
    name: 'betteroffice_checkpoint',
    description:
      '把当前草稿导出为检查点，存进工作文件夹的 checkpoints/，绝不覆盖已有检查点。' +
      '检查点不是交付：它只是可回退的中间版本，返回落盘文件的真实路径、大小与 sha256。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'betteroffice_open 返回的 taskId' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const taskId = requiredString(args, 'task', '任务 id')
      const saved = await deps.registry.checkpoint(deps.sessionId, taskId)
      return { taskId, ...saved }
    },
  }

  const deliver: ToolDefinition = {
    name: 'betteroffice_deliver',
    description:
      '把当前草稿交付成新文件：默认存到源文件同目录，同名时自动加序号，绝不覆盖任何已有文件。' +
      '返回落盘文件的真实路径、大小与 sha256。替换源文件不在本工具范围内。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'betteroffice_open 返回的 taskId' },
        dir: { type: 'string', description: '交付目录（可选，默认源文件所在目录）' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const taskId = requiredString(args, 'task', '任务 id')
      const dir = typeof args['dir'] === 'string' ? args['dir'] : undefined
      return await deps.registry.deliver(deps.sessionId, taskId, { dir })
    },
  }

  const replace: ToolDefinition = {
    name: 'betteroffice_replace',
    description:
      '把草稿替换成源文件本体：原件先移入回收站（可还原），再把草稿发布到原路径并校验。' +
      '只在用户明确要求"就改这个文件"时使用；必须先把 confirm 设为 true，宿主还会再弹一次确认。' +
      '平台不支持回收站时不会退化成永久删除，而是直接失败并建议改用 betteroffice_deliver。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'betteroffice_open 返回的 taskId' },
        confirm: { type: 'boolean', description: '用户已明确同意替换原文件时必须为 true' },
      },
      required: ['task', 'confirm'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const taskId = requiredString(args, 'task', '任务 id')
      const confirm = args['confirm'] === true
      return await deps.registry.replace(deps.sessionId, taskId, { confirm })
    },
  }

  const close: ToolDefinition = {
    name: 'betteroffice_close',
    description:
      '关闭任务并释放它的 MCP 实例与临时目录。之后该任务的 mcp__bo_* 工具不再可用。用户放弃草稿（不需要交付）时带 discard:true，只有这样工作文件夹才可能在没交付的情况下被清理。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'betteroffice_open 返回的 taskId' },
        discard: { type: 'boolean', description: '用户明确放弃这份草稿、不要交付物时为 true' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const taskId = requiredString(args, 'task', '任务 id')
      const discard = args['discard'] === true
      await deps.registry.close(deps.scope, deps.sessionId, taskId, { discard })
      return { taskId, status: 'closed' }
    },
  }

  return [open, list, checkpoint, deliver, replace, close]
}

export function registerTools(
  agentTools: { register(definition: ToolDefinition): unknown },
  deps: ToolDeps,
): void {
  for (const definition of createToolDefinitions(deps)) agentTools.register(definition)
}
