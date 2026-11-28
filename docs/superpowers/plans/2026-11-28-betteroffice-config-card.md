# BetterOffice 自绘配置卡片 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务实现本计划。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 给 `dsh-betteroffice` 增加一张插件详情页内联的自绘卡片（浏览器半体），把运行时状态、安装、检查更新、更新、回退从 `/betteroffice` 命令搬到图形界面，命令保留不动。

**Architecture:** Host 半体新增两条 HTTP 路由（`/api/betteroffice/status`、`/api/betteroffice/action`），全部经 `admitRoute` 的「回环地址 ∪ 宿主连接鉴权」围栏；动作路由复用已有的 `createInstaller` / `fetchLatestVersion` / `listInstalledRuntimes`，把「安装/更新/回退写回设置」复用 `saveRuntimeVersion`。浏览器半体是一个手写 `client.js`（不引入打包器），通过 `window.__ModuleLoader__.load({id, factory})` 注册一张 React 卡片，只用 `fetch` 调上面两条路由。

**Tech Stack:** TypeScript 5.9（Host 半体，已有 tsc 构建）、`node --test`（已有 144 条测试）、React 18 + `window.__ModuleLoader__`（浏览器半体，手写、无构建）、`@hyzyn/dsh-kit` 的 `admitRoute`/`writeJson`/`readJsonBody`。

**Spec:** `docs/superpowers/specs/2026-11-28-betteroffice-plugin-design.md` §3.7（运行时管理）、§3.8（配置页与兜底）；实现现状见 `docs/superpowers/plans/2026-11-28-betteroffice-stage3.md`。

## Global Constraints

- 文案全部中文；错误消息必须能告诉用户下一步做什么。
- 不新增任何运行时依赖；不引入打包器（`client.js` 必须是单文件、无 `import`/`require` 之外的东西）。
- 安装/更新/回退只允许由用户点击触发，不注册成 agent 工具，不进 system prompt。
- npm 一律 `--cache <版本目录>/.npm-cache`，不动全局 npm cache 与 PATH。
- 不改写用户的 profile 配置：动作路由写运行时版本只经 `settingsEntryScope(...).update(...)`。
- 现有 `/betteroffice` 命令、6 个 agent 工具、144 条测试必须保持通过。
- 所有新文件保持现有文件风格：JSDoc 中文注释、`DomainError` 带 `code`。

## Review Focus

1. **双击安装**：用户连点两次「安装」，必须只跑一次 npm，第二次复用同一个 Promise（`installer.inFlight` 已有，路由要透出 409 或同结果）。
2. **安装中断页**：安装进行中用户刷新或关掉页面，host 侧安装继续，重新打开卡片应看到「安装中」而不是「未安装」——status 必须暴露 `inFlight`。
3. **越权访问**：非回环来源或没有宿主会话 Cookie 的请求打动作路由，必须 403（`admitRoute` 围栏），不能只做前端隐藏按钮。
4. **版本号注入**：`version` 传 `../x`、`1.0.0/../../etc`、空串必须 400，由已有 `isVersion` 拦下。
5. **网络不可用**：「检查更新」在没网时必须显示中文原因并且按钮恢复可点，不能永久转圈（`registry-unreachable` 已有）。

---

### Task 1: 状态快照纯函数

**Files:**
- Create: `src/control.ts`
- Test: `test/control.test.ts`

**Interfaces:**
- Produces:
  - `export interface StatusSnapshot { node: { version: string; ok: boolean; required: string }; runtime: { configured: string; installed: readonly string[]; cliReady: boolean }; latest: string | null; inFlight: readonly string[]; messages: readonly string[] }`
  - `export function buildStatus(input: { home: string; nodeVersion: string; config: ConfigData; installed: readonly string[]; exists: (path: string) => boolean; latest?: string | null; inFlight?: readonly string[] }): StatusSnapshot`

- [ ] **Step 1: 写失败测试**

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStatus } from '../src/control.js'

const base = { home: 'C:/h', nodeVersion: '24.22.1', config: { workspaceMode: 'auto', cleanupMode: 'auto', nodePath: '', runtimeVersion: '' } }

test('未安装时给出可行动提示', () => {
  const s = buildStatus({ ...base, installed: [], exists: () => false })
  assert.equal(s.runtime.installed.length, 0)
  assert.equal(s.runtime.cliReady, false)
  assert.ok(s.messages.some(m => m.includes('/betteroffice 安装')))
})

