# BetterOffice 安装源切换：设计

日期：2026-11-28
状态：已批准（用户在对话里确认四档：默认 / npmjs / npmmirror / 自定义）

## 要解决的问题

运行时 `@betteroffice/agents` 只能从 npm 官方源装。中国大陆、公司内网等只能走镜像的环境装不上，「检查更新」也只会报「连不上 npm registry，稍后再试」，用户没有别的办法。

更隐蔽的一处：安装走 `npm install`（跟随 npm 自己的 `registry` 配置），检查更新走代码里硬编码的 `https://registry.npmjs.org/`——两处各说各话，换源以后也会对不上。

## 目标

- 设置卡片上能选安装源：**默认（跟随 npm 配置）**、**npmjs**、**npmmirror**、**自定义 URL**。
- 安装与检查更新使用**同一个**源。
- 自定义 URL 只接受 `http(s)://`，非法输入当场拒绝并给中文原因。

## 非目标

- 不做离线安装（本地 tarball / 本地 CLI 路径）。
- 不改已安装的运行时；换源只影响之后的安装与检查。
- 不做「测速」「自动挑选最快的源」。

## 存储与判定

- `settings.json` 增一项 `registry`：字符串。`''` 表示「默认」。
- 预设常量：`https://registry.npmjs.org/`、`https://registry.npmmirror.com/`。
- 「默认」下的实际源 = `npm config get registry` 的返回值（进程内缓存一次，读失败则退回 npmjs）。
- 卡片显示：库里存的是预设 URL 就选中对应项，是别的合法 URL 就选中「自定义」并填进输入框，`''` 就是「默认」。

## 怎么落地

- `src/registry.ts`：加 `REGISTRY_PRESETS`、`isRegistryUrl`、`packageUrl(registry)`；`fetchLatestVersion` 收 `registry?: string`。
- `src/npm-runtime.ts`：`npmInstallArgs` 收 `registry?: string`，非空才追加 `--registry <url>`。
- `src/installer.ts`：`InstallerDeps` 加 `registry?(): string`，安装时带入。
- `src/store.ts`：`StoredSettings` 加 `registry`，非法值当没设置。
- `src/control.ts`：`parseSettings` 校验 `registry`；快照 `settings.registry`。
- `src/routes.ts`：保存回执里说明安装源。
- `src/index.ts`：`withStored` 合并 `registry`；`resolveRegistry()` 处理「默认 → npm config」并缓存；传给 installer 与 `fetchLatestVersion`。
- `client.js`：多一行「安装源」下拉 + 自定义输入框。

## 取舍记录

- 为什么不把「默认」定义成 npmjs：用户明确要「走系统设置」，让配了内网源的机器开箱即用。
- 为什么不把 npm 配置读进启动流程：一次 `npm config get registry` 约几百毫秒，放在首次安装/检查时惰性读并缓存，不拖慢宿主启动。
- 为什么存完整 URL 而不是存档位名：URL 可直接传给 `npm --registry`，少一层映射；档位名再存派生逻辑反而多一处可能不一致。
