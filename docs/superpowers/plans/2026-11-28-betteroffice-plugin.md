# BetterOffice 插件（阶段 0–1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可加载的 DSH 宿主插件：能把指定文档只读打开、按 agent scope 挂载 `betteroffice-mcp`、向该 agent 暴露 5 个 `betteroffice_*` 工具，并在缺少运行时时给出可行动的错误。

**Architecture:** 插件入口只做装配（`apply` 里读配置、订阅 `agent/created`、注册工具、管任务生命周期）；具体职责拆到 `paths`（路径解析与身份校验）、`workspace`（工作文件夹命名/独占创建/台账）、`mount`（封装 `dsh-mcp-client` 的按 scope 挂载）、`runtime`（Node 与 CLI 定位）、`tasks`（会话↔文档↔挂载的任务注册表）、`tools`（5 个工具定义）。MCP 工具由 `dsh-mcp-client` 自动以 `mcp__bo_<id8>__*` 注册到该 agent 的 scope。

**Tech Stack:** TypeScript 5.9（`tsc` 编译到 `lib/`）、Node 24 ESM、`node:test`、`@deepseek-ai/cordis` 类型、`@deepseek-ai/schemastery`（配置 schema）、`@deepseek-ai/dsh-mcp-client`（运行时动态 import 宿主那份）、`@hyzyn/dsh-kit`（设置/HTTP 等封装）。

**Spec:** [docs/superpowers/specs/2026-11-28-betteroffice-plugin-design.md](../specs/2026-11-28-betteroffice-plugin-design.md)

**范围说明：** 本计划只覆盖 DESIGN §8 的**阶段 0（脚手架）与阶段 1（只读打开 + 挂载 MCP + 工具骨架）**。阶段 2（副本编辑/检查点/交付）、阶段 3（运行时管理/清理/配置页）、阶段 4（替换事务）在阶段 1 落地后另写计划（它们的接口依赖阶段 1 的实际形态，现在写等于猜）。每完成一个 Task 提交一次。

---

## Global Constraints

- Node 运行时下限 `>=22.12.0`（`betteroffice-mcp` 的 engines），**不是** `>=22`。
- 工作文件夹命名 `dsh-<原文件名含扩展名>-<YYMMDD-HHmmss>-<8 位任务 id>`，作为源文件同级目录；保留中文与扩展名，剔除分隔符/控制字符/Windows 非法字符，不留尾随空格与点，超长按字节截断。
- 工作文件夹**独占创建**：`mkdir` 不加 `recursive`，已存在即失败，绝不接管已有目录。
- `serverName` 形如 `bo_<8 位任务 id>`，必须匹配 `^[A-Za-z0-9_-]{1,32}$`；MCP 工具名为 `mcp__<serverName>__<tool>`。
- 只读打开：root 为**源文件父目录**，参数 `--root <parent> --read-only`，工具白名单排除 `office_files`。
- 编辑且无工作文件夹：root 为私有临时目录（内含副本）；编辑且有工作文件夹：root 为**工作文件夹根**。
- 永不覆盖：落盘用 `copyFile(..., COPYFILE_EXCL)` / `link`；MCP 的 `office_export` 自身已拒绝覆盖。
- `cordis.patch.yml` 行名必须等于包名：`- insert: [{ id: betteroffice, name: 'dsh-betteroffice' }]`。
- `package.json`：`"type": "module"`、`"main": "lib/src/index.js"`、`"types": "lib/src/index.d.ts"`、`"dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }`。
- tsconfig：`module`/`moduleResolution` 均为 `nodenext`，`target: "es2023"`，`strict: true`，`rootDir: "."`，`outDir: "lib"`，`declaration: true`，`skipLibCheck: true`。
- 插件代码不得 import `@deepseek-ai/dsh-mcp-client` 的静态绑定，只能用变量 specifier 的 `import()`，且失败必须降级为明确错误。
- 文档、错误信息面向用户的部分用中文；代码标识符用英文。
- 本机命令注意：`node --test` 需加 `--experimental-test-isolation=none`；`npm install` 需加 `--cache <repo>/.scratch/npmcache`（默认 cache 被沙箱拦）。

## Review Focus

以下 5 类情况 spec 隐含但没有任何现成测试兜底，最可能咬到使用者。每条都已挂到拥有该代码的 Task 上：

1. **同一秒内同名文档被两个会话打开** —— 期望：第二个调用拿到另一个合法目录名并成功，而不是接管第一个的目录或静默复用（Task 3、Task 4）。
2. **编辑期间源文件被外部程序改写** —— 期望：哈希与打开时记录不一致时，后续操作用 `source-changed` 明确报错，不静默当成原文件（Task 5 记录哈希；阶段 2 的交付会比对）。
3. **路径含 `..`、UNC 前缀、尾随点/空格、Windows 保留名（CON/NUL/PRN）** —— 期望：规范化后要么指向真实存在的同一文件，要么给出明确拒绝原因，绝不变成一另一路径（Task 5）。
4. **MCP 启动失败（未安装/Node 缺失或过旧/CLI 崩溃）** —— 期望：`betteroffice_open` 返回可行动的中文错误并已 dispose 该 fiber，会话不至于卡死或泄漏子进程（Task 7、Task 8、Task 9）。
5. **任务关闭后 agent 仍调用 `mcp__bo_xxx__*` 或在别的会话里用别人的 taskId** —— 期望：明确报错（`task-not-found` / `task-foreign`），不产生孤儿目录或写入（Task 9、Task 10）。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `package.json` | 包元数据、DSH bundle 清单、脚本、peer/dev 依赖 |
| `tsconfig.json` | 单一编译配置（源码 + 测试一起编到 `lib/`） |
| `cordis.patch.yml` | DSH bundle 的插件行注册 |
| `.gitignore` | `node_modules/`、`lib/`、`.scratch/`、`.acl-recovery/` |
| `src/index.ts` | 插件入口：`name`/`inject`/`Config`/`apply`，agent 生命周期装配 |
| `src/config.ts` | Config schema（volatile 字段）与默认值归一化 |
| `src/errors.ts` | 领域错误类型与中文消息（`task-not-found`、`source-changed`、`mcp-unavailable` 等） |
| `src/paths.ts` | 路径规范化、真实路径与身份校验、sha256、扩展名白名单 |
| `src/workspace.ts` | 工作文件夹命名器、独占创建、台账读写 |
| `src/root.ts` | root 决策矩阵（只读/编辑 × 工作文件夹三档） |
| `src/mount.ts` | `dsh-mcp-client` 按 scope 挂载的封装（懒加载、幂等、释放） |
| `src/runtime.ts` | Node 与 `betteroffice-mcp` CLI 定位（阶段 1 只做只读探测） |
| `src/tasks.ts` | 任务注册表：会话绑定、open/close/list |
| `src/tools.ts` | 5 个 `betteroffice_*` 工具定义与处理函数 |
| `test/*.test.ts` | 与源码同名的单测 |

