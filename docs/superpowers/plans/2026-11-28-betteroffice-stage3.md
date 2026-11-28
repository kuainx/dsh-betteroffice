# 阶段 3 实现计划：运行时检测 / 安装 / 更新 与用户操作入口

> 前置：阶段 0–2 已完成（`3ddcc08`），67 条测试全绿。已确认 `@betteroffice/agents@0.4.0` 真实可跑，
> 但运行时**不内置**（用户决定，m00228），要从 npm 装进插件私有目录。
>
> **进度：T20–T25 已完成。** 95 条测试全绿。真实安装冒烟已通过：临时 home 走 `createCommandDeps` →
> `/betteroffice 安装 0.4.0` → 私有目录落到 `betteroffice/runtime/0.4.0`、`dist/cli.js` 2098 字节、
> `node cli.js --help` 正常打印用法、`installedVersions` 返回 `["0.4.0"]`。
> 与计划的差异：设置页沿用 schemastery 自动生成的那份，没有自绘卡片（见下节）；
> 没有内置 fallback 运行时副本 —— 用户明确选择「不内置」，首次使用必须先 `/betteroffice 安装`。
>
> 本阶段只做 DESIGN §7：检测、安装、检查更新、更新、回退，以及让用户能触发这些动作的入口。
> 不碰 §5.2 替换原文件（阶段 4）。

## 关键判断：入口用斜杠命令，不画配置页

设计稿的原意是自绘配置页卡片（`设置 → 插件配置 → BetterOffice` 里有按钮）。调研结论：

- 插件的 `Config`（schemastery + `.volatile()`）**已经自动出现在那个位置**，四个字段都能改、能保存，
  这已经满足「配置项在设置里改、不重写用户 profile 配置」。
- 自绘卡片要求额外的浏览器端产物（`dsh.client` 打包成 `window.__ModuleLoader__` 的 bundle），
  是这一阶段里最大的一块工作，而不带来新的安全性——按钮背后仍是同一批用户动作。
- 用户在 m00549 已同意兜底：配置页 spike 不通过就退化为「自动设置页 + `/betteroffice` 命令」。

所以本阶段：**设置页复用自动生成的那一份，动作走 `/betteroffice` 斜杠命令**。
斜杠命令由人在输入框敲入、handler 不经过模型，天然满足「安装/更新/回退只能是用户动作」。
自绘卡片留作可选增强，不在本计划内。

## 运行时目录与版本

- 私有目录：`<DSH 主目录>/betteroffice/runtime/<版本>/`，CLI 路径
  `<...>/node_modules/@betteroffice/agents/dist/cli.js`（与 `src/runtime.ts` 的 `cliPathFor` 一致）。
- 安装命令（用 `spawnPortable`，Windows 上 `.cmd` 由它处理）：
  `npm install @betteroffice/agents@<版本> --prefix <版本目录> --no-fund --no-audit --cache <版本目录>/.npm-cache`
  带私有 cache，避免污染用户全局 npm cache；失败保留 stderr 尾部 20 行。
- 版本并存：不同版本装在不同目录，更新/回退只是改 `runtimeVersion` 配置项（新任务用新版本，
  已有任务记录自己那份，符合 DESIGN §7）。
- 检测：列 `<home>/betteroffice/runtime/` 下「`node_modules/@betteroffice/agents/dist/cli.js` 存在」的目录。
- 检查更新：`GET https://registry.npmjs.org/@betteroffice/agents`，取 `dist-tags.latest`；网络失败给中文可行动提示。
- Node 版本门槛沿用 `src/runtime.ts` 的 `MIN_NODE_VERSION='22.12.0'`。

## 命令面

`/betteroffice`（无参数 = `状态`）：

| 子命令        | 行为                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `状态`        | 当前版本、已安装版本列表、Node 版本是否达标、CLI 是否存在            |
| `安装 [版本]` | 未装过时安装（缺省装 registry 的 latest），装完写入 `runtimeVersion` |
| `检查更新`    | 查 registry latest，与当前版本对比，只报告不升级                     |
| `更新 [版本]` | 装另一个版本并切换 `runtimeVersion`，旧版本目录保留以便回退          |
| `回退 <版本>` | 已安装过的版本切回默认                                               |

handler 返回 `{kind:'success'|'error', text}`（`command` 的契约如此），文本用中文、给出实际路径与下一步。

## Task 列表（每个 Task 都是「写失败测试 → 看失败 → 实现 → 看通过 → 提交」）

1. **T20 `src/npm-runtime.ts`**：`runtimeDirFor(home, version)`、`cliPathFor`（移到此处共用）、
   `listInstalledRuntimes(home, readdir)`、`npmInstallArgs({prefix, version, cacheDir})`、
   `readNpmVersion(output)`。纯函数，测试用假 `readdir`。
2. **T21 `src/registry.ts`**：`fetchLatestVersion({fetch})` → `dist-tags.latest`；非 2xx / 非 semver 抛
   `DomainError('registry-unreachable'|'registry-bad-response', 中文)`。测试用假 `fetch`。
3. **T22 `src/installer.ts`**：`createInstaller({home, spawn, logger, exists, readdir})` →
   `install(version): Promise<{version, dir, cliPath}>`；spawn 收尾前校验 CLI 存在，否则 `install-failed`（附 stderr 尾部）；
   同一版本并发安装加进程内锁。测试用假 `spawn`（可控退出码与 stderr）。
4. **T23 `src/commands.ts`**：`createBetterOfficeCommand(deps)` → `{name:'betteroffice', description, handler}`；
   子命令解析与五种动作，全部中文输出。测试直接调 handler。
5. **T24 接线**：`src/index.ts` 里 `ctx.inject(['commands'], …)` 注册命令、`ctx.inject(['settings'], …)` 拿
   `settingsEntryScope('betteroffice')` 写 `runtimeVersion`；服务缺失时只在日志里说明（不抛）。
6. **T25 收尾**：README「阶段 3 已完成」与命令用法、计划顶部进度、真实安装冒烟（临时 home + 真 npm，
   验证 CLI 落地后删除），提交。

## 验收（阶段 3 结束时要能跑出来）

- `/betteroffice 状态` 在没装运行时的情况下说清「未安装、去哪装」。
- `/betteroffice 安装` 在本机真的装出一份 CLI，并把 `runtimeVersion` 写进配置（配置页可见）。
- 装完立刻 `/betteroffice_open` 能只读打开文档（运行时探测读到新版本）。
- `/betteroffice 检查更新`「无网」时给中文提示而不是抛栈。
- 安装/更新/回退没有任何 agent 工具入口（`TOOL_NAMES` 不变）。
