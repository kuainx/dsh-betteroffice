# BetterOffice 插件 · 阶段 4 实现计划：替换原文件（回收站事务 + 崩溃恢复）

> 设计依据：`docs/superpowers/specs/2026-11-28-betteroffice-plugin-design.md` §3.5、DESIGN.md §5.2。
> 用户决定（本次）：回收站用 **PowerShell 5.1 + Microsoft.VisualBasic `SendToRecycleBin`**，确认用 **Shell 命名空间**；
> 替换前必须 **agent 显式 `confirm:true` + 宿主 approval 弹窗** 两道关。

## 0. 前置事实（已在本机实测）

| 事实 | 证据 |
| --- | --- |
| VB API 能真正回收文件 | 探针文件回收后 `Test-Path` 为 False，且 Shell 命名空间能看到条目 |
| 直接读 `C:\$Recycle.Bin\<SID>` 会被拒 | `Get-ChildItem` exit 1、无输出 |
| Shell 命名空间可确认回收 | `Namespace(10)` 列出 `bo-recycle-probe-*.txt`，`Path` 指向 `$R...` |
| 宿主 approval 通道可用 | dsh-tools `pipeline.ts:443-491`：`tools/pre-execute` 返回 `{kind:'ask'}` 时用 `ctx.get('approval').request()`；无通道即拒绝 |

结论：回收可用性与确认都由「一次 PowerShell 调用」完成，失败即视为不可用（绝不降级为永久删除）。

## 1. 决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 回收实现 | `powershell.exe -NoProfile -NonInteractive -Command <固定脚本>`，路径经 `BO_RECYCLE_PATH` 环境变量传入 | Windows 必有 PowerShell 5.1；不拼字符串，避免注入 |
| 回收确认 | 同一脚本内用 `Shell.Application.Namespace(10)` 找同名+同删除时间条目，输出 JSON | 目录枚举被 ACL 拒，只有 shell 命名空间可靠 |
| 发布原位置 | `fs.link(candidate, source)` 成功后 `unlink(candidate)` | 硬链接在目标已存在时返回 `EEXIST`，是真正的「不覆盖」原语；`rename` 在 Windows 会覆盖 |
| 事务日志位置 | `<DSH 主目录>/betteroffice/commits/<taskId>.json` | 崩溃后可扫；不污染用户目录；与源文件无关也能恢复 |
| 恢复副本 | `<DSH 主目录>/betteroffice/backups/<taskId><ext>` | 回收后仍能恢复原件；清理前必须确认发布成功 |
| 锁 | `<...>/commits/<sha1(源路径)>.lock`，`open('wx')` 写 `{taskId, pid, at}` | 同一源文件禁止并发替换；残留锁由恢复流程清理 |
| 只读任务 | 直接拒绝（`replace-failed`） | 只读不产生任何写入 |
| 原件已变 | 源文件 sha256 ≠ 打开时记录的 hash 时拒绝（`source-changed`） | 别人改过就不能覆盖 |
| 回收不可用 | 返回 `recycle-unavailable`，提示改用另存 | DESIGN：Linux/网络盘只允许另存 |

## 2. 任务

### T26 `src/recycle.ts` —— 回收与确认
- 纯函数 `recycleScript(): string`（固定脚本，从 `$env:BO_RECYCLE_PATH` 读路径，回收后用 Shell 命名空间确认，最后 `Write-Output` 一行 JSON：`{"recycled":true,"name":"…"}` 或 `{"recycled":false,"reason":"…"}`）。
- `recycleFile(path, deps{run, platform})`: 非 win32 → `DomainError('recycle-unavailable', …)`；`run('powershell.exe', ['-NoProfile','-NonInteractive','-Command', recycleScript()], {env:{BO_RECYCLE_PATH: path}})`；解析最后一个 JSON 行；`recycled!==true` → `recycle-failed`（带 reason）。
- 测试：脚本里含 `SendToRecycleBin` 与 `Namespace(10)`、非 Windows 报 `recycle-unavailable`、run 返回成功 JSON 时 resolve、返回 false 时抛 `recycle-failed`、崩溃输出无法解析时抛 `recycle-failed`。

### T27 `src/journal.ts` —— 事务日志
- 类型 `CommitStage = 'prepared' | 'recycled' | 'published'`；`CommitJournal{taskId, source, sourceHash, candidate, candidateHash, backup, stage, startedAt}`。
- `writeJournal(dir, journal)`（`writeFile` + `mkdir recursive`）、`readJournal(dir, taskId)`、`listJournals(dir)`（ENOENT → []）、`removeJournal(dir, taskId)`。
- 锁：`acquireLock(dir, key, info)`（`open(path,'wx')`，EEXIST → `DomainError('replace-busy', …)`）、`releaseLock(dir, key)`。
- 测试 6 条。

### T28 `src/replace.ts` —— 替换事务
`replaceOriginal(deps{recycle, home, source, sourceHash, candidate, candidateHash, taskId, now, exists, copyFile, link, unlink, mkdir, sha256, stat})`：
1. 前置：`sha256(source) === sourceHash` 否则 `source-changed`；`sha256(candidate) === candidateHash`；`stat(candidate).dev === stat(dirname(source)).dev`（不同卷 `cross-volume`）。
2. 拿锁；写恢复副本 `backup`；写 journal `prepared`。
3. `recycle(source)`；成功 → journal `recycled`；失败 → 删 journal + 锁，抛 `recycle-failed`/`recycle-unavailable`（原件未动）。
4. 发布：`link(candidate, source)`；`EEXIST` → `publish-conflict`（此时原件在回收站，恢复副本在，journal 留 `recycled` 供恢复）；成功后 `unlink(candidate)`。
5. 校验 `sha256(source) === candidateHash`；写 journal `published`；删 journal、备份、锁。
- 任何一步异常都要保持 journal 与备份，供启动恢复。
- 测试 8 条（哈希不符、跨卷、回收失败不留残留、发布冲突保留 journal、成功路径清理、锁被占）。

### T29 `src/recovery.ts` —— 启动恢复
`recoverJournals({dir, home, ...})`：扫 `listJournals`；`prepared` → 原件可能仍在 → 删 journal+锁，报告 `abandoned`；`recycled` → 尝试从 candidate 用同样的 link 发布（成功则 `completed`，失败则从 backup 复制回原件 `restored`）；`published` → 只清理。返回 `RecoveryReport[]` 供日志。
- 测试 4 条。

### T30 工具与接线
- `src/tools.ts` 新增第 6 个工具 `betteroffice_replace`，参数 `{task, confirm: boolean}`；`confirm !== true` → `DomainError('confirm-required', '替换原文件需要 confirm:true，并且用户要在弹窗里点同意')`；execute 走 `registry.replace(sessionId, taskId)`。
- `src/tasks.ts` 新增 `replace(sessionId, taskId)`：只读拒绝；导出候选到 `<root>/.commit/`；调用 `replaceOriginal`；返回 `{taskId, replaced: path, sha256}`。
- `src/index.ts`：`host.on('tools/pre-execute', ...)` 对 `betteroffice_replace` 返回 `{kind:'ask', reason:'将把原文件移入回收站并覆盖为新版本'} `；启动时 `recoverJournals` 并记日志。
- 测试：工具描述含「回收站」「确认」；`confirm` 缺失报错；pre-execute 只对 replace 返回 ask。

### T31 收尾
- README：阶段 4 标完成、替换语义与限制（同卷、回收站可用、两道确认、失败不留半成品）。
- 真实冒烟：在 `.scratch/e2e/` 里造 docx → 走 `replaceOriginal` 用真 PowerShell 回收并发布 → 断言新 hash、原件在回收站、无残留 journal。
- 设计稿验收对照补一行。

## 3. 不做

- 不做 Linux/网络盘替换（返回 `recycle-unavailable`）。
- 不做「另存并删除原件」的降级路径（DESIGN 明确禁止降级为永久删除）。
- 不做多文件批量替换。
