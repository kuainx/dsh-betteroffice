# DSH BetterOffice 插件设计（实现稿）

- 日期：2026-11-28
- 上游需求：[DESIGN.md](../../../DESIGN.md)
- 状态：已按你 2026-11-28 的三项选择更新，等待最终确认

---

## 1. 目标与边界

把 DESIGN.md 落成一个可分发的 DSH Bundle：**Host 插件**（任务管理 + MCP 运行时管理）+ **Client 配置页**。让 agent 能读写已有 `.docx/.xlsx/.pptx`，且**永不静默覆盖原文件或已有产物**。

冻结（不做）：独立编辑器、BetterOffice 未暴露的能力、内置 MCP 运行时二进制。

已定决策：

| 决策           | 取值                                                      | 来源       |
| -------------- | --------------------------------------------------------- | ---------- |
| 首版范围       | DESIGN §8 四阶段全做，每完成一个工序 commit               | 你，m00228 |
| MCP 运行时     | 不内置；首次使用时引导用户去配置页点「安装」              | 你，m00228 |
| Agent 工具形态 | Host 薄封装 + 按 agent 挂载 MCP                           | 你，m00228 |
| 只读 root      | 照 DESIGN 原文：原文件父目录 + `--read-only`              | 你，m00549 |
| 技术形态       | TypeScript 全链路（`tsc` 编译，非无构建 JS）              | 你，m00549 |
| 配置页兜底     | spike 不通过则退化为「自动设置页 + `/betteroffice` 命令」 | 你，m00549 |

---

## 2. 总体架构

```
Agent（每个会话一个 scope）
  │  只看见 5 个 betteroffice_* 工具 + 本任务的 mcp__bo_<id8>__* 工具
  ▼
Host 插件 dsh-betteroffice
  ├─ tasks      任务注册表：会话 ↔ 文档 ↔ 工作文件夹 ↔ MCP 实例
  ├─ paths      路径解析 + 权限检查（符号链接/junction/设备身份）
  ├─ workspace  工作文件夹命名、独占创建、台账持久化
  ├─ runtime    MCP 运行时发现/安装/更新/回退（私有版本目录）
  ├─ tools      5 个 agent 工具
  ├─ deliver    另存为新文件（不覆盖）
  ├─ replace    原文件替换事务（阶段 4）
  └─ http       配置页调用的 Host 路由
  ▼
src/mcp.ts 自带 JSON-RPC 连接器（自己 spawn 子进程，不经 dsh-mcp-client）
  ▼
betteroffice-mcp --root <dir> [--read-only]（stdio）
```

**为什么是「薄封装 + 挂载 MCP」**：办公文档的读写/提案/复检逻辑全在 BetterOffice 里，重写没意义；插件只负责设计文档里真正必须由插件管的部分——root 选择、权限校验、任务与检查点、交付、替换事务、运行时版本。挂载由插件自带的连接器完成（`src/mcp.ts`），MCP 工具以 `mcp__bo_<任务id8>__<工具名>` 注册进**该 agent 的 scope**，天然满足「一个实例只服务一个会话+文档+任务」。

**不再依赖宿主的 `dsh-mcp-client`**（`c3e9629` 起）：早期方案是动态 `import('@deepseek-ai/dsh-mcp-client')` 按 scope 挂载，但宿主沙箱不暴露 `ctx.plugin`，挂不上去，于是改为插件自己 spawn `betteroffice-mcp` 走 JSON-RPC（见 `2026-11-28-betteroffice-mcp-connector.md`）。因此 `package.json` 里不声明这个依赖，也不再需要担心「两份 `dsh-scope`、`kScope` 是模块内 Symbol 导致 `scopeOf()` 返回 undefined」——那个约束只在复用宿主客户端时成立。若将来回退到 scope 挂载，要把 peerDependency 加回来，并且 dev/peer 写成同一个版本范围。

---

## 3. Host 模块设计

### 3.1 root 矩阵（§3）