test('Node 版本不足时标记 ok=false 并给出最低版本', () => {
  const s = buildStatus({ ...base, nodeVersion: '20.11.0', installed: ['0.4.0'], exists: () => true })
  assert.equal(s.node.ok, false)
  assert.equal(s.node.required, '22.12.0')
})

test('已装版本缺 CLI 入口时提示重装', () => {
  const s = buildStatus({ ...base, config: { ...base.config, runtimeVersion: '0.4.0' }, installed: ['0.4.0'], exists: () => false })
  assert.equal(s.runtime.cliReady, false)
  assert.ok(s.messages.some(m => m.includes('重装')))
})

test('安装中的版本出现在 inFlight', () => {
  const s = buildStatus({ ...base, installed: [], exists: () => false, inFlight: ['0.4.0'] })
  assert.deepEqual(s.inFlight, ['0.4.0'])
})
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm run build`（先看 `error TS2307: Cannot find module '../src/control.js'`）

- [ ] **Step 3: 实现 `buildStatus`**

复用 `src/runtime.ts` 的 `MIN_NODE_VERSION`、`satisfiesNode`、`cliPathFor`。`messages` 按顺序追加：Node 不满足 → 「当前 Node 是 x，BetterOffice 需要 ≥22.12.0」；`config.runtimeVersion === ''` → 「还没有安装运行时，请发送 /betteroffice 安装，或用本卡片下方的「安装」按钮」；有配置版本但 `cliReady === false` → 「运行时目录缺 betteroffice-mcp 入口，请重装该版本」。

- [ ] **Step 4: 跑测试看通过**

Run: `npm run build; if ($LASTEXITCODE -eq 0) { npm test 2>&1 | Select-Object -Last 10 }`，Expected: 新增 4 条 pass，总计 148。

- [ ] **Step 5: 提交**

```bash
git add src/control.ts test/control.test.ts
git commit -m "feat: 配置卡片的状态快照"
```

---

### Task 2: 动作参数校验

**Files:**
- Modify: `src/control.ts`
- Test: `test/control.test.ts`（追加）

**Interfaces:**
- Produces:
  - `export type ControlAction = 'install' | 'check' | 'update' | 'rollback'`
  - `export interface ActionRequest { action: ControlAction; version?: string }`
  - `export function parseAction(raw: unknown): ActionRequest`（非法 → `DomainError('invalid-action', …)`，中文；`version` 存在时必须通过 `isVersion`，否则 `invalid-version`）

- [ ] **Step 1: 写失败测试**

```ts
test('未知动作被拒', () => {
  assert.throws(() => parseAction({ action: 'delete' }), /不认识的操?作|invalid-action/i)
})

test('版本号带路径分隔符被拒', () => {
  assert.throws(() => parseAction({ action: 'install', version: '../x' }), /版本号/)
})

test('rollback 必须带版本', () => {
  assert.throws(() => parseAction({ action: 'rollback' }), /回退需要指定版本/)
})

test('合法请求原样返回', () => {
  assert.deepEqual(parseAction({ action: 'install', version: '0.4.0' }), { action: 'install', version: '0.4.0' })
})
```

- [ ] **Step 2: 跑测试看失败** — Run: `npm run build`，Expected: `TS2305: Module '"../src/control.js"' has no exported member 'parseAction'`

- [ ] **Step 3: 实现 `parseAction`** — `raw` 非对象或 `action` 不在四个值里 → `DomainError('invalid-action', '不认识的操作：…；可用：install / check / update / rollback')`；`rollback` 缺 `version` → 「回退需要指定版本号」；`version` 非空时必须 `isVersion` 通过。

- [ ] **Step 4: 跑测试看通过** — Expected: 152 pass。

- [ ] **Step 5: 提交**

```bash
git add src/control.ts test/control.test.ts
git commit -m "feat: 配置卡片的动作参数校验"
```

---

### Task 3: 路由处理函数（不碰 http 对象）

**Files:**
- Create: `src/routes.ts`
- Test: `test/routes.test.ts`

**Interfaces:**
- Consumes: `buildStatus`、`parseAction`（Task 1、2）；`createInstaller`、`fetchLatestVersion`、`listInstalledRuntimes`、`compareVersions`、`cliPathFor`。
- Produces:
  - `export interface ControlDeps { home: string; nodeVersion: string; getConfig: () => ConfigData; saveRuntimeVersion: (version: string) => Promise<void>; install: (version: string) => Promise<{ version: string; dir: string; cliPath: string }>; latestVersion: () => Promise<string>; installedVersions: () => readonly string[]; exists: (path: string) => boolean; inFlight: () => readonly string[]; logger?: (message: string, error?: unknown) => void }`
  - `export type ApiResult = { status: 200 | 400 | 409 | 500; body: unknown }`
  - `export function createControlApi(deps: ControlDeps): { status(): Promise<ApiResult>; action(raw: unknown): Promise<ApiResult> }`

- [ ] **Step 1: 写失败测试**（用假 deps，`install` 用可控 Promise）

```ts
test('status 返回快照', async () => {
  const api = createControlApi(fakeDeps())
  const r = await api.status()
  assert.equal(r.status, 200)
  assert.equal((r.body as { runtime: { installed: string[] } }).runtime.installed.length, 0)
})