---

### Task 1: 脚手架与可加载的插件骨架

**Files:**
- Create: `package.json`, `tsconfig.json`, `cordis.patch.yml`, `.gitignore`
- Create: `src/index.ts`, `src/config.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: 包名 `dsh-betteroffice`；`src/index.ts` 导出 `name: string`、`inject: string[]`、`Config`、`apply(ctx, config?)`；`src/config.ts` 导出 `Config`（schemastery schema）与 `type ConfigData = { workspaceMode: 'auto'|'never'|'always'; cleanupMode: 'off'|'auto'|'on'; nodePath: string; runtimeVersion: string }`。

- [ ] **Step 1: 写 `package.json`**

字段按 Global Constraints；脚本 `"build": "tsc -p tsconfig.json"`、`"test": "node --test --experimental-test-isolation=none \"lib/test/**/*.test.js\""`、`"check": "npm run build && npm test"`；`"files": ["lib", "cordis.patch.yml", "README.md"]`。依赖块：

```jsonc
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.1.0",
  "@deepseek-ai/schemastery": "^3.19.0 || 3.20.0-alpha.1",
  "@deepseek-ai/dsh-mcp-client": "^0.0.1-rc.1",
  "@hyzyn/dsh-kit": "^0.8.1"
},
"devDependencies": {
  "typescript": "~5.9.3",
  "@types/node": "^22",
  "@deepseek-ai/cordis": "^4.1.0",
  "@deepseek-ai/schemastery": "3.20.0-alpha.1",
  "@deepseek-ai/dsh-mcp-client": "^0.0.1-rc.1",
  "@hyzyn/dsh-kit": "^0.8.1"
}
```

- [ ] **Step 2: 写 `tsconfig.json`、`cordis.patch.yml`、`.gitignore`**

tsconfig 按 Global Constraints，`include: ["src/**/*.ts", "test/**/*.ts"]`。`cordis.patch.yml`：

```yaml
- insert:
    - id: betteroffice
      name: 'dsh-betteroffice'
```

- [ ] **Step 3: 安装依赖并确认可编译空工程**

Run: `npm install --cache .scratch/npmcache`
Expected: 安装成功（约 100+ 包）；`npx tsc --version` 输出 `Version 5.9.x`。

- [ ] **Step 4: 写失败测试 `test/smoke.test.ts`**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../src/index.js'

test('插件导出 name/inject/apply', () => {
  assert.equal(plugin.name, 'betteroffice')
  assert.deepEqual(plugin.inject, [])
  assert.equal(typeof plugin.apply, 'function')
})
```

- [ ] **Step 5: 运行确认失败**

Run: `npm run build`
Expected: FAIL，`error TS2307: Cannot find module '../src/index.js'`（文件还不存在。

- [ ] **Step 6: 写 `src/config.ts` 与 `src/index.ts` 最小实现**

`src/config.ts`：

```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  workspaceMode: z.union([z.const('auto'), z.const('never'), z.const('always')]).default('auto').volatile()
    .description('是否使用工作文件夹：自动（由 agent 决定）/ 不使用 / 强制使用'),
  cleanupMode: z.union([z.const('off'), z.const('auto'), z.const('on')]).default('auto').volatile()
    .description('工作完成后删除工作文件夹：禁用 / 自动 / 开启'),
  nodePath: z.string().default('').volatile().description('Node.js 可执行文件路径（留空自动检测，需 ≥22.12.0）'),
  runtimeVersion: z.string().default('').volatile().description('要使用的 betteroffice-mcp 私有版本（留空用默认）'),
})
export type ConfigData = { workspaceMode: 'auto'|'never'|'always'; cleanupMode: 'off'|'auto'|'on'; nodePath: string; runtimeVersion: string }
```

`src/index.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { plainConfig } from '@hyzyn/dsh-kit'
import { Config, type ConfigData } from './config.js'

export const name = 'betteroffice'
export const inject: string[] = []
export { Config }

export function apply(ctx: Context, config?: ConfigData): void {
  const resolved = plainConfig(config as ConfigData)
  void resolved
}
```

- [ ] **Step 7: 运行编译与测试确认通过**

Run: `npm run build && npm test`
Expected: 编译无错；`# pass 1`。

- [ ] **Step 8: 提交**

```bash
git add package.json tsconfig.json cordis.patch.yml .gitignore src test
git commit -m "chore: 脚手架与可加载的插件骨架"
```

---