| 场景                   | root                | 参数          | 工具白名单                          |
| ---------------------- | ------------------- | ------------- | ----------------------------------- |
| 只读原文件             | **原文件父目录**    | `--read-only` | 去掉 `office_files`，其余检查类保留 |
| 编辑、不使用工作文件夹 | 私有临时目录 + 副本 | 读写          | 全量                                |
| 编辑、使用工作文件夹   | `<工作文件夹>` 根   | 读写          | 全量                                |

**只读模式的残余风险（照原文实现，明确的已知代价）**：root 为父目录时，`office_open` 理论上可打开同级其它文件。`--tools` 只能裁掉 `office_files` 因而禁止枚举，裁不掉路径范围。对策按强度排序：

1. 工具白名单排除 `office_files`（禁枚举）；
2. `betteroffice_open` 在只读模式只登记**一个**允许的文档名，台账记录，systemPrompt 段落与工具描述明确写「只读任务只允许读该文件」；
3. 不在只读任务里发放任何导出/编辑能力（`--read-only` 已保证）。

这是「更安全地偏离原文」与「照原文」之间的取舍，你选了照原文，故此处按已知风险实现，不再自作主张。

**编辑模式一处仍偏离 DESIGN 原文（未收到否决，保留）**：MCP 的 `office_export` 只接受 root 内相对路径；root 若钉在 `<工作文件夹>/draft/`，检查点就写不进同级 `checkpoints/`。因此**编辑时 root 用工作文件夹根**，`draft/`、`checkpoints/` 都可达，插件按「已登记产物」白名单收口，agent 仍不能在文件夹里乱写。若你要严格照原文，则检查点只能由插件在 MCP 导出后自行复制进 `checkpoints/`，功能不变、路径语义稍绕。

### 3.2 工作文件夹（§4）

命名：`dsh-<原文件名含扩展名>-<YYMMDD-HHmmss>-<8 位任务 id>`，作为源文件同级目录；保留中文与扩展名，剔除分隔符/控制字符/Windows 非法字符，不留尾随空格与点，超长按字节截断。**独占创建**（`mkdir` 非递归、已存在即失败，绝不接管已有目录）。

目录内容：`draft/`（agent 的编辑产物）、`checkpoints/`（插件登记的检查点）、`.betteroffice-task.json`（台账）。

台账字段：`taskId / sessionId / sourcePath(规范路径) / sourceHash / baseVersion / dirIdentity(卷+fileId) / registeredArtifacts[] / checkpoints[{n, path, sha256, at}] / status / mcpVersion`。台账同时写入 `<dshHome>/betteroffice/journal/<taskId>.json` 作为跨重启恢复源。

### 3.3 Agent 工具（仅 5 个）

| 工具                      | 参数                                      | 行为                                                                                                                                           |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `betteroffice_open`       | `path`、`mode`('read'\|'edit'，默认 read) | 解析+校验路径 → 选 root → （需要时）建工作文件夹/副本 → 计算源哈希 → 挂载 MCP → 返回 `taskId`、`documentId`、`root`、`mcpServer`、可用工具前缀 |
| `betteroffice_list`       | —                                         | 列出当前会话的任务与状态                                                                                                                       |
| `betteroffice_checkpoint` | `task`、`label?`                          | 校验 `draft/` 产物 → 复制进 `checkpoints/N-<name>`（不覆盖）→ 校验真实文件（zip 头 + 可解析）→ 记台账                                          |
| `betteroffice_deliver`    | `task`、`path?`                           | 另存为新文件（默认源文件同级、自动取未占用名）；绝不覆盖                                                                                       |
| `betteroffice_close`      | `task`、`keepFiles?`                      | 卸载 MCP；按清理设置决定是否删工作文件夹                                                                                                       |

规矩：agent 只在 `open` 时给路径、只在 `deliver` 时给交付位置；此后一律用插件发的 `taskId/documentId`，且这些 id 与会话绑定（别的会话拿到也用不了）。工具注册走 `agent.ctx.tools.register`，随 agent 销毁自动回收。

`serverName` 形如 `bo_<8位任务id>`，满足 `^[A-Za-z0-9_-]{1,32}$`；MCP 启动参数 `--root <root> [--read-only] [--tools ...]`，命令为「已安装并校验过的 betteroffice-mcp + 检测到的 Node ≥ 22.12.0」，`failOnStartupError: true`。

