/** 暴露给 agent 的 8 个任务级工具。路径只在 open 时出现，其余都用任务 id。 */

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
  'betteroffice_call',
  'betteroffice_tools',
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

function requiredString(
  args: Record<string, unknown>,
  key: string,
  label: string,
  hint?: string,
): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    const advice = hint === undefined ? '' : `；${hint}`
    throw new DomainError('invalid-arguments', `缺少参数 ${key}（${label}）${advice}`)
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

  const call: ToolDefinition = {
    name: 'betteroffice_call',
    description:
      '把任意 BetterOffice MCP 工具转给某个任务执行——改内容都用它。' +
      '工具名用裸名（如 docx_edit、xlsx_write_range、pptx_edit、office_read、xlsx_outline），' +
      '不确定名字或参数就先调 betteroffice_tools 看清单与 inputSchema。' +
      '参数是与该工具一致的 JSON 对象，文档参数用 betteroffice_open 返回的 document。' +
      'office_export 与 office_files 不让直接调：写文件用 betteroffice_deliver / betteroffice_replace，找文件用 betteroffice_open。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'betteroffice_open 返回的 taskId' },
        tool: { type: 'string', description: 'MCP 工具名，裸名，不带 mcp__bo_ 前缀' },
        args: { type: 'object', description: '该工具的参数对象', additionalProperties: true },
      },
      required: ['task', 'tool'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const taskId = requiredString(args, 'task', '任务 id')
      const tool = requiredString(
        args,
        'tool',
        'MCP 工具名',
        'tool 和 args 都要放在顶层，args 里放该工具自己的参数。',
      )
      const input = (args['args'] ?? {}) as Record<string, unknown>
      return await deps.registry.call(deps.sessionId, taskId, tool, input)
    },
  }

  const tools: ToolDefinition = {
    name: 'betteroffice_tools',
    description:
      '列出该任务 MCP 子进程里的全部工具：名字、说明与 inputSchema（含必填字段）。' +
      '调 betteroffice_call 之前先看它，别照文档猜工具名——真实名字以这里为准。',
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
      return await deps.registry.tools(deps.sessionId, taskId)
    },
  }

  return [open, list, checkpoint, deliver, replace, close, call, tools]
}

export function registerTools(
  agentTools: { register(definition: ToolDefinition): unknown },
  deps: ToolDeps,
): void {
  for (const definition of createToolDefinitions(deps)) agentTools.register(definition)
}
