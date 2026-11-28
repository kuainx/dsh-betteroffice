# 全局格式检查与修正 实施方案（oxfmt + oxlint）

> **给执行者：** 用 superpowers:executing-plans 或 subagent-driven-development 按任务执行，步骤用 `- [ ]` 勾选跟踪。

**目标：** 用可重复的命令全局检查缩进/格式与基础 lint，修掉已知的 `src/tools.ts` 那处（`function toolList` 顶格），并让以后不再漂移。

**做法：** 引入 `oxfmt`（格式化）与 `oxlint`（默认规则集），配置走 `.oxfmtrc.json`；格式化先 `--check` 量差异，再单独一个 style-only 提交做写盘；lint 首跑做逐条分类。同时加 `.editorconfig` 挡住编辑器带进 tab/CRLF。不引入 Prettier/ESLint。

**技术栈：** oxfmt（Rust，Prettier 兼容 >95%，beta 阶段）、oxlint（默认只开 correctness 类）；`tsc` 与 `node --test` 不变。

**依据：** 本轮扫描结论（61 个文件：src 27 个 `.ts` + test + `client.js`）：0 个 tab、0 个 CRLF、0 行行尾空格、注释外层 0 处奇数缩进。已知缺陷 `src/tools.ts:247` 恰好是「2 的倍数」缩进，纯奇偶校验抓不到 → 必须用真正的解析器/格式化器。

## 已知事实（省得再查）

- oxfmt：配置文件名 `.oxfmtrc.json`（也支持 `oxfmt.config.ts`，但同一目录不要混用）；格式风格只能用配置指定，**没有** `--no-semi` / `--single-quote` 这类 CLI 开关；忽略文件走配置里的 `ignorePatterns`，或复用 `.prettierignore`，并且默认尊重 `.gitignore`。
- oxlint：配置文件 `.oxlintrc.json` / `.oxlintrc.jsonc` / `oxlint.config.ts`；默认开启的是 **correctness** 类，`suspicious` / `pedantic` / `perf` 等默认关闭，需要 `-D <category>` 才开。`--init` 生成默认配置。
- 两者都随包带平台原生二进制（走 optionalDependencies），Windows 无需编译；离线/内网镜像要确认镜像同步了 `@oxc-*` 系列包。

## 全局约束

- 只做格式改动：`git diff -w`（忽略空白）必须为空，证明没有逻辑变化。
- 格式化后 `npm run build` 零错误、`npm test` 全绿（当前基线 211 pass / 0 fail）。
- 不改 `client.js` 里模板字符串的内容、不改任何中文文案。
- 不碰 `lib/`（tsc 产物）、`node_modules/`、`.scratch/`。
- oxfmt 是 beta：按用户要求用普通 caret 版本（不锁死），升级后重跑任务 3 的 `git diff -w` 验证零逻辑变化。
- 沙箱限制：`npm i` / `npx` 需要写 `C:\Users\KUAI\AppData\Local\npm-cache`，受限沙箱会 EPERM。装依赖那一步要在普通终端跑，或申请一次 `danger-full-access`。

## 文件结构

- 新建 `D:\Github\dsh-betteroffice\.oxfmtrc.json`：5 个风格项 + `ignorePatterns`。
- 新建 `D:\Github\dsh-betteroffice\.oxlintrc.json`：默认规则（空对象即可），只在任务 4 有据可依时才加规则。
- 新建 `D:\Github\dsh-betteroffice\.editorconfig`：缩进 2 空格、LF、去行尾空格、文件末尾换行。
- 修改 `D:\Github\dsh-betteroffice\package.json`：devDependencies 加两包，scripts 加 `format` / `format:check` / `lint`。

---

### 任务 1：装 oxfmt 与 oxlint，写配置（不动源码）

**文件：** 新建 `.oxfmtrc.json`、`.oxlintrc.json`；修改 `package.json`（devDependencies）

**接口：** 产出 `npx oxfmt --check .` 与 `npx oxlint src test` 两条可运行命令；后续任务只依赖这两条。

- [ ] **步骤 1：安装（不锁版本，由用户在本机终端执行）**

Run: `npm i -D oxfmt oxlint`
Expected: devDependencies 里出现 `"oxfmt": "^x.y.z"` 与 `"oxlint": "^x.y.z"`；`node_modules\.bin\oxfmt.cmd`、`oxlint.cmd` 存在。

- [ ] **步骤 2：写 `.oxfmtrc.json`**

```json
{
  "semi": false,
  "singleQuote": true,
  "printWidth": 100,
  "arrowParens": "always",
  "trailingComma": "all",
  "ignorePatterns": ["lib/**", "node_modules/**", ".scratch/**"]
}
```