### 3.4 交付（§5.1）

检查点 ≠ 交付。`deliver` 从 `draft/`（或指定检查点）取候选 → 校验 zip 头与目标格式 → 在目标目录用「不覆盖」原语落盘（`copyFile` + `COPYFILE_EXCL`，Windows 上等价于 `O_EXCL`）→ 返回真实路径与「已保存/仅检查点/失败」三种结果之一。目标已存在时不猜意图：给未占用名或提示「导出副本 / 保留草稿 / 放弃草稿」。

### 3.5 原文件替换事务（§5.2，阶段 4）

仅在用户明确要求「就地替换同一路径」时进入：写持久日志 → 同卷准备已校验候选 + 恢复副本 → 复检哈希/权限/回收站可用性 → 取插件锁 → 回收站删除原文件并确认 → 用「真正不覆盖」的方式发布（硬链接 `link()` 到目标名，失败即已存在）→ 校验发布结果 → 清日志。

平台限制照抄 DESIGN：DSH 的删除 API 不是回收站，**Linux 与网络盘只允许另存**。Windows 上用 `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(..., SendToRecycleBin)` 走真回收站，且该能力在启用前必须由测试证明（不可用时安全降级为另存），安全路径（另存）不依赖它。

### 3.6 清理设置（§6）

三档：禁用 / 自动（agent 决定）/ 开启（校验交付后自动清）。删除前置条件全部满足才动手：交付已验证且产物在工作文件夹外，或用户明确放弃草稿；无进行中任务/未完成提交/未完成恢复；目录身份与台账一致；无用户新增或未登记文件。任何一项不满足都保留并如实汇报。

### 3.7 运行时检测/安装/更新（§7）

- 私有安装目录：`<dshHome>/betteroffice/runtime/<version>/`（不含 PATH 变更、不碰全局）。
- 检测：配置的显式路径 → 私有版本 → 外部安装（只报告，不自动使用、不修改、不自动选中）。
- Node 检测：`node`（或显式配置）→ 版本 ≥ 22.12.0 才可用，否则给出具体原因。
- 安装/更新/回退：仅配置页的人工动作，有权限校验；后台任务绝不触发。更新与回退并列安装、校验 + 冒烟测试后只切换「新任务默认版本」，已有任务继续用台账记录的版本。
- 实现手段：调用 npm registry 元数据（`registry.npmjs.org/@betteroffice/agents`）+ 安装到私有目录；tarball 完整性（`sha512`）在安装后复核。

### 3.8 配置页（阶段 3）

- 页面按包名注册进 `设置 → 插件配置 → BetterOffice`；配置经 DSH 设置机制写入插件自己的 volatile 配置层，不改写用户 profile 配置。
- 简单开关（是否使用工作文件夹、清理模式、Node 路径、运行时来源）走 `Config` 的 `.volatile()` 字段，由 DSH 自动渲染。
- 动作型按钮（检测/安装/检查更新/更新/回退）走 Host HTTP 路由，用 `admitRoute`（回环 ∪ 连接鉴权）做栅栏，不用 `hasSameOriginProof`（桌面外壳转发 `dsh-app://app/api/…` 时会剥掉 origin，但始终带 session cookie）。
- **兜底（你已确认）**：客户端半部需要浏览器 bundle 与 DSH 客户端模块 id 的准确用法，本轮未验证。阶段 3 开头先做 spike（限时 30 分钟）；不通过则退化为「DSH 自动生成的设置页（覆盖全部 volatile 开关）+ `/betteroffice` 命令触发检测/安装/更新/回退」，并把结论回写 README 与 DESIGN.md。

---

## 4. 数据与持久化

| 数据       | 位置                                                                                    | 说明                         |
| ---------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| 任务台账   | `<工作文件夹>/.betteroffice-task.json` + `<dshHome>/betteroffice/journal/<taskId>.json` | 双写；后者用于跨重启恢复     |
| 私有运行时 | `<dshHome>/betteroffice/runtime/<version>/`                                             | 版本并列存放，回退即切默认   |
| 临时工作区 | 系统临时目录下 `betteroffice/<taskId>/`                                                 | 不使用工作文件夹时的编辑目录 |
| 配置       | DSH 插件 volatile 配置层                                                                | 不直接改 profile 文件        |

