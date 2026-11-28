# BetterOffice 自带 MCP 连接器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `dsh-betteroffice` 不再依赖宿主的 `ctx.plugin` 挂 MCP，改为自己拉起 BetterOffice MCP 子进程并直接说 MCP 协议，使 6 个 agent 工具在 DSH 0.2.3-alpha.2 上真正可调用。

**Architecture:** 新增 `src/mcp.ts`：`spawn` CLI → `initialize` → `notifications/initialized` → `tools/call`，按 JSON-RPC id 关联响应。`src/tasks.ts` 的 `mounter`/`toolViewFor` 两层换成单个 `connector.connect(spec)`，连接对象自己带 `call(name, args)`。`src/mount.ts`、`src/invoke.ts` 里的工具表查找与轮询层整层删除。

**Tech Stack:** TypeScript（`tsc -p tsconfig.json` 编译到 `lib/`）、node:test、`node:child_process`、MCP stdio（换行分隔 JSON-RPC 2.0）。

**Spec:** `docs/superpowers/specs/2026-11-28-betteroffice-plugin-design.md`

## Global Constraints

- 文案全中文、错误消息可行动；错误一律 `DomainError(code, message)`。
- 不新增运行时依赖、不引入打包器；只用 Node 标准库。
- 现有 176 条测试、6 个 agent 工具、`/betteroffice` 命令、配置卡片必须继续工作。
- npm 相关命令一律带 `--cache <版本目录>/.npm-cache`（本次改动不碰安装，约束仍然有效）。
- 本会话 `git` 写操作必须带 `sandbox_permissions: "danger-full-access"`，中文提交信息写 UTF-8 文件后 `git commit -F`。
- 真机验证只能由用户在 DSH 里做；本机沙箱禁止 `spawn`，除 `danger-full-access` 的单独一次验证。

## 已验证的事实（照抄，别重新猜）

- MCP 服务器答复：`initialize` → `{ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'betteroffice', version: '0.4.0' } }`；`tools/list` 返回 `result.tools[].name` 形如 `office_open`、`xlsx_outline`（无 `mcp__` 前缀）。
- `tools/call` 参数名是 `arguments`（MCP 标准），结果在 `result`，失败时 `result.isError === true` 且正文在 `result.content[].text`。
- 宿主侧不再参与：`ctx.plugin` 在沙箱 façade 里被明确拒绝（`Framework internals (… plugin …) are withheld by design.`）。
- 现有 `readToolJson`（`src/invoke.ts`）已能解 `structuredContent` 与 `content[].text` 的 JSON——保留它。

## Review Focus

- 子进程半路死掉：`call` 必须立刻失败（`mcp-disconnected`），不能挂到 15 秒超时。
- 并发两个 `call`：响应乱序返回时按 id 关联，不能串结果。
- `result.isError` 必须转成中文错误并带上服务器原文，而不是当成成功。
- 任务关闭后 `call` 必须拒绝（连接已 dispose），不能悄悄写进已删目录。
- dispose 时子进程必须真的结束（Windows 上 `kill()` 足够），否则下次打开同名任务拿不到文件锁。

---

### Task 1: MCP 连接器

**Files:**