- [ ] **步骤 3：写 `.oxlintrc.json`（先只有默认值）**

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json"
}
```

- [ ] **步骤 4：确认两条命令能跑**

Run: `npx oxfmt --check .`
Expected: 输出不达标文件列表（或 all files formatted），退出码 0/1 均可，重点是不报「未知选项」。

Run: `npx oxlint src test`
Expected: 打印未用变量/无用代码等告警与统计；不报配置错误。把总告警数记下来（任务 4 的输入）。

- [ ] **步骤 5：提交（只有配置与依赖）**

```bash
git add .oxfmtrc.json .oxlintrc.json package.json package-lock.json
git commit -m "chore: 引入 oxfmt 与 oxlint，配置对齐现有手写风格"
```

---

### 任务 2：用 oxfmt 量差异（仍不写盘）

**文件：** 不改

**接口：** 消费任务 1 的 `.oxfmtrc.json`；产出「受影响文件清单与总数」，决定任务 3 范围。

- [ ] **步骤 1：只检查**

Run: `npx oxfmt --check .`
Expected: 列出不达标文件。

- [ ] **步骤 2：按数量定范围**

- 1–5 个文件 → 直接进任务 3。
- 6–20 个 → 进任务 3，但在提交信息里写清「纯格式」。
- 超过 20 个 → 停下问用户：是接受一次大 diff，还是先调 `printWidth`（如 80/120）再测一遍。

- [ ] **步骤 3：确认 `src/tools.ts` 在清单里**

Run: `npx oxfmt --check src/tools.ts`
Expected: 不通过（那处 `function toolList` 顶格就是要修的）。若已通过，说明配置没读到——检查 `.oxfmtrc.json` 的位置与文件名。

---

### 任务 3：一次性格式化，单独一个 style-only 提交

**文件：** `src/**/*.ts`、`test/**/*.ts`、`client.js`（仅空白/换行）

- [ ] **步骤 1：写盘**

Run: `npx oxfmt .`
Expected: 所有文件按配置重排；无报错。

- [ ] **步骤 2：证明没有逻辑变化**

Run: `git diff -w --stat` 和 `git diff -w`
Expected: `--stat` 列出文件与行数；正文为空（全是空白差异）。出现非空白差异时逐处看过再决定是否保留。

- [ ] **步骤 3：看卡片没被改坏**

Run: `git diff client.js | Select-Object -First 80`
Expected: 只有缩进/换行变化；模板字符串里的 HTML/CSS 文本内容不变。

- [ ] **步骤 4：构建与测试**

Run: `npm run build && npm test`
Expected: tsc 零输出；`211 pass / 0 fail`。

- [ ] **步骤 5：提交**

```bash
git add -A
git commit -m "style: 用 oxfmt 统一缩进与格式（无逻辑变化）"
```

---

### 任务 4：oxlint 首跑分类处理

**文件：** `src/**/*.ts`、`test/**/*.ts`（按需）、`.oxlintrc.json`（仅在规则明确不适用时才改）

**接口：** 消费任务 1 记下的告警总数；产出「0 error」的 lint 结果，每一条残留要么修掉，要么在代码里带原因 disable。

- [ ] **步骤 1：跑一遍，存档输出**

Run: `npx oxlint src test 2>&1 | Tee-Object -FilePath .scratch\oxlint-first-run.txt`
Expected: 完整告警清单落到文件，便于逐条勾。

- [ ] **步骤 2：三分类**

- **真问题**（未用变量/未用导入、无效比较、可疑断言、`catch` 空吞）→ 直接改代码，改完跑 `npm test`。
- **确认无害**（如测试里故意未用参数）→ 在该行加 `// oxlint-disable-next-line <rule> -- 原因`，原因必须写为什么。
- **规则与项目不符** → 在 `.oxlintrc.json` 的 `rules` 里关掉该条，并在配置里用注释写理由（`.oxlintrc.jsonc` 支持注释）。

不允许「整类关闭」或直接把 `lint` 从 `check` 里去掉。

- [ ] **步骤 3：确认归零**

Run: `npx oxlint src test`
Expected: 0 warning / 0 error（或只剩已 disable 的）。

- [ ] **步骤 4：提交**

```bash
git add -A
git commit -m "fix: 处理 oxlint 首轮告警，逐条修掉或注明禁用原因"
```

---

### 任务 5：接进 `npm run check`，补 `.editorconfig`

**文件：** 修改 `package.json` scripts；新建 `.editorconfig`

- [ ] **步骤 1：改 scripts**

```json
"build": "tsc -p tsconfig.json",
"format": "oxfmt .",
"format:check": "oxfmt --check .",
"lint": "oxlint src test",
"test": "node --test --experimental-test-isolation=none \"lib/test/**/*.test.js\"",
"check": "npm run build && npm run format:check && npm run lint && npm test"
```

- [ ] **步骤 2：写 `.editorconfig`**

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **步骤 3：整条链路验证**

Run: `npm run check`
Expected: build 零输出 → 格式检查通过 → lint 0 告警 → `211 pass / 0 fail`。

- [ ] **步骤 4：提交**

```bash
git add package.json .editorconfig
git commit -m "chore: 格式与 lint 接入 npm run check，补 .editorconfig"
```

---

## 备选方案（不想加原生二进制依赖时）

用仓库已有的 `typescript`（devDependency，离线可用）写约 60 行的 `scripts/check-indent.mjs`：`ts.createSourceFile` 解析后按 AST 深度算期望缩进，不一致打印 `文件:行:列`。能抓到 `tools.ts:247` 这类问题，但只覆盖缩进、不覆盖换行/引号，且脚本本身是要维护的代码。只在「装不了二进制」时才选。

## 评审关注

- oxfmt 是 beta：小版本之间输出可能变；没锁版本，`npm i` 拉到新版后要重跑任务 3 的 `git diff -w` 验证，diff 一旦出现非空白改动就单独处理。
- oxlint 的「默认全开」只是 correctness 类，不是所有类目；要更严需显式 `-D suspicious` 等，别误以为已经查全。
- `client.js` 是插件前端源码：先不纳入 lint（浏览器全局、模板字符串多，噪音大），单独想清楚再加。
- `printWidth: 100` 与现有断行习惯不一致会产生大量纯换行 diff → 任务 2 的「超过 20 个就停」就是闸门。
- `ignorePatterns` 漏 `lib/**` 会让 tsc 产物被格式化，下次 build 又改回来，来回抖动。
- Windows + 沙箱：`npm i` / `npx` 需要 npm cache 写权限，受限模式下 EPERM，不是配置问题。