### Task 2: 配置默认值与归一化

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Config`。
- Produces: `resolveConfig(raw: unknown): ConfigData` —— 解析 senschema 默认值并收窄类型；对非法值抛 `TypeError`（消息中文）。

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'

test('空配置得到默认值', () => {
  assert.deepEqual(resolveConfig(undefined), { workspaceMode: 'auto', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' })
})
test('非法枚举值被拒绝', () => {
  assert.throws(() => resolveConfig({ workspaceMode: 'yes' }), /workspaceMode/)
})
test('已知字段被保留', () => {
  assert.equal(resolveConfig({ nodePath: 'C:/node/node.exe' }).nodePath, 'C:/node/node.exe')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，`resolveConfig is not a function` 或编译报错。

- [ ] **Step 3: 实现 `resolveConfig`**

`export function resolveConfig(raw: unknown): ConfigData` —— 走 `Config(raw)`（schemastery 会填默认并校验），字段逐一取出返回新对象；校验失败时把 schemastery 的错误原文包进中文 `TypeError`（含字段名）。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: 配置默认值与归一化"
```

---

### Task 3: 工作文件夹命名器

**Files:**
- Create: `src/workspace.ts`
- Test: `test/workspace-name.test.ts`

**Interfaces:**
- Produces: `formatStamp(at: Date): string`（`YYMMDD-HHmmss`，本地时间）；`workspaceDirName(sourceFileName: string, taskId: string, at: Date): string`；常量 `WORKSPACE_PREFIX = 'dsh-'`、`MAX_NAME_BYTES = 200`。

- [ ] **Step 1: 写失败测试**（覆盖 Review Focus 1 的命名一半与中文/超长/非法字符）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatStamp, workspaceDirName } from '../src/workspace.js'

const at = new Date(2026, 10, 27, 14, 41, 26) // 2026-11-27 14:41:26 本地时间
const id = 'a71c2e90'

test('时间戳格式为 YYMMDD-HHmmss', () => {
  assert.equal(formatStamp(at), '261127-144126')
})
test('中文文件名与扩展名保留', () => {
  assert.equal(workspaceDirName('年度报告.docx', id, at), 'dsh-年度报告.docx-261127-144126-a71c2e90')
})
test('非法字符被剔除且不留尾随空格/点', () => {
  assert.equal(workspaceDirName('a<>:"/\\|?*b .docx ', id, at), 'dsh-a_b .docx-261127-144126-a71c2e90')
})
test('超长名被截断但保留扩展名与后缀，总字节数不超上限', () => {
  const name = workspaceDirName('长'.repeat(200) + '.docx', id, at)
  assert.ok(Buffer.byteLength(name, 'utf8') <= 200)
  assert.ok(name.startsWith('dsh-长'))
  assert.ok(name.endsWith(`-261127-144126-${id}`))
  assert.ok(name.includes('.docx-'))
})
test('同一秒同名文档靠任务 id 区分', () => {
  const a = workspaceDirName('同名.docx', 'aaaaaaaa', at)
  const b = workspaceDirName('同名.docx', 'bbbbbbbb', at)
  assert.notEqual(a, b)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，找不到模块 `../src/workspace.js`。

- [ ] **Step 3: 实现命名器**

要点：非法字符集合 `<>:"/\|?*` 与控制字符替换为 `_`；去空格/点结尾；截断时按字节从「原始文件名主体」裁剪（保留扩展名与 `-stamp-id` 尾部），裁剪后不得以点或空格结尾；`MAX_NAME_BYTES` 用 `Buffer.byteLength` 校验。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/workspace.ts test/workspace-name.test.ts
git commit -m "feat: 工作文件夹命名器"
```

---

### Task 4: 独占创建工作文件夹与台账

**Files:**
- Modify: `src/workspace.ts`
- Create: `src/errors.ts`
- Test: `test/workspace-create.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `workspaceDirName`。
- Produces: `type TaskLedger = { taskId: string; sessionId: string; sourcePath: string; sourceHash: string; mode: 'read'|'edit'; rootKind: 'parent'|'temp'|'workspace'; workspaceDir: string | null; createdAt: string; status: 'open'|'closed'; mcpVersion: string }`；`createWorkspace(opts: { sourcePath: string; taskId: string; at: Date; ledger: TaskLedger }): Promise<{ dir: string; draftDir: string; checkpointsDir: string; ledgerPath: string }>`；`readLedger(dir: string): Promise<TaskLedger>`；错误类 `WorkspaceExistsError`（`code: 'workspace-exists'`）。

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspace, readLedger } from '../src/workspace.js'

const ledger = (taskId: string, sourcePath: string) => ({
  taskId, sessionId: 's1', sourcePath, sourceHash: 'sha256:x', mode: 'edit' as const,
  rootKind: 'workspace' as const, workspaceDir: null, createdAt: '2026-11-27T14:41:26.000Z',
  status: 'open' as const, mcpVersion: '0.4.0',
})

test('创建 draft/ 与 checkpoints/ 并写入可回读的台账', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  const source = join(base, '报告.docx'); await writeFile(source, 'x')
  const dir = join(base, 'dsh-报告.docx-261127-144126-a71c2e90')
  const ws = await createWorkspace({ sourcePath: source, taskId: 'a71c2e90', at: new Date(2026,10,27,14,41,26), ledger: ledger('a71c2e90', source) })
  assert.equal(ws.dir, dir)
  assert.equal((await readLedger(ws.dir)).taskId, 'a71c2e90')
})