test('install 成功后回写运行时版本并返回 200', async () => {
  const saved: string[] = []
  const api = createControlApi(fakeDeps({ saveRuntimeVersion: async v => { saved.push(v) } }))
  const r = await api.action({ action: 'install', version: '0.4.0' })
  assert.equal(r.status, 200)
  assert.deepEqual(saved, ['0.4.0'])
})

test('非法动作返回 400 且带中文原因', async () => {
  const r = await createControlApi(fakeDeps()).action({ action: 'nope' })
  assert.equal(r.status, 400)
  assert.match(JSON.stringify(r.body), /不认识的操作/)
})

test('同一版本安装中再次请求返回 409', async () => {
  const api = createControlApi(fakeDeps({ inFlight: () => ['0.4.0'] }))
  const r = await api.action({ action: 'install', version: '0.4.0' })
  assert.equal(r.status, 409)
})

test('registry 不可用返回 500 与中文原因', async () => {
  const api = createControlApi(fakeDeps({ latestVersion: async () => { throw new DomainError('registry-unreachable', '拿不到最新版本：网络或代理问题') } }))
  const r = await api.action({ action: 'check' })
  assert.equal(r.status, 500)
  assert.match(JSON.stringify(r.body), /网络或代理/)
})
```

- [ ] **Step 2: 跑测试看失败** — Expected: `TS2307: Cannot find module '../src/routes.js'`

- [ ] **Step 3: 实现 `createControlApi`** — `status` 组装 `buildStatus({...})`；`action` 先 `parseAction`，再按动作分派：`install|update` 调 `deps.install(version ?? await deps.latestVersion())` 后 `await deps.saveRuntimeVersion(result.version)`；`check` 只取 `latestVersion()` 并与 `getConfig().runtimeVersion` 用 `compareVersions` 比较，正文给出「已是最新」或「有新版本 x」；`rollback` 要求 `installedVersions()` 含该版本，否则 400「回退只能选已安装的版本：…」。动作成功正文统一 `{ ok: true, text: '…中文…' }`，失败 `{ ok: false, error: message }`。

- [ ] **Step 4: 跑测试看通过** — Expected: 157 pass。

- [ ] **Step 5: 提交**

```bash
git add src/routes.ts test/routes.test.ts
git commit -m "feat: 配置卡片的 HTTP 动作层"
```

---

### Task 4: 挂到 webServer 路由并加围栏

**Files:**
- Modify: `src/routes.ts`
- Test: `test/routes.test.ts`（追加）

**Interfaces:**
- Produces: `export function registerControlRoutes(input: { web: { register: (route: unknown) => readonly (() => void)[] }; api: { status(): Promise<ApiResult>; action(raw: unknown): Promise<ApiResult> }; admitRoute: (ctx: unknown, request: unknown) => { status: number; error: string } | undefined; writeJson: (res: unknown, status: number, body: unknown) => void; readJsonBody: (req: unknown) => Promise<unknown> }): readonly (() => void)[]`
- 路由：`GET /api/betteroffice/status`、`POST /api/betteroffice/action`。

- [ ] **Step 1: 写失败测试**（假 req/res，断言三件事）

```ts
test('非授权来源的动作请求被拒且不调 install', async () => { /* admitRoute 返回 {status:403}，断言 res 写出 403、installed 未变动 */ })
test('授权来源的 POST 走通并写 JSON', async () => { /* body {action:'check'}，断言 res.status 200 且 body.ok === true */ })
test('GET status 在授权下返回快照', async () => {})
```

- [ ] **Step 2: 跑测试看失败** — Expected: `TS2305 ... has no exported member 'registerControlRoutes'`

- [ ] **Step 3: 实现** — `web.register({ method: 'GET', path: '/api/betteroffice/status', handler })` 与 `{ method: 'POST', path: '/api/betteroffice/action', handler }`；两个 handler 第一行都 `const rejection = admitRoute(ctx, request); if (rejection !== undefined) { writeJson(res, rejection.status, { ok: false, error: rejection.error }); return }`；动作 handler 用 `readJsonBody(request)`，`undefined` → 400「请求体不是合法 JSON」。

- [ ] **Step 4: 跑测试看通过** — Expected: 160 pass。

- [ ] **Step 5: 提交**

```bash
git add src/routes.ts test/routes.test.ts
git commit -m "feat: betteroffice 配置接口的 web 路由与访问围栏"
```

---

### Task 5: 宿主装配

**Files:**
- Modify: `src/index.ts`
- Test: `test/plugin.test.ts`（追加）

**Interfaces:**
- Consumes: `registerControlRoutes`、`createControlApi`、`createInstaller`（经 `createCommandDeps` 已有的装配）、`dshHome()`、`dsh-kit` 的 `admitRoute`/`writeJson`/`readJsonBody`。

- [ ] **Step 1: 写失败测试**（fake `host` 记录 `inject` 名与 `web.register` 调用；断言注册了 `webServer` 且拿到两条路由）

- [ ] **Step 2: 跑测试看失败** — Expected: 断言失败（`webServer` 未被 inject）。

- [ ] **Step 3: 实现** — 在 `apply` 里现有 `host.inject?.(['commands', 'settings'], …)` 之后加一段 `host.inject?.(['webServer'], scoped => { … })`：取 `scoped.get('webServer') ?? host.get('webServer')`，无 `register` 就 `log('betteroffice: 宿主没有 webServer，配置卡片不可用')` 并返回；否则 `createControlApi({ home: dshHome(), nodeVersion: process.versions.node, getConfig: currentConfig, saveRuntimeVersion, install: version => createInstaller({...}).install(version), latestVersion: () => fetchLatestVersion(), installedVersions: () => listInstalledRuntimes(dshHome(), { readdir: readdirSync, exists: existsSync }), exists: existsSync, inFlight: () => [...installerInFlight] , logger: log })`，再 `scoped.effect?.(() => disposeAll, 'betteroffice.routes')`。

- [ ] **Step 4: 跑测试看通过** — Expected: 无回归，`npm test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: 把配置接口接进宿主 webServer"
```

---

### Task 6: 浏览器半体卡片

**Files:**
- Create: `client.js`（包根，单文件）
- Modify: `package.json`（Task 7 一起改）

**Interfaces:**
- 消费：`GET /api/betteroffice/status` → `StatusSnapshot`；`POST /api/betteroffice/action` → `{ ok, text?, error? }`。
- 产出：`exports.apply = apply`、`exports.inject = []`（浏览器侧无硬服务依赖）。

- [ ] **Step 1: 先验证挂载点（spike，必须做）**

在 `client.js` 里先只写探测代码：`ctx.slots.inject('plugins.bundle.config', (…) => { console.log('[betteroffice] bundle.config mounted'); return () => {} })`，同时 `ctx.slots.inject('settings.section', …)` 各挂一个极简 `div`。装进 profile、刷新 GUI，打开 设置 → 插件配置 → BetterOffice，看控制台命中哪个。命中 `plugins.bundle.config` 就按它实现；都没命中就退回 `settings.section`（注册形状已验证：`ctx.slots.register({ name: 'settings.section', id: 'betteroffice', order: 100, label: () => 'BetterOffice', inject: () => ({}) }, Component)`，见 `dsh-better-sidebar/lib/client.js:39275`）。把结论写进本计划末尾的「实测记录」。

- [ ] **Step 2: 写卡片组件**（React.createElement，不写 JSX，保持零构建）

结构：状态区（Node 版本与是否满足、已装版本、当前使用版本、inFlight 时显示「安装中…」）+ 按钮行（安装最新 / 检查更新 / 更新 / 回退 <select>）+ 结果行（`text` 或红色 `error`）。`useEffect` 首次拉 `/api/betteroffice/status`；有 `inFlight` 时 1500ms 轮询一次；动作按钮在请求中置 disabled。

- [ ] **Step 3: 语法闸**

Run: `node --check client.js`，Expected: 无输出、exit 0。

- [ ] **Step 4: 手动冒烟**（真实 GUI）

Run: `npm run build` → `npm pack` → 在插件管理页安装新包 → 刷新，打开插件详情页，断言：卡片出现、显示当前 Node 版本、未安装时提示改用安装按钮、「检查更新」在无网时显示中文错误且按钮恢复。

- [ ] **Step 5: 提交**

```bash
git add client.js
git commit -m "feat: BetterOffice 自绘配置卡片"
```

---

### Task 7: 打包与清单

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 改清单** — `exports` 增加 `"./client": "./client.js"`；`files` 增加 `client.js`；`dsh.client = { platform: 'web', inject: [] }`（若 Task 6 用到 slots，则 `inject: ['@deepseek-ai/dsh-client-ui-slots']`）。

- [ ] **Step 2: 验证打包内容**

Run: `npm pack --dry-run --cache .scratch/npmcache 2>&1 | Select-String "client.js|Tarball|total files"`，Expected: 列出的文件里含 `client.js`。

- [ ] **Step 3: 全量验证**

Run: `npm run build; if ($LASTEXITCODE -eq 0) { npm test 2>&1 | Select-Object -Last 8 }`，Expected: 全部 pass（≥160）。

- [ ] **Step 4: 提交**

```bash
git add package.json
git commit -m "chore: 打包带上浏览器半体"
```

---

### Task 8: 文档与收尾

**Files:**
- Modify: `README.md`、`docs/superpowers/plans/2026-11-28-betteroffice-config-card.md`（本文件末尾「实测记录」）

- [ ] **Step 1: README** — 「插件设置」节把「安装/更新/回退只能用 `/betteroffice` 命令」改为「插件详情页有自绘卡片，也可用 `/betteroffice` 命令」；「已知限制」删掉「没有自绘配置页」一条，改留「卡片只在 DSH ≥0.2.0-rc.1 的插件详情页内联，旧宿主退回设置页」。
- [ ] **Step 2: 写实测记录** — 记录 Task 6 Step 1 的探测结论、命中插槽名、GUI 里看到的按钮与一次真实安装耗时。
- [ ] **Step 3: 提交** — `git add README.md docs; git commit -m "docs: 配置卡片完成状态"`

---

## 实测记录

**挂载点探测结论（离线核实，非真机探测）**：本机没有可比对的 DSH 插件源码 checkout，改用已安装的插件反查契约——
`C:\Users\KUAI\.dsh\profiles\desktop\node_modules\@hyzyn\dsh-codegraph\client.js:2703-2769` 与
`...\node_modules\dsh-better-sidebar\lib\client.js` 显示：浏览器入口是 `window.__ModuleLoader__.load({ id, factory })`，
`factory` 里 `require('react')` 取 React；插件详情页内联位是 `plugins.bundle.config`，`key` 必须是 bundle 包名（共享命名空间，重复注册直接抛 `keyed slot ... already has an entry`，客户端 apply 抛错 = 整个插件起不来）。
清单侧由 `exports["./client"]` + `dsh.client = { platform: 'web', inject: [] }` 声明，与 `@hyzyn/dsh-codegraph/package.json` 一致。

**命中插槽**：`plugins.bundle.config`，key `dsh-betteroffice`。

**离线验证**：`node --check client.js` exit 0；`npm run build` 通过；`npm test` **164 pass / 0 fail**；
`npm pack --dry-run --cache .scratch/npmcache` 列出 `client.js`（5.8 kB，共 57 个文件，tarball 46.2 kB）。

**尚未做（需要真机）**：本机 profile 里没有安装 `dsh-betteroffice`，所以 GUI 冒烟（卡片渲染、一次真实安装耗时、按钮禁用与轮询）未执行，装机后补录。

**主动跳过**：旧宿主回退槽 `plugins.row.config` / `settings.kit.item` / `settings.plugin.item` 未注册——旧宿主只保留设置项与 `/betteroffice` 命令，已写进 README「已知限制」。