---

## 5. 技术形态与代码结构（TypeScript 全链路）

`src/**/*.ts` → `tsc -p tsconfig.json` → `lib/src/**/*.js` + `lib/src/**/*.d.ts`；`package.json` 的 `main` 为 `lib/src/index.js`，`types` 为 `lib/src/index.d.ts`。测试同一次编译产出到 `lib/test/`，用 `node --test lib/test/*.test.js` 跑。单一 tsconfig（`rootDir: "."`、`outDir: "lib"`），不引入第二个测试配置。

tsconfig 关键项：`module: "nodenext"`、`moduleResolution: "nodenext"`、`target: "es2023"`、`strict: true`、`declaration: true`、`sourceMap: true`、`skipLibCheck: true`。

依赖（已由一个子代理在 npm 上实机核查，四个包全部公开且自带类型，**不需要手写 `types/*.d.ts`**）：

```jsonc
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.1.0",
  "@deepseek-ai/schemastery": "^3.19.0 || 3.20.0-alpha.1",
  "@hyzyn/dsh-kit": "^0.8.1"
},
"devDependencies": {
  "typescript": "~5.9.3",
  "@types/node": "^22"
}
```

- `@hyzyn/dsh-kit@0.8.1` 的 `lib/services.d.ts` 首行 `import type { Context } from '@deepseek-ai/cordis'`，所以 cordis 必须装（devDep），否则 dsh-kit 的类型解析直接失败。
- schemastery devDep 取 **3.20.0-alpha.1**（与本机 profile 宿主一致），避免「编译期 3.19 / 运行期 3.20」的 API 漂移；peer 范围因此写成 `^3.19.0 || 3.20.0-alpha.1`（`^3.19.0` 默认不匹配 prerelease）。
- ~~`@deepseek-ai/dsh-mcp-client` 只取最小类型面~~：已随 `c3e9629` 的自带连接器一起去掉，当前三个 peer 包即全部运行时依赖。
- 宿主 cordis 真实版本无法从本机确认（在 app.asar 内），peer 先写 `^4.1.0`；若宿主是 4.2 alpha 再放宽。

代码结构（文件数控制到最少）：

```
package.json            name dsh-betteroffice, main lib/src/index.js, dsh.{bundle,client}
tsconfig.json
cordis.patch.yml        - insert: [{ id: betteroffice, name: 'dsh-betteroffice' }]
src/index.ts            插件入口 name/inject/Config/apply
src/config.ts           Config（volatile 字段）
src/paths.ts            路径解析、规范路径、身份校验、权限检查
src/workspace.ts        命名、独占创建、台账读写
src/mcp.ts              MCP 连接器（spawn + JSON-RPC，自带超时与退出等待）
src/tasks.ts            任务注册表 + 连接器挂载/卸载
src/tools.ts            5 个 agent 工具
src/deliver.ts          另存交付
src/replace.ts          替换事务（阶段 4）
src/runtime.ts          运行时检测/安装/更新/回退
src/http.ts             配置页路由
client/                 客户端半部（阶段 3，先 spike）
test/*.test.ts          node:test
```

---

## 6. 测试策略

全部用 `node:test`，每一阶段按 TDD 走（先失败测试再实现）：

- **纯函数优先**：命名器、路径规范化/非法字符剔除/截断、台账序列化、未占用名生成、root 决策矩阵——不碰磁盘，最容易先写测试。
- **临时目录集成**：用 `fs.mkdtemp` 造真实 docx/xlsx/pptx（最小 zip 容器即可），验证只读打开不改源文件字节、哈希不变、检查点不覆盖旧检查点、交付目标已存在时失败。
- **MCP 挂载**：单测以假 MCP 客户端（注入的 `loadClient`）验证挂载参数、幂等、销毁回收；真实挂载只在手工验收里跑，不进 CI。
- **替换事务**：单测覆盖日志各阶段的崩溃点恢复（注入故障点），回收站能力用「可用/不可用」双桩验证降级。

