# BetterOffice 安装源切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在卡片上选择安装源（默认 / npmjs / npmmirror / 自定义），安装与检查更新使用同一个源。

**Architecture:** 源存在插件自己的 `settings.json`（`registry` 字段，`''` = 默认跟随 npm 配置）。`''` 时在首次安装/检查时惰性读 `npm config get registry` 并缓存；非空时直接作为 `npm install --registry` 参数与 registry 查询前缀。

**Tech Stack:** TypeScript（Node 22）、`node:test`、单文件 `client.js`（React.createElement，零构建）。

**Spec:** `docs/superpowers/specs/2026-11-28-betteroffice-registry-design.md`

## Global Constraints

- 文案全中文、错误消息可行动；`DomainError` 必须带 `code`。
- 不新增任何运行时依赖，不引入打包器。
- 安装/更新/回退只能用户点击触发，不注册 agent 工具。
- 现有 195 条测试与 `/betteroffice` 命令必须保持通过。
- npm 一律带 `--cache <版本目录>/.npm-cache`。
- 提交信息用 UTF-8 文件 + `git commit -F`；`git` 写操作带 `sandbox_permissions: "danger-full-access"`。

## Review Focus

- 自定义 URL 只接受 `http(s)://`，`javascript:`、`file:`、`ftp:`、`//host`、裸域名都必须被拒并给中文原因。
- 存进 `settings.json` 的非法值（手改坏的）要在读时被忽略，不能把插件带崩。
- 默认档必须真的走 npm 自己的配置（本机是 npmmirror），而不是悄悄用 npmjs。
- 装完后 `settings.json` 里另两个字段不能被源切换覆盖（先读再合并）。
- 换源不能影响已装版本：`inFlight`、`rollback` 行为不变。

---

### Task 1: 源在安装与查询两条路上都生效

**Files:**
- Modify: `src/registry.ts`
- Modify: `src/npm-runtime.ts`
- Modify: `src/installer.ts`
- Test: `test/registry.test.ts`、`test/npm-runtime.test.ts`、`test/installer.test.ts`

**Interfaces:**
- Produces: `REGISTRY_PRESETS: { npmjs: string; npmmirror: string }`、`isRegistryUrl(value: string): boolean`、`packageUrl(registry: string): string`、`fetchLatestVersion(options: { registry?: string; fetch?: RegistryFetch; timeoutMs?: number } = {})`、`npmInstallArgs(options: { prefix: string; version: string; cacheDir: string; registry?: string }): string[]`、`InstallerDeps.registry?(): string`。

- [ ] 写失败测试：`packageUrl('https://registry.npmmirror.com/')` 得到 `https://registry.npmmirror.com/@betteroffice/agents`；`isRegistryUrl` 拒 `javascript:alert(1)`、`//host/x`、`registry.npmjs.org`；`fetchLatestVersion({ registry })` 打的是自定义源；`npmInstallArgs` 带 registry 时多出 `--registry` 两项。
- [ ] 跑 `npm run build` 看类型失败（缺导出）。
- [ ] 实现三个函数与参数；installer 在 `deps.registry?.()` 非空时传下去。
- [ ] `npm run check` 全绿。
- [ ] 提交 `feat: 安装与检查更新共用同一个源`。

### Task 2: 源存进设置并贯通路由

**Files:**
- Modify: `src/store.ts`、`src/control.ts`、`src/routes.ts`、`src/index.ts`
- Test: `test/store.test.ts`、`test/control.test.ts`、`test/routes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `REGISTRY_PRESETS`、`isRegistryUrl`、`fetchLatestVersion({ registry })`。
- Produces: `StoredSettings.registry: string`；`StatusSnapshot.settings = { workspaceMode; cleanupMode; registry }`；`ControlAction` 的 `settings` 请求带 `registry`；`ControlDeps.saveSettings(patch: { workspaceMode: string; cleanupMode: string; registry: string })`。

- [ ] 写失败测试：存 registry 后能读回、坏 URL 被忽略；`parseAction({action:'settings', settings:{...registry}})` 接受 `''`、两个预设、合法 URL，拒非法；快照带 `registry`；保存成功回执含安装源中文名。
- [ ] `npm run build` 看失败。
- [ ] 实现 `readStored`/`parseSettings`/`buildStatus`/`run()`/`index.ts` 的合并与 `resolveRegistry()`（`''` → 缓存一次 `npm config get registry`，失败退回 npmjs）。
- [ ] `npm run check` 全绿。
- [ ] 提交 `feat: 安装源存进设置并贯通路由`。

### Task 3: 卡片上的第四行 + 文档

**Files:**
- Modify: `client.js`、`README.md`
- 验证：`node --check client.js`、`.scratch/client-sim.mjs`、`npm pack --dry-run`

- [ ] 快照校验放行 `settings.registry`；加「安装源」下拉（默认 / npmjs / npmmirror / 自定义）+ 自定义输入框（仅自定义时出现，回车或失焦保存）。
- [ ] `node --check client.js`、`node .scratch/client-sim.mjs`。
- [ ] README 设置表加「安装源」一行，说明默认跟随 npm 配置。
- [ ] `npm run check` + `npm pack --dry-run`。
- [ ] 提交 `feat: 卡片上能换安装源`。