# 阶段 2 实现计划：编辑副本、检查点、交付另存

> **进度：已完成**（Task 13–18 全部落地，67 条测试全绿）。台账遗留：`MountHandle` 没有加 `ready`，
> 改成用 `waitForTool` 轮询「MCP 工具是否已注册」来判定就绪——比赌 fiber 内部状态更稳。
>
> 前置：阶段 0–1 已完成（提交 `dd8a69c`），46 条测试全绿，只读链路已用真实 MCP 端到端验证。
> 本计划只覆盖 DESIGN §4.3 / §5.1 与阶段 2 范围：编辑副本、检查点、交付另存。
> 替换原文件（§5.2）与回收站属阶段 4，本阶段不碰原文件。

## 与阶段 1 的接口变化

阶段 1 的 `betteroffice_open` 只挂 MCP、不打开文档，文档 id 由 agent 在 MCP 工具里拿。
检查点要由插件确定性地调 `office_export`，插件必须自己知道文档 id，所以：

- `MountHandle` 增加 `ready: Promise<void>`（等 MCP 启动并注册完工具，失败即 reject）。
- `betteroffice_open` 在挂载成功后自己调一次 `office_open`（MCP 工具名 `mcp__<serverName>__office_open`），把返回的 `document` 记进任务台账，并把该 id 一起返回给 agent。
- agent 之后仍可用 `mcp__<serverName>__*` 检查、提议、渲染，但**不用再自己 office_open**。

## 工具调用通道

插件不另起 MCP 客户端，也不复制 JSON-RPC：直接调用宿主已注册的工具定义。

```ts
// src/invoke.ts
export type ToolInvoker = { invoke(name: string, args: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> }
createToolInvoker(tools: ToolView, scope?: unknown): ToolInvoker
```

`ToolView` 只要求 `view(scope): ReadonlyMap<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>`。
调用时传 `{ signal }` 作为执行上下文——dsh-mcp-client 的工具实现只读 `execution.signal`（已读源码 `tools.ts:196`），
`shortcut:` 注释写明这个依赖面；取不到工具定义时抛 `DomainError('tool-not-found', …)`（中文，提示 MCP 可能已断开）。

## Task 列表（每个 Task 都是「写失败测试 → 看失败 → 实现 → 看通过 → 提交」）

### Task 13: 工具调用通道

- Create: `src/invoke.ts`，Test: `test/invoke.test.ts`
- 契约：`createToolInvoker(view, scope)`；工具存在 → 透传结果；不存在 → `tool-not-found`；`execute` 抛错 → 原样冒泡（不吞）。
- 提交：`feat: 工具调用通道`

### Task 14: 挂载句柄暴露启动完成

- Update: `src/mount.ts`（`MountHandle.ready`）、`src/tasks.ts`（open 等 ready 后再 office_open）
- Test: `test/mount.test.ts` 追加「ready 在 plugin 挂载完成后 resolve」「挂载失败时 ready reject 且记录被移除」。
- 提交：`feat: 挂载就绪信号`

### Task 15: open 时打开文档并记账

- Update: `src/tasks.ts`、`src/tools.ts`（`betteroffice_open` 返回值加 `document`）
- 契约：`TaskRecord.documentId`；`open` 成功后调用 `office_open`，参数 `{ path: 相对 root 的路径 }`；
  返回值里 `document` 缺失/非字符串 → 抛 `DomainError('open-failed', '文档已挂载但 BetterOffice 没有返回文档 id：…')`。
- Test：`test/tasks.test.ts` 追加三条（成功记账、缺 document 报错、失败时任务回滚不留台账）。
- 提交：`feat: 打开文档并记录文档 id`

### Task 16: 检查点

- Create: `src/checkpoint.ts`，Update: `src/tools.ts`（`betteroffice_checkpoint` 真实现）
- 契约：
  - `checkpointFileName(index: number, sourceName: string): string` → `cp-0001-<净化名>.docx`（复用 `workspace.ts` 的净化与扩展名逻辑）。
  - `createCheckpoint({ invoker, record, checkpointsDir, at, sha256File })` →
    1. 从 1 递增找第一个不存在的文件名（**绝不覆盖**）；2) 调 `office_export{document, path:'checkpoints/<名字>'}`；
    2. 校验文件存在、大小 > 0、算 sha256；4) 返回 `{ path, sha256, size, at }`，由调用方追加进台账。
  - 失败（导出报错/文件缺失/空文件）→ 抛 `DomainError('checkpoint-failed', 中文原因)`，**不写台账**。
- Test：`test/checkpoint.test.ts` 五条（命名、跳过已占用名、成功后校验、空文件、导出抛错）。
- 提交：`feat: 检查点导出与校验`

### Task 17: 台账读写检查点

- Update: `src/workspace.ts`（`TaskLedger.checkpoints: CheckpointRecord[]`、`appendCheckpoint(dir, record)`、`readLedger` 兼容旧文件）
- Test：`test/workspace-ledger.test.ts` 三条（追加、回读顺序、旧台账无 checkpoints 字段时补空数组）。
- 提交：`feat: 台账记录检查点`

### Task 18: 交付另存

- Create: `src/deliver.ts`，Update: `src/tools.ts`（`betteroffice_deliver` 真实现）
- 契约：
  - `deliverTarget(preferred: string, exists)`：目标已存在 → 依次尝试 `<base> (2)<ext>`…，最多 100 次；仍冲突 → `DomainError('target-exists', …)`。
  - `deliver({ invoker, record, draftDir, target, exists, copyFile })` →
    1. `office_export` 到 `draft/deliver-<stamp>.docx`；2) 校验产出；3) 用**独占创建**（`COPYFILE_EXCL`）复制到目标；
    2. 返回 `{ target, sha256, size }`。
  - 永不覆盖：复制用 `COPYFILE_EXCL`，失败按 EEXIST 重新选名（最多 100 次），其它错误冒泡。
- Test：`test/deliver.test.ts` 六条（选名、跳过占用、成功交付、EEXIST 重试、导出失败不落地、返回哈希）。
- 提交：`feat: 交付另存`

### Task 19: 阶段 2 收尾

- 更新 `README.md` 当前状态与工具表（checkpoint/deliver 不再标「阶段 2 才有」）。
- 真实端到端：用 `.scratch/rt` 的运行时 + `.scratch/e2e/年度报告.docx`，跑 open → propose?（docx_edit 需真实编辑参数，改用 `office_export` 直接导出当前状态）→ checkpoint → deliver，断言原文件 sha256 不变、交付文件存在且可再打开。
- 提交：`docs: 阶段 2 验收与当前状态`

## 明确不做（留给阶段 3/4）

- 配置页、运行时安装/更新、清理策略开关。
- 替换原文件、回收站、恢复日志。
- 工作文件夹的「自动/强制」UI —— 本阶段沿用阶段 1 的 `workspaceMode` 语义，编辑时建工作文件夹并在 open 里使用。