环境注意（实机核查得出，写进计划，不要当项目缺陷排查）：本机沙箱下裸跑 `node --test` 可能报 `EPERM errno -4048 syscall 'spawn'`（子进程管道受限），加 `--experimental-test-isolation=none` 即可；npm 默认 cache 也会被拦，需要 `--cache <workspace>/.scratch/npmcache`。

---

## 7. 分阶段实施与提交切分

| 阶段 | 内容                                                                                                                  | 提交                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 0    | 脚手架：package.json、tsconfig、cordis.patch.yml、.gitignore（`.scratch/`、`.acl-recovery/`）、测试骨架、依赖安装验证 | `chore: 脚手架与仓库卫生`            |
| 1    | paths / workspace / tasks / tools.mount：只读打开 + MCP 挂载 + 5 工具骨架                                             | `feat: 只读打开与按 agent 挂载 MCP`  |
| 2    | 副本编辑 + 工作文件夹 + 检查点 + 交付                                                                                 | `feat: 工作文件夹、检查点与另存交付` |
| 3    | 运行时检测/安装/更新/回退；清理模式；配置页（含 spike）                                                               | 拆 2~3 个提交                        |
| 4    | 原文件替换事务（回收站 + 日志恢复）                                                                                   | `feat: 原文件替换事务`               |

每阶段结束前跑：`tsc -p tsconfig.json` 无错 + `node --test --experimental-test-isolation=none lib/test/*.test.js` 全绿 + 手工验收表里该阶段相关项。

---

## 8. 验收对照

沿用 DESIGN §8 验收表，并补齐本设计新增项：

- 两个会话打开同一文件：root 互不可见，源文件哈希不变。
- 工作文件夹跨 3 轮检查点后重启 Host：任务可从台账恢复，检查点可继续。
- 中文名/超长名/同秒同名：命名合法且独占创建不冲突。
- 交付目标已存在：不覆盖，给出未占用名或询问。
- 仅显式同路径意图才进入替换；中断后按日志恢复到「原文件在位」或「替换已确认」，不留半成品。
- 清理三档行为一致；任一前置条件不满足则保留并汇报。
- 运行时：无外部安装时用私有版本；外部安装只报告；更新/回退后新任务用新版本、旧任务用旧版本。
- 非受权用户/agent 无法触发安装、更新、回退。

---

## 9. 仍未验证的点（实现时先做小验证，不通过按上面对策降级）

1. 客户端半部：DSH 客户端模块 id 与卡片挂载点（阶段 3 spike，已获兜底授权）。
2. `@hyzyn/dsh-kit` 的 settings/http 封装在当前 DSH 版本（宿主 cordis 版本未知）的实际行为（阶段 1 先用最小面）。
3. Windows 回收站 API 在 DSH 运行环境内的可用性与权限（阶段 4 开门第一件事）。

---

## 10. 决策记录

| 时间   | 决策                                                         | 理由                                                                                                    |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| m00228 | 四阶段全做、按工序提交；不内置运行时；薄封装 + 挂载 MCP      | 你的选择                                                                                                |
| m00549 | 只读 root 照原文：原文件父目录                               | 你的选择；残余风险已在 §3.1 记录                                                                        |
| m00549 | TypeScript 全链路                                            | 你的选择；四个 peer 包已核实公开可装且带类型                                                            |
| m00549 | 配置页 spike 不通过则退化为自动设置页 + `/betteroffice` 命令 | 你的选择                                                                                                |
| 本轮   | 编辑 root 用工作文件夹根（仍偏离原文）                       | `office_export` 只认 root 内相对路径，否则检查点写不进 `checkpoints/`；未被否决，保留                   |
| 本轮   | 不再依赖 `dsh-mcp-client`，MCP 连接器自带                    | 宿主沙箱不暴露 `ctx.plugin`，scope 挂载走不通；顺带消掉 dev/peer 版本矛盾（0.0.1-rc.1 vs >=0.1.7-rc.2） |
