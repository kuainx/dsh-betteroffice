# BetterOffice 工具对 agent 的可发现性（设计）

日期：2026-11-28
状态：已批准（用户 m02305「按1+2执行」）

## 背景

三格式真机冒烟时，agent 连错 4 次，都是同一类问题——子进程里 37 个 MCP 工具的名字与必填参数对 agent 是黑盒：

| 现场报错                                                                            | 真实原因                                              |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `任务不存在或已关闭：none` / `:open`                                                | 该用 `betteroffice_open` 却调了透传工具               |
| `缺少参数 tool（MCP 工具名）`                                                       | `tool` / `args` 要放顶层，agent 塞进了 `args`         |
| `{"code":"INVALID_ARGUMENT","message":"version: expected string, received number"}` | MCP schema 要字符串版本号，agent 看不到 schema 只能猜 |

而且系统提示里写的 `docx_replace_text`、`docx_outline` 根本不存在（真实的是 `docx_edit`、`office_outline`），照文档猜必然失败。

## 方案

### 1. 新工具 `betteroffice_tools`

`betteroffice_tools({ task })` 把该任务子进程的 `tools/list` 原样返回：每个工具的名字、说明、`inputSchema`（含 `required` 与各字段类型）。

实现路径：`McpConnection.list()` 发一条 `tools/list` JSON-RPC → `TaskRegistry.tools(sessionId, taskId)` 透出 → `tools.ts` 第 8 个工具。

### 2. 错误文案自带下一步

| 场景           | 现在                          | 改成                                                           |
| -------------- | ----------------------------- | -------------------------------------------------------------- |
| 透传缺 `tool`  | `缺少参数 tool（MCP 工具名）` | 追加「tool 和 args 都要放在顶层，args 里放该工具自己的参数。」 |
| 任务 id 不存在 | `任务不存在或已关闭：x`       | 追加「这里要填 betteroffice_open 返回的任务 id。」             |
| MCP 说参数不对 | 原样 JSON                     | 追加「先调 betteroffice_tools 看这个工具的 inputSchema。」     |

## 不做

- 省略 `version` 时自动补当前版本：省一次调用，但插件得自己跟踪版本号，容易与 MCP 不同步。
- 让 `betteroffice_call` 同时接受嵌套参数形状：两种形状并存会让错误更难定位。

## 验收

- `npm run check` 通过，新增测试覆盖上面三处文案与 `tools/list` 透出。
- 真机：先 `betteroffice_tools` 看清单，再按 schema 调 `xlsx_write_range`，一次成功。