test('同名目录已存在时失败而不接管', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  const source = join(base, '报告.docx'); await writeFile(source, 'x')
  const dir = join(base, 'dsh-报告.docx-261127-144126-a71c2e90')
  await createWorkspace({ sourcePath: source, taskId: 'a71c2e90', at: new Date(2026,10,27,14,41,26), ledger: ledger('a71c2e90', source) })
  await assert.rejects(
    () => createWorkspace({ sourcePath: source, taskId: 'a71c2e90', at: new Date(2026,10,27,14,41,26), ledger: ledger('a71c2e90', source) }),
    (e: any) => e.code === 'workspace-exists',
  )
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，`createWorkspace is not a function`。

- [ ] **Step 3: 实现**

`createWorkspace`：`mkdir(dir)`（**不加 recursive**）→ 失败且 `EEXIST` 时抛 `WorkspaceExistsError`；再 `mkdir(draftDir)`、`mkdir(checkpointsDir)`；台账写 `.betteroffice-task.json`（`JSON.stringify(ledger, null, 2)`）。`readLedger` 读取并 `JSON.parse`，缺失时抛 `WorkspaceExistsError` 之外的 `Error('台账缺失: ...')`。`src/errors.ts` 定义 `class DomainError extends Error { code: string }` 及 `WorkspaceExistsError`。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/workspace.ts src/errors.ts test/workspace-create.test.ts
git commit -m "feat: 工作文件夹独占创建与台账"
```

---

### Task 5: 路径解析与身份校验

**Files:**
- Create: `src/paths.ts`
- Modify: `src/errors.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: `DomainError`。
- Produces: `type ResolvedDoc = { absPath: string; realPath: string; dir: string; name: string; ext: '.docx'|'.xlsx'|'.pptx'; size: number; sha256: string }`；`resolveDocumentPath(input: string, cwd: string): Promise<ResolvedDoc>`；`sha256File(path: string): Promise<string>`；错误 `code: 'not-found' | 'unsupported-format' | 'path-redirected' | 'not-a-file'`。

- [ ] **Step 1: 写失败测试**（覆盖 Review Focus 2、3）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDocumentPath } from '../src/paths.js'

test('相对路径按 cwd 解析并返回 sha256', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  await writeFile(join(base, 'a.docx'), 'hello')
  const doc = await resolveDocumentPath('a.docx', base)
  assert.equal(doc.name, 'a.docx')
  assert.equal(doc.ext, '.docx')
  assert.equal(doc.size, 5)
  assert.match(doc.sha256, /^[0-9a-f]{64}$/)
})
test('含 .. 的路径解析到同一真实文件', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  await mkdir(join(base, 'sub'))
  await writeFile(join(base, 'a.docx'), 'hello')
  const doc = await resolveDocumentPath(join('sub', '..', 'a.docx'), base)
  assert.equal(doc.realPath, await (await import('node:fs/promises')).realpath(join(base, 'a.docx')))
})
test('目录联接指向别处时拒绝', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  const target = join(base, 'real'); await mkdir(target)
  await writeFile(join(target, 'a.docx'), 'x')
  await symlink(target, join(base, 'link'), 'junction')
  await assert.rejects(() => resolveDocumentPath(join('link', 'a.docx'), base), (e: any) => e.code === 'path-redirected')
})
test('不支持的后缀被拒绝', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  await writeFile(join(base, 'a.txt'), 'x')
  await assert.rejects(() => resolveDocumentPath('a.txt', base), (e: any) => e.code === 'unsupported-format')
})
test('不存在给出 not-found', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bo-'))
  await assert.rejects(() => resolveDocumentPath('nope.docx', base), (e: any) => e.code === 'not-found')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

流程：`resolve(cwd, input)` → `stat`（不存在 → `not-found`；非文件 → `not-a-file`）→ 后缀白名单（`.docx/.xlsx/.pptx` 小写比较）→ `realpath()`，与 `resolve()` 结果比较：不一致即 `path-redirected`（同时覆盖符号链接与 junction）→ `sha256File` 流式哈希。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/paths.ts src/errors.ts test/paths.test.ts
git commit -m "feat: 路径解析与身份校验"
```

---

### Task 6: root 决策矩阵

**Files:**
- Create: `src/root.ts`
- Test: `test/root.test.ts`

**Interfaces:**
- Consumes: `ResolvedDoc`（Task 5）、`ConfigData`（Task 2）。
- Produces: `type RootPlan = { root: string; readOnly: boolean; args: string[]; allowedTools?: string[]; rootKind: 'parent'|'temp'|'workspace' }`；`READONLY_EXCLUDED_TOOLS: string[]`（`['office_files']`）；`planRoot(input: { doc: ResolvedDoc; mode: 'read'|'edit'; config: ConfigData; tempDir: string; workspaceDir: string | null; workspaceRequested?: boolean }): RootPlan`。

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { planRoot, READONLY_EXCLUDED_TOOLS } from '../src/root.js'

const doc = { absPath: 'C:/d/a.docx', realPath: 'C:/d/a.docx', dir: 'C:/d', name: 'a.docx', ext: '.docx' as const, size: 1, sha256: 'x' }
const cfg = { workspaceMode: 'auto' as const, cleanupMode: 'auto' as const, nodePath: '', runtimeVersion: '' }
const base = { doc, config: cfg, tempDir: 'C:/tmp/bo-1', workspaceDir: null }

test('只读用父目录并带 --read-only', () => {
  const p = planRoot({ ...base, mode: 'read' })
  assert.equal(p.root, 'C:/d')
  assert.equal(p.readOnly, true)
  assert.deepEqual(p.args, ['--root', 'C:/d', '--read-only'])
  assert.deepEqual(p.allowedTools, READONLY_EXCLUDED_TOOLS.filter(t => t !== 'office_files'))
})
test('编辑且不使用工作文件夹用临时目录', () => {
  const p = planRoot({ ...base, mode: 'edit', config: { ...cfg, workspaceMode: 'never' } })
  assert.equal(p.rootKind, 'temp')
  assert.equal(p.root, 'C:/tmp/bo-1')
  assert.equal(p.readOnly, false)
})
test('编辑且强制使用工作文件夹必须有工作文件夹', () => {
  assert.throws(() => planRoot({ ...base, mode: 'edit', config: { ...cfg, workspaceMode: 'always' } }), /工作文件夹/)
})
test('自动模式下 agent 要求工作文件夹即使用', () => {
  const p = planRoot({ ...base, mode: 'edit', workspaceDir: 'C:/d/dsh-a.docx-1-x', workspaceRequested: true })
  assert.equal(p.rootKind, 'workspace')
  assert.equal(p.root, 'C:/d/dsh-a.docx-1-x')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

决策顺序：`mode==='read'` → parent；否则 `workspaceMode==='always'` 或（`'auto'` 且 `workspaceRequested === true`）→ workspace（无 `workspaceDir` 则抛中文错误）；否则 temp。`args` 始终为 `['--root', root]`，只读追加 `--read-only`；`allowedTools` 仅只读时给出（等于 `READONLY_EXCLUDED_TOOLS` 的补集，由调用方按全量工具名过滤，本 Task 只固定排除项常量）。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/root.ts test/root.test.ts
git commit -m "feat: root 决策矩阵"
```

---

### Task 7: MCP 挂载器

**Files:**
- Create: `src/mount.ts`
- Modify: `src/errors.ts`
- Test: `test/mount.test.ts`

**Interfaces:**
- Consumes: `DomainError`。
- Produces: `type MountSpec = { serverName: string; command: string; args: string[]; cwd: string }`；`type MountHandle = { serverName: string; dispose(): Promise<void> }`；`createMounter(deps: { loadClient: () => Promise<McpClientModule | undefined>; logger?: (msg: string, err?: unknown) => void }): { mount(scope: unknown, spec: MountSpec): Promise<MountHandle>; has(scope: unknown, serverName: string): boolean }`；`type McpClientModule = { apply: unknown }`；错误 `code: 'mcp-unavailable' | 'mcp-start-failed'`。

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMounter, type McpClientModule } from '../src/mount.js'

