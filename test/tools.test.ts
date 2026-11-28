import test from 'node:test'
import assert from 'node:assert/strict'
import type { TaskRecord, TaskRegistry } from '../src/tasks.js'
import { TOOL_NAMES, createToolDefinitions, registerTools } from '../src/tools.js'

const record = {
  taskId: 'a71c2e90',
  sessionId: 's1',
  serverName: 'bo_a71c2e90',
  doc: { absPath: 'C:/d/a.docx', name: 'a.docx', sha256: 'sha256:x' },
  root: 'C:/d',
  rootKind: 'parent',
  readOnly: true,
  workspaceDir: null,
  createdAt: new Date(0),
} as unknown as TaskRecord

function makeRegistry(overrides: Partial<TaskRegistry> = {}): TaskRegistry {
  return {
    open: async () => record,
    checkpoint: async () => ({ name: 'cp', path: 'C:/d/checkpoints/cp.docx', size: 1, sha256: 's', createdAt: '' }),
    deliver: async () => ({ taskId: 't1', name: 'a.docx', path: 'C:/d/a.docx', size: 1, sha256: 's', createdAt: '' }),
    replace: async () => ({ taskId: 't1', path: 'C:/d/a.docx', sha256: 's', bytes: 1 }),
    close: async () => {},
    closeSession: async () => {},
    call: async () => ({ content: [] }),
    tools: async () => ({ tools: [] }),
    get: () => record,
    list: () => [],
    ...overrides,
  }
}

const cfg = () => ({ workspaceMode: 'auto', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' }) as const

test('定义 7 个工具且每个都带可渲染的 output', () => {
  const defs = createToolDefinitions({ registry: makeRegistry(), sessionId: 's1', config: cfg })
  assert.deepEqual(
    defs.map((definition) => definition.name),
    [...TOOL_NAMES],
  )
  for (const definition of defs) {
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 10)
    assert.equal(typeof definition.execute, 'function')
  }
})

test('open 工具返回含任务 id 的文本', async () => {
  const defs = createToolDefinitions({ registry: makeRegistry(), sessionId: 's1', config: cfg })
  const open = defs[0]!
  const value = await open.execute({ path: 'a.docx' }, undefined)
  const blocks = open.output.render({ path: 'a.docx' }, value)
  assert.match(JSON.stringify(blocks), /a71c2e90/)
  assert.equal(blocks[0]?.type, 'text')
})

test('透传工具把工具名和参数原样转给该任务的连接', async () => {
  const calls: unknown[] = []
  const registry = makeRegistry({
    call: async (...args) => {
      calls.push(args)
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  })
  const defs = createToolDefinitions({ registry, sessionId: 's1', config: cfg })
  const pass = defs.find((definition) => definition.name === 'betteroffice_call')!
  const value = await pass.execute({ task: 't1', tool: 'xlsx_outline', args: { document: 'doc1' } }, undefined)
  assert.deepEqual(calls, [['s1', 't1', 'xlsx_outline', { document: 'doc1' }]])
  assert.match(JSON.stringify(pass.output.render({}, value)), /ok/)
})

test('透传工具缺 tool 参数时给中文错误', async () => {
  const defs = createToolDefinitions({ registry: makeRegistry(), sessionId: 's1', config: cfg })
  const pass = defs.find((definition) => definition.name === 'betteroffice_call')!
  await assert.rejects(() => pass.execute({ task: 't1' }, undefined), /缺少参数 tool/)
})

test('replace 只有 confirm 为 true 才算用户同意', async () => {
  const calls: { taskId: string; confirm?: boolean }[] = []
  const registry = makeRegistry({
    replace: async (_sessionId, taskId, input) => {
      calls.push({ taskId, confirm: input?.confirm })
      return { taskId, path: 'C:/d/a.docx', sha256: 's', bytes: 1 }
    },
  })
  const defs = createToolDefinitions({ registry, sessionId: 's1', config: cfg })
  const replace = defs.find((definition) => definition.name === 'betteroffice_replace')!
  await replace.execute({ task: 't1', confirm: 'yes' }, undefined)
  await replace.execute({ task: 't1', confirm: true }, undefined)
  assert.deepEqual(calls, [
    { taskId: 't1', confirm: false },
    { taskId: 't1', confirm: true },
  ])
})

test('close 把会话不匹配的错误原样暴露给模型', async () => {
  const registry = makeRegistry({
    close: async () => {
      const error = new Error('任务 zzz 属于别的会话，不能操作') as Error & { code: string }
      error.code = 'task-foreign'
      throw error
    },
  })
  const defs = createToolDefinitions({ registry, sessionId: 's1', config: cfg })
  const close = defs.find((definition) => definition.name === 'betteroffice_close')!
  await assert.rejects(() => close.execute({ task: 'zzz' }, undefined), /别的会话/)
})

test('缺少必填参数时给中文错误', async () => {
  const defs = createToolDefinitions({ registry: makeRegistry(), sessionId: 's1', config: cfg })
  const open = defs[0]!
  await assert.rejects(() => open.execute({}, undefined), /缺少参数 path/)
})

const sampleTools = {
  tools: [
    {
      name: 'docx_edit',
      description: 'Edit runs. Second sentence is dropped.',
      inputSchema: {
        type: 'object',
        properties: { document: { type: 'string' }, version: { type: 'string' }, edits: {} },
        required: ['document', 'version'],
      },
    },
    { name: 'office_open', description: 'Open a document.', inputSchema: { properties: { path: {} } } },
  ],
}

test('betteroffice_tools 默认只给摘要，免得几十个 schema 一次灌满上下文', async () => {
  const registry = makeRegistry({ tools: async () => sampleTools })
  const defs = createToolDefinitions({ registry, sessionId: 's1', config: cfg })
  const shown = defs.find((definition) => definition.name === 'betteroffice_tools')!

  assert.deepEqual(await shown.execute({ task: 't1' }, undefined), {
    tools: [
      {
        name: 'docx_edit',
        summary: 'Edit runs.',
        required: ['document', 'version'],
        optional: ['edits'],
      },
      { name: 'office_open', summary: 'Open a document.', required: [], optional: ['path'] },
    ],
    hint: '要看某个工具的完整 inputSchema，再调一次并带上 tool 参数。',
  })
})

test('betteroffice_tools 带 tool 时给这一个工具的完整 schema', async () => {
  const registry = makeRegistry({ tools: async () => sampleTools })
  const defs = createToolDefinitions({ registry, sessionId: 's1', config: cfg })
  const shown = defs.find((definition) => definition.name === 'betteroffice_tools')!

  assert.deepEqual(await shown.execute({ task: 't1', tool: 'office_open' }, undefined), {
    tool: sampleTools.tools[1],
  })
  await assert.rejects(
    () => shown.execute({ task: 't1', tool: 'docx_replace_text' }, undefined),
    /没有这个工具：docx_replace_text/,
  )
})

test('透传缺 tool 时说清参数该放哪', async () => {
  const defs = createToolDefinitions({ registry: makeRegistry(), sessionId: 's1', config: cfg })
  const pass = defs.find((definition) => definition.name === 'betteroffice_call')!

  await assert.rejects(
    () => pass.execute({ task: 't1' }, undefined),
    /tool 和 args 都要放在顶层/,
  )
})

test('registerTools 把定义逐个注册', () => {
  const got: string[] = []
  registerTools({ register: (definition) => got.push(definition.name) }, {
    registry: makeRegistry(),
    sessionId: 's1',
    config: cfg,
  })
  assert.deepEqual(got, [...TOOL_NAMES])
})