- Create: `src/mcp.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**

- Consumes: `DomainError`、`McpStartFailedError`（`src/errors.ts`）。
- Produces:
  - `export type McpSpawnSpec = { serverName: string; command: string; args: string[]; cwd: string }`
  - `export type McpConnection = { serverName: string; call(name: string, args: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }`
  - `export type McpConnectorDeps = { spawn?: SpawnLike; startupTimeoutMs?: number; callTimeoutMs?: number; logger?: (message: string, error?: unknown) => void }`
  - `export type SpawnLike = (command: string, args: string[], options: { cwd: string; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildLike`，`ChildLike = { stdin: { write(text: string): unknown; end?(): unknown }; stdout: { on(event: 'data', handler: (chunk: { toString(encoding: 'utf8'): string }) => void): unknown }; stderr: { on(event: 'data', handler: (chunk: { toString(encoding: 'utf8'): string }) => void): unknown }; on(event: 'exit' | 'error', handler: (value: unknown) => void): unknown; kill(): unknown }`
  - `export function createConnector(deps?: McpConnectorDeps): { connect(spec: McpSpawnSpec): Promise<McpConnection>; has(serverName: string): boolean }`

- [ ] **Step 1: 写失败测试** `test/mcp.test.ts`

用例（名字与断言照此写，假子进程用 `EventEmitter` 手搓，`stdin.write` 收集成 `writes: string[]`，测试里手动 `child.stdout.emit('data', ...)` 回包）：

```ts
test('connect 先发 initialize，拿到结果再发 notifications/initialized', ...)
  // writes[0] 解析后：jsonrpc '2.0'、method 'initialize'、
  //   params.protocolVersion === '2024-11-05'、params.clientInfo.name === 'dsh-betteroffice'
  // 回 { jsonrpc:'2.0', id: writes[0].id, result:{ protocolVersion:'2024-11-05' } } 后
  // writes[1] 的 method === 'notifications/initialized' 且没有 id

test('call 发 tools/call 并返回 result', ...)
  // connect 完成后 call('office_open', { path: 'draft/a.docx' })
  // 断言 { method:'tools/call', params:{ name:'office_open', arguments:{ path:'draft/a.docx' } } }
  // 回 result 后 promise 解析为该 result 对象

test('两个并发 call 按 id 关联，乱序返回也不串', ...)
  // 先 call('a') 再 call('b')，按 id 倒序回包，断言各自拿到自己的 result

test('isError 的结果转成 mcp-tool-failed，并带上服务器原文', ...)
  // result = { isError: true, content: [{ type:'text', text:'找不到文档' }] }
  // assert.rejects(/找不到文档/) 且 error.code === 'mcp-tool-failed'

test('子进程退出后 call 立刻失败，不等超时', ...)
  // 发 call 后 emit('exit', 1) → rejects /mcp-disconnected/

test('close 之后 call 拒绝', ...)
  // await conn.close() → call 抛 mcp-disconnected；且 child.kill 被调用过

test('initialize 迟迟不回则 mcp-start-failed', ...)
  // startupTimeoutMs: 10，不回包 → rejects code 'mcp-start-failed'
```

- [ ] **Step 2: 跑 RED**

Run: `npm run build` → 期望 `TS2307: Cannot find module '../src/mcp.js'`。

- [ ] **Step 3: 实现 `src/mcp.ts`**

要点（实现者自行补齐细节）：

- `let nextId = 1`；`const pending = new Map<number, { resolve, reject, timer }>()`。
- stdout 按 `\n` 切行，`JSON.parse` 失败的行直接忽略（服务器可能打印非 JSON）；带 `id` 且 `pending` 里有的，清 timer 后 `resolve(message.result)` / `reject(jsonRpcError)`。
- `initialize` 用 `startupTimeoutMs ?? 30_000` 计时；超时 `reject(new McpStartFailedError(spec.serverName, new Error('30 秒内没有回应 initialize')))` 并 `child.kill()`。
- `tools/call` 用 `callTimeoutMs ?? 120_000`；超时 `DomainError('mcp-timeout', \`调用 ${name} 超时（${ms}ms），BetterOffice 可能卡住了。\`)`。
- `result.isError === true` → `DomainError('mcp-tool-failed', 首条 content[].text 或 JSON.stringify(result))`；正文已经是我们自己的中文错误时不要加前缀。
- `child.on('exit')` / `child.on('error')` → 把所有 pending 以 `DomainError('mcp-disconnected', \`BetterOffice MCP 断开了（${serverName}），请重新打开文档。\`)`拒绝，并把`closed = true`。
- `close()`：`closed = true`、`child.kill()`、`child.stdin.end?.()`，随后的 `call` 立即抛 `mcp-disconnected`。
- `createConnector` 维护 `Map<serverName, McpConnection>` 供 `has()`；`spawn` 默认 `(cmd, args, opts) => spawn(cmd, args, opts)`（`import { spawn } from 'node:child_process'`）。

- [ ] **Step 4: 跑 GREEN**

Run: `npm run build && npm test` → 期望新增 7 条全过，总数 176 + 7。

- [ ] **Step 5: 提交**

```bash
git add src/mcp.ts test/mcp.test.ts
git commit -F .scratch/msg-mcp.txt   # "feat: 自己拉起并说 MCP 协议"
```

### Task 2: 任务注册表改走连接器

**Files:**

- Modify: `src/tasks.ts`（`mounter`/`toolViewFor`/`waitToolTimeoutMs` → `connector`；`Entry` 存连接）
- Modify: `src/checkpoint.ts:48`（`invoke` 收到的是裸工具名，改 `office_export`）
- Modify: `test/tasks-harness.ts`、`test/tasks.test.ts`
- Delete: `src/mount.ts`、`test/mount.test.ts`
- Modify: `src/invoke.ts`（只留 `readToolJson`）、`test/invoke.test.ts`、`src/errors.ts`（删没人用的 `McpUnavailableError`）

**Interfaces:**

- Consumes: Task 1 的 `McpConnection`、`McpSpawnSpec`。
- Produces: `TaskRegistryDeps` 里 `connector: { connect(spec: McpSpawnSpec): Promise<McpConnection> }`；`TaskRecord` 不变；`TaskRegistry` 签名不变（`open(scope, …)` 的 `scope` 参数保留但不再使用）。

- [ ] **Step 1: 改假件并写断言**（先 RED）

`test/tasks-harness.ts`：删 `fakeTools`/`exportingTools` 的 view 形态，改成
`fakeConnection(behavior)`：返回 `{ connection: { serverName, call, close }, calls: ToolCall[] }`，`call` 记录 `{name, args}`；`office_open` 回 `{ content: [{ type:'text', text: JSON.stringify({ document: behavior.document ?? 'doc1' }) }] }`；`office_export` 真的往 `holder.root` 写 `exported-bytes`；`fail: true` 时 `office_open` 抛 `Error('office_open 失败')`。
`harness()` 里 `mounter` 换成 `connector = { connect: async (spec) => {...}, has: () => true }`，仍然记录 `mounted`（每次 connect 的 `serverName`）与 `disposed`（close 过的），并暴露 `connection`。

`test/tasks.test.ts` 断言改为：

- open 后 `calls[0].name === 'office_open'` 且 `calls[0].args.path` 是 root 内相对路径；
- 工具名不再带 `mcp__bo_x__` 前缀（即 `calls.every(c => !c.name.startsWith('mcp__'))`）；
- checkpoint/deliver/replace 调到 `office_export`，参数 `{ document, path }` 不变；
- open 失败时连接被 close（`disposed` 含该 serverName）。

Run: `npm run build` → 期望 `TS2339`/`TS2741` 之类因 `connector` 不存在的类型错误。

- [ ] **Step 2: 改 `src/tasks.ts`**

- 删 `import { createToolInvoker, readToolJson, waitForTool, type ToolView }`、`import type { MountHandle, MountSpec }`，改 `import { readToolJson } from './invoke.js'` 与 `import type { McpConnection, McpSpawnSpec } from './mcp.js'`。
- `Entry = { record: TaskRecord; connection: McpConnection; tempDir: string | null }`（删 `handle`、`scope`）。
- `TaskRegistryDeps`：删 `mounter`、`toolViewFor`、`waitToolTimeoutMs`、`scope` 相关，加 `connector: { connect(spec: McpSpawnSpec): Promise<McpConnection> }`。
- `openInMcp(connection, root, openedPath, rollback)`：`const result = await connection.call('office_open', { path: mcpRelativePath(root, openedPath) })`；其余校验（`payload.document` 非空）与 rollback 行为不变。
- `open`：`const connection = await deps.connector.connect({ serverName, command: runtime.command, args: [runtime.cliPath, ...plan.args], cwd: plan.root })`；rollback 里 `await connection.close()`。
- `checkpoint`/`deliver`/`replace`：删 `tools` 取值与 `if (tools === undefined) throw ...` 分支，改 `invoke: (name, args) => entry.connection.call(name, args)` / `entry.connection.call('office_export', {...})`。
- `disposeEntry`：`await entry.connection.close()`。

- [ ] **Step 3: 改 `src/checkpoint.ts:48`**

`await deps.invoke('office_export', { document: deps.documentId, path: relPath })`，并把 `CheckpointDeps.serverName` 保留（测试夹具还在传，删它要多改一处；注释说明只有检查点名/日志用）。

- [ ] **Step 4: 删死代码**

`git rm src/mount.ts test/mount.test.ts`；`src/invoke.ts` 只留 `readToolJson`（删 `ToolView`、`ToolDefinitionLike`、`createToolInvoker`、`lookupTool`、`describeView`、`waitForTool` 与相关常量）；`test/invoke.test.ts` 只留 `readToolJson` 的 2 条；`src/errors.ts` 删 `McpUnavailableError`（`grep -r "McpUnavailableError"` 确认无引用）。

- [ ] **Step 5: GREEN**

Run: `npm run build && npm test` → 期望全绿（数量会因删测试而变动，逐条确认剩下的都是活代码）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -F .scratch/msg-mcp2.txt   # "refactor: 任务注册表改走自带 MCP 连接器"
```

### Task 3: 宿主装配 + 真机冒烟

**Files:**

- Modify: `src/index.ts`（删 `createMounter`/`loadClient`/`toolBag`，改用 `createConnector`）
- Modify: `docs/superpowers/plans/2026-11-28-betteroffice-config-card.md:341-343`（实测记录追加本次结论）
- Modify: `.superpowers/sdd/betteroffice-config-card/progress.md`

**Interfaces:**

- Consumes: Task 1 的 `createConnector`、Task 2 的 `TaskRegistryDeps.connector`。
- Produces: 无（末端任务）。

- [ ] **Step 1: 改 `src/index.ts`**

- 删 `import { createMounter, type McpClientModule } from './mount.js'`、`const mounter = createMounter({...})`（整块含 `loadClient`）、`toolBag()` 函数、`toolViewFor: toolBag`。
- 加 `import { createConnector } from './mcp.js'` 与 `const connector = createConnector({ logger: log })`。
- `createTaskRegistry({ connector, ... })`（其余依赖不动）。
- `attach()` 里 `tools` 服务与 `registerTools` 保持不变（注册我们自己的 6 个工具这条路是好的）。

- [ ] **Step 2: 验证**

Run: `npm run build && npm test && node --check client.js` → 全过。

- [ ] **Step 3: 提交**

```bash
git add src/index.ts
git commit -F .scratch/msg-mcp3.txt   # "feat: 宿主装配改用自带 MCP 连接器"
```

- [ ] **Step 4: 请用户真机冒烟**

请用户重启 DSH，然后依次：

1. `betteroffice_open` 打开 `D:\Github\dsh-betteroffice\.scratch\samples\smoke.docx`；
2. `betteroffice_open` 打开 `smoke.pptx`、`smoke.xlsx`；
3. 各自做一次编辑 → `betteroffice_checkpoint` → `betteroffice_deliver`。

把结果记进台账与计划末尾「实测记录」；失败就把错误原文贴回来，按 systematic-debugging 重来。