function fakeScope() {
  const calls: any[] = []
  return { calls, plugin(mod: any, cfg: any) { calls.push({ mod, cfg }); let disposed = false; return { dispose: async () => { disposed = true; calls.push({ disposed: true }) } } } }
}
const fakeClient: McpClientModule = { apply() {} }

test('挂载传入正确的 dsh-mcp-client 配置', async () => {
  const scope = fakeScope()
  const mounter = createMounter({ loadClient: async () => fakeClient })
  await mounter.mount(scope, { serverName: 'bo_a71c2e90', command: 'node', args: ['cli.js', '--root', 'C:/d'], cwd: 'C:/d' })
  assert.equal(scope.calls[0].cfg.serverName, 'bo_a71c2e90')
  assert.equal(scope.calls[0].cfg.transport, 'stdio')
  assert.equal(scope.calls[0].cfg.failOnStartupError, true)
})
test('同一 scope 同名重复挂载只挂一次', async () => {
  const scope = fakeScope()
  const mounter = createMounter({ loadClient: async () => fakeClient })
  await mounter.mount(scope, { serverName: 's1', command: 'node', args: [], cwd: 'C:/d' })
  await mounter.mount(scope, { serverName: 's1', command: 'node', args: [], cwd: 'C:/d' })
  assert.equal(scope.calls.filter(c => c.cfg).length, 1)
})
test('dispose 释放 fiber 且 has 变为 false', async () => {
  const scope = fakeScope()
  const mounter = createMounter({ loadClient: async () => fakeClient })
  const h = await mounter.mount(scope, { serverName: 's1', command: 'node', args: [], cwd: 'C:/d' })
  await h.dispose()
  assert.equal(mounter.has(scope, 's1'), false)
  assert.ok(scope.calls.some(c => c.disposed))
})
test('客户端不可用时给出 mcp-unavailable', async () => {
  const mounter = createMounter({ loadClient: async () => undefined })
  await assert.rejects(() => mounter.mount(fakeScope(), { serverName: 's1', command: 'node', args: [], cwd: 'C:/d' }), (e: any) => e.code === 'mcp-unavailable')
})
test('启动异常转为 mcp-start-failed 且已 dispose', async () => {
  const scope = fakeScope()
  const mounter = createMounter({ loadClient: async () => ({ apply() {} }) })
  scope.plugin = (mod: any, cfg: any) => { scope.calls.push({ mod, cfg }); return { dispose: async () => { scope.calls.push({ disposed: true }); throw new Error('boom') } } }
  await assert.rejects(() => mounter.mount(scope, { serverName: 's1', command: 'node', args: [], cwd: 'C:/d' }), (e: any) => e.code === 'mcp-start-failed' || e.code === 'mcp-unavailable')
  assert.ok(scope.calls.some(c => c.disposed))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`mount()`：查 `WeakMap<scope, Map<serverName, Promise<MountHandle>>>` 幂等；`loadClient()` 返回 `undefined` → `McpUnavailableError`；`scope.plugin(client, { serverName, transport: 'stdio', command, args, cwd, failOnStartupError: true })` 得到 fiber；`dispose()` 调 `fiber.dispose?.()` 并从表里移除，**吞掉 dispose 的异常但记日志**（避免 agent 销毁序列被打断）。挂载抛错时先 dispose 再抛 `McpStartFailedError`。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/mount.ts src/errors.ts test/mount.test.ts
git commit -m "feat: 按 scope 挂载 MCP 的封装"
```

---

### Task 8: 运行时探测（Node 与 CLI 定位）

**Files:**
- Create: `src/runtime.ts`
- Modify: `src/errors.ts`
- Test: `test/runtime.test.ts`

**Interfaces:**
- Consumes: `ConfigData`、`DomainError`、`dshHome()`（`@hyzyn/dsh-kit`）。
- Produces: `MIN_NODE_VERSION = '22.12.0'`；`compareVersions(a: string, b: string): number`；`satisfiesNode(version: string): boolean`；`cliPathFor(home: string, version: string): string`（`<home>/betteroffice/runtime/<version>/node_modules/@betteroffice/agents/dist/cli.js`）；`findNodeOnPath(env: { PATH?: string }, exists: (p: string) => boolean, sep: string): string[]`；`resolveMcpRuntime(input: { config: ConfigData; home: string; nodeVersion: string; exists(p: string): boolean; env: { PATH?: string }; sep: string }): { command: string; cliPath: string }`，失败抛 `RuntimeUnavailableError`（`code: 'runtime-unavailable'`），消息包含具体原因（缺 Node / Node 版本过低 / 未安装 betteroffice-mcp）。

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { cliPathFor, compareVersions, findNodeOnPath, satisfiesNode, resolveMcpRuntime, MIN_NODE_VERSION } from '../src/runtime.js'

const cfg = { workspaceMode: 'auto' as const, cleanupMode: 'auto' as const, nodePath: '', runtimeVersion: '' }

test('版本比较与 22.12.0 下限', () => {
  assert.equal(compareVersions('22.12.0', '22.9.0'), 1)
  assert.equal(satisfiesNode('22.11.9'), false)
  assert.equal(satisfiesNode('22.12.0'), true)
  assert.equal(satisfiesNode('24.22.1'), true)
  assert.equal(MIN_NODE_VERSION, '22.12.0')
})
test('CLI 路径按 home/版本拼接', () => {
  assert.equal(cliPathFor('C:/h', '0.4.0'), 'C:\\h\\betteroffice\\runtime\\0.4.0\\node_modules\\@betteroffice\\agents\\dist\\cli.js'.replace(/\\/g, require('node:path').sep))
})
test('PATH 中找不到 node 时给出缺 Node 原因', () => {
  assert.throws(() => resolveMcpRuntime({ config: cfg, home: 'C:/h', nodeVersion: '24.0.0', exists: () => false, env: { PATH: 'C:/empty' }, sep: ';' }), /未找到 Node/)
})
test('Node 版本过低时报出版本', () => {
  const exists = (p: string) => p.includes('node.exe') || p.includes('cli.js')
  assert.throws(() => resolveMcpRuntime({ config: cfg, home: 'C:/h', nodeVersion: '20.0.0', exists, env: { PATH: 'C:/n' }, sep: ';' }), /22\.12\.0/)
})
test('私有 CLI 不存在时提示去配置页安装', () => {
  assert.throws(() => resolveMcpRuntime({ config: cfg, home: 'C:/h', nodeVersion: '24.0.0', exists: (p) => p.includes('node.exe'), env: { PATH: 'C:/n' }, sep: ';' }), /安装/)
})
test('配置了 nodePath 时优先使用', () => {
  const r = resolveMcpRuntime({
    config: { ...cfg, nodePath: 'C:/custom/node.exe', runtimeVersion: '0.4.0' }, home: 'C:/h', nodeVersion: '24.0.0',
    exists: (p) => p === 'C:/custom/node.exe' || p.includes('cli.js'), env: { PATH: '' }, sep: ';',
  })
  assert.equal(r.command, 'C:/custom/node.exe')
})
test('PATH 扫描返回候选 node 可执行文件', () => {
  const exists = (p: string) => p.endsWith('node.exe')
  assert.deepEqual(findNodeOnPath({ PATH: 'C:/a;C:/b' }, exists, ';'), ['C:\\a\\node.exe', 'C:\\b\\node.exe'].map(p => p.replace(/\\/g, require('node:path').sep)))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

全部为纯函数（不 `spawn`，Node 版本由调用方传入，保证可测）。`resolveMcpRuntime` 顺序：node 命令（配置优先，否则 PATH 扫描首个）→ 版本校验 → CLI 路径存在性校验（`runtimeVersion` 为空时读 `<home>/betteroffice/runtime/default` 文本，不存在则报「未安装，请到 设置 → 插件配置 → BetterOffice 点安装」）→ 返回 `{ command, cliPath }`。三条失败消息都要中文且可行动。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/runtime.ts src/errors.ts test/runtime.test.ts
git commit -m "feat: 运行时探测与可行动错误"
```

---

### Task 9: 任务注册表

**Files:**
- Create: `src/tasks.ts`
- Modify: `src/errors.ts`
- Test: `test/tasks.test.ts`

**Interfaces:**
- Consumes: `planRoot`（Task 6）、`createMounter`（Task 7）、`createWorkspace`/`readLedger`（Task 4）、`resolveDocumentPath`（Task 5）。
- Produces: `type TaskRecord = { taskId: string; sessionId: string; serverName: string; doc: ResolvedDoc; root: string; readOnly: boolean; workspaceDir: string | null; createdAt: number }`；`createTaskRegistry(deps: { mounter: Mounter; resolveRuntime(): { command: string; cliPath: string }; config(): ConfigData; makeTempDir(taskId: string): Promise<string>; workspaceDirFor(doc: ResolvedDoc, taskId: string): string; now(): Date; newTaskId(): string }): { open(scope: unknown, sessionId: string, input: { path: string; cwd: string; mode?: 'read'|'edit'; workspace?: boolean }): Promise<TaskRecord>; close(scope: unknown, sessionId: string, taskId: string): Promise<void>; list(sessionId: string): TaskRecord[]; get(sessionId: string, taskId: string): TaskRecord }`；错误 `code: 'task-not-found' | 'task-foreign'`。

- [ ] **Step 1: 写失败测试**（覆盖 Review Focus 4、5）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskRegistry } from '../src/tasks.js'

function harness() {
  const mounted: string[] = []; const disposed: string[] = []
  const mounter = { mount: async (_s: unknown, spec: any) => { mounted.push(spec.serverName); return { serverName: spec.serverName, dispose: async () => { disposed.push(spec.serverName) } } }, has: () => true }
  const reg = createTaskRegistry({
    mounter: mounter as any,
    resolveRuntime: () => ({ command: 'node', cliPath: 'C:/h/cli.js' }),
    config: () => ({ workspaceMode: 'never', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' }),
    makeTempDir: async () => 'C:/tmp/bo-x',
    workspaceDirFor: () => 'C:/d/dsh-a.docx-1-x',
    now: () => new Date(2026, 10, 27, 14, 41, 26),
    newTaskId: () => 'a71c2e90',
    resolveDocument: async (p: string, cwd: string) => ({ absPath: cwd + '/' + p, realPath: cwd + '/' + p, dir: cwd, name: p, ext: '.docx' as const, size: 1, sha256: 'sha256:x' }),
  })
  return { reg, mounted, disposed }
}

test('只读打开挂载 bo_<id8> 且返回任务', async () => {
  const { reg, mounted } = harness()
  const t = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  assert.equal(t.serverName, 'bo_a71c2e90')
  assert.equal(t.readOnly, true)
  assert.deepEqual(mounted, ['bo_a71c2e90'])
})
test('关闭时释放挂载并标记任务不可再用', async () => {
  const { reg, disposed } = harness()
  const t = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  await reg.close({}, 's1', t.taskId)
  assert.deepEqual(disposed, ['bo_a71c2e90'])
  assert.throws(() => reg.get('s1', t.taskId), (e: any) => e.code === 'task-not-found')
})
test('别的会话用同一 taskId 被拒', async () => {
  const { reg } = harness()
  const t = await reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' })
  assert.throws(() => reg.get('s2', t.taskId), (e: any) => e.code === 'task-foreign')
})
test('MCP 挂载失败时不留下任务记录', async () => {
  const { reg } = harness()
  ;(reg as any).__failMount = true
  await assert.rejects(() => reg.open({}, 's1', { path: 'a.docx', cwd: 'C:/d' }))
  assert.deepEqual(reg.list('s1'), [])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`open()`：`resolveDocumentPath` → `planRoot` → 需要时建临时目录/工作文件夹 → `resolveRuntime()` → `mounter.mount(scope, { serverName: 'bo_' + taskId, command, args: [cliPath, ...plan.args], cwd: root })` → 成功后登记记录；任一步失败都要回滚（已建目录/已挂载 fiber）。`get()` 先按 taskId 找，找不到 `task-not-found`；找到但 `sessionId` 不符 → `task-foreign`。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/tasks.ts src/errors.ts test/tasks.test.ts
git commit -m "feat: 任务注册表与会话绑定"
```

---

### Task 10: 5 个 agent 工具

**Files:**
- Create: `src/tools.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `TaskRegistry`（Task 9）。
- Produces: `TOOL_NAMES = ['betteroffice_open','betteroffice_list','betteroffice_checkpoint','betteroffice_deliver','betteroffice_close']`；`createToolDefinitions(deps: { registry: TaskRegistry; sessionId: string; config(): ConfigData }): Array<{ name: string; description: string; parameters: unknown; output: { schema: unknown; render: (value: unknown) => string } }>`；`registerTools(agentTools: { register(def: any): unknown }, deps): void`。

- [ ] **Step 1: 写失败测试**（覆盖 Review Focus 5）

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_NAMES, createToolDefinitions, registerTools } from '../src/tools.js'

const registry: any = {
  open: async () => ({ taskId: 'a71c2e90', serverName: 'bo_a71c2e90', root: 'C:/d', readOnly: true, doc: { name: 'a.docx' } }),
  close: async () => {}, list: () => [],
}
const cfg = () => ({ workspaceMode: 'auto', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' }) as any

test('定义 5 个工具且每个都带可渲染的 output', () => {
  const defs = createToolDefinitions({ registry, sessionId: 's1', config: cfg })
  assert.deepEqual(defs.map(d => d.name), TOOL_NAMES)
  for (const d of defs) {
    assert.equal(typeof d.output.render, 'function')
    assert.equal(typeof d.output.schema, 'object')
    assert.equal(typeof d.description, 'string')
  }
})
test('open 工具返回任务信息文本', async () => {
  const defs = createToolDefinitions({ registry, sessionId: 's1', config: cfg })
  const open = defs[0] as any
  const out = await open.execute({ path: 'a.docx' })
  assert.match(open.output.render(out), /a71c2e90/)
})
test('close 传别人的 taskId 时把 task-foreign 作为工具错误暴露', async () => {
  const defs = createToolDefinitions({ registry: { ...registry, close: async () => { const e: any = new Error('无权'); e.code = 'task-foreign'; throw e } }, sessionId: 's1', config: cfg })
  const close = defs.find(d => d.name === 'betteroffice_close') as any
  await assert.rejects(() => close.execute({ task: 'zzz' }), /无权/)
})
test('registerTools 把定义逐个注册', () => {
  const got: string[] = []
  registerTools({ register: (d: any) => { got.push(d.name) } }, { registry, sessionId: 's1', config: cfg })
  assert.deepEqual(got, TOOL_NAMES)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

每个定义：`name`、中文 `description`（写清「路径只在 open 时给」「不要直接调用 mcp__ 工具做交付」）、`parameters`（手写 JSON Schema 对象）、`output: { schema: {...}, render: (v) => JSON.stringify(v, null, 2) }`、`execute`/`run` 字段沿用宿主工具定义的约定（实现时以 `dsh-tools` 的 `ToolDefinition` 类型为准，若类型不可导入则用局部结构化类型）。`betteroffice_open` 的 `sessionId` 来自闭包，**不接受**调用方传 session。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: 5 个 betteroffice 工具"
```

---

### Task 11: 插件装配（agent 生命周期）

**Files:**
- Modify: `src/index.ts`
- Test: `test/plugin.test.ts`

**Interfaces:**
- Consumes: 全部前置模块。
- Produces: `apply(ctx, config)` 的完整行为：解析配置 → 建 mounter/registry → 订阅 `agent/created`（注册工具）与 `agent/disposed`（关闭该 agent 的全部任务）→ `ctx.effect` 注册总清理。

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'

test('apply 订阅 agent 生命周期并在销毁时清理', () => {
  const listeners: Record<string, Function[]> = {}
  const cleanups: Array<() => void> = []
  const ctx = {
    on(ev: string, fn: Function) { (listeners[ev] ??= []).push(fn); return () => {} },
    effect(fn: () => (() => void) | void) { const c = fn(); if (typeof c === 'function') cleanups.push(c); return () => {} },
    get() { return undefined },
    inject(_deps: string[], fn: Function) { fn(ctx) },
  }
  apply(ctx as any, undefined)
  assert.ok(listeners['agent/created']?.length)
  assert.ok(listeners['agent/disposed']?.length)
  assert.ok(cleanups.length > 0)
})
test('apply 在没有任何服务时也不抛错', () => {
  const ctx = { on: () => () => {}, effect: (fn: any) => { fn(); return () => {} }, get: () => undefined, inject: (_d: string[], fn: any) => fn(ctx) }
  assert.doesNotThrow(() => apply(ctx as any, undefined))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && npm test`
Expected: FAIL（`apply` 目前是空实现，未订阅事件）。

- [ ] **Step 3: 实现装配**

- `inject: []` 保持不变（宿主无 agents 服务时插件仍可加载）。
- `agent/created` 回调里**不 await**：同步登记 agent，异步 `agent.ctx` 上注册工具；失败只记日志（该事件是串行派发）。
- 工具注册用 `agent.ctx.tools.register`，若 `tools` 服务不存在则记一条中文日志并跳过。
- `agent/disposed` 回调关闭该 agent 的所有任务（best-effort，逐个吞错并记日志）。
- 顶层 `ctx.effect(() => () => { /* 关闭所有任务 */ }, 'betteroffice.lifecycle')`。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test`
Expected: 全部 pass。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: 插件装配与 agent 生命周期"
```

---

### Task 12: 端到端只读验收与文档

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/plans/2026-11-28-betteroffice-plugin.md` 已存在（本文件，无需改）

**Interfaces:**
- Consumes: 全部前置。
- Produces: 可复现的手工验收步骤与结论。

- [ ] **Step 1: 打包并装进本机 profile（临时验证）**

Run: `npm pack` → 在 `C:\Users\KUAI\.dsh\profiles\desktop` 下按 DSH 插件安装方式安装该 tarball（或用 profile 的插件管理页安装）。
Expected: 插件出现在 `设置 → 插件配置 → BetterOffice`，三个开关可改并持久化。

- [ ] **Step 2: 手工跑一遍只读流**

在一个 DSH 会话里准备一个 `.docx`，让 agent：`betteroffice_open(path, mode='read')` → 用 `mcp__bo_*__office_outline` 读结构 → `betteroffice_close`。
Expected：能读到目录结构；**源文件哈希与打开前一致**（`Get-FileHash` 比对）；关闭后 `mcp__bo_*` 工具不再可用；无 MCP 子进程残留。

- [ ] **Step 3: 缺运行时时给可行动错误**

把私有运行时目录临时改名后再 `betteroffice_open`。
Expected: 返回中文错误，明确指向「设置 → 插件配置 → BetterOffice → 安装」，会话不卡死、不留子进程。

- [ ] **Step 4: 更新 README 的当前状态段**

把「设计阶段，尚未发布」一段改为「阶段 1 已实现：只读打开与 MCP 挂载；编辑/交付/配置页在后续阶段」，并补一节「当前可用工具」列出 5 个工具与只读限制。

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: 阶段 1 状态与可用工具说明"
```

---

## Self-Review

- **Spec coverage（阶段 0–1 范围）**：§2 架构 → Task 7/9/11；§3 root 矩阵只读与编辑分支 → Task 6；只读工具白名单 → Task 6（`READONLY_EXCLUDED_TOOLS`）+ Task 9 挂载参数；§3 路径与权限检查 → Task 5；§3 相对路径按会话 cwd → Task 5/9；§4 命名与独占创建 → Task 3/4；台账与恢复字段 → Task 4（`TaskLedger`）；§7 Node ≥22.12 与安装缺失提示 → Task 8；agent 工具表面 → Task 10；不暴露任意 MCP 调用/安装接口 → Task 10（只有 5 个工具，无 install/update 工具）。§4.3/§5/§6/§7 的管理动作属于阶段 2–4，已在计划开头声明另起计划。
- **Step scan**：每个 Step 都是单一动作（写测试 / 跑测试 / 写实现 / 跑测试 / 提交），测试块给了名字与断言，实现块给了签名与序列，没有 TBD 式空话。
- **Type consistency**：`ResolvedDoc`（Task 5）在 Task 6/9 中同名同字段；`RootPlan`（Task 6）字段在 Task 9 中按 `plan.args`/`plan.root` 使用；`MountSpec`/`MountHandle`（Task 7）在 Task 9 的 `mounter` 依赖里一致；`TaskLedger`（Task 4）字段与 Task 9 的 `TaskRecord` 不混用（前者持久化、后者内存）。
- **Review Focus**：5 条均已挂测试——1 → Task 3 末条 + Task 4 第二条；2 → Task 5 首条（记录 sha256）+ 阶段 2 交付比对（已记入设计稿 §3.4）；3 → Task 5 的 `..` 与 junction 两条；4 → Task 7 末两条 + Task 8 全部 + Task 9 末条；5 → Task 9 的 `task-foreign` + Task 10 的 close 报错。
- **Proportion**：计划长度约等于设计稿的 2 倍，主要是不可省略的测试断言；没有把实现体抄成转录（只有 `config.ts`/`index.ts` 的骨架给了完整代码，因为签名即内容）。
