# dsh-betteroffice 发布到 npm 的最小方案

> 只发一个插件包、没有 monorepo、没有 CI 诉求，所以不引入 semantic-release / changesets / release-please。
> 结论：`npm login` + `npm publish` 两条命令，配 4 处 package.json 修补。

## 现状核查（已实测）

| 项                                            | 结果                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm view dsh-betteroffice version`           | 404 → **这个名字在 npmjs 上没人占**，可以直接发                                                                                                            |
| `npm whoami`                                  | `ENEEDAUTH` → 这台机器还没登录 npm                                                                                                                         |
| `npm pack --dry-run`                          | 61 个文件 / 58.2 kB；含 `lib/src/*`（js+d.ts）、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`；**没有** `lib/test`、`.scratch`、`docs`、配置文件 |
| `prepack` / `prepare` 脚本                    | **都没有** → `lib/` 是构建产物且被 git 忽略，忘了 `npm run build` 就会把旧包或空包发出去                                                                   |
| `repository` / `bugs` / `homepage` / `author` | 全缺 → npm 页面没有源码链接，顶部还会挂「缺 repository」提示                                                                                               |
| devDep vs peer                                | devDep `@deepseek-ai/dsh-mcp-client@^0.0.1-rc.1`，peer 却要求 `>=0.1.7-rc.2` → 本地跑的是比声明老的 API                                                    |
| `engines.node`                                | 没声明，但运行时要求 Node ≥22.12                                                                                                                           |

包内容本身是干净的，问题全在「发之前容易漏构建」和「页面信息不全」这两类。

## 任务 1：改 package.json（4 处，约 10 行）

1. **加 `prepack`**（关键项）：

```json
"prepack": "npm run build"
```

用 `prepack` 而不是 `prepare`：`prepare` 在消费者 `npm i` 时也会跑，会要求对方有 typescript；`prepack` 只在 `npm pack` / `npm publish` 前跑。

2. ~~**对齐 mcp-client 版本口径**~~：已改为直接删掉这个依赖（全库零 import，见「已落地」一节），不需要再对齐版本。

3. **补元信息**：

```json
"repository": { "type": "git", "url": "git+https://github.com/<你>/dsh-betteroffice.git" },
"homepage": "https://github.com/<你>/dsh-betteroffice#readme",
"bugs": { "url": "https://github.com/<你>/dsh-betteroffice/issues" },
"author": "…",
"engines": { "node": ">=22.12.0" }
```

4. **可选瘦身**：`files` 里的 `"lib/*.d.ts"` 删掉——`rootDir: "."` 下没有根级 `.d.ts`，`--dry-run` 也证明确实没打进去。

## 任务 2：本地彩排（不联网发布）

```powershell
npm run check          # build + 211 测试
npm pack --dry-run     # 61 文件、无 lib/test、无 .scratch；prepack 会自动构建
npm publish --dry-run  # 走到上传前一步，验证 tarball 与脚本
```

任何一步不对就停，不要往下走。

## 任务 3：登录并发布

```powershell
npm login --registry=https://registry.npmjs.org   # 本机 registry 是 npmmirror 镜像，必须显式指回官方
npm whoami                                        # 必须打印你的用户名

npm publish --registry=https://registry.npmjs.org # 无 scope → 默认 public；开了 2FA 会要 OTP
```

**版本与 tag 策略（建议）**：DSH 本身还在 rc（`dsh.engines.dsh >= 0.1.7-rc.2`），首发建议发预发布：

```powershell
npm version 0.1.0-rc.1 --no-git-tag-version
npm publish --tag next
```

这样 `latest` 留给 DSH 稳定后的正式版，用户装 `@next` 才是尝鲜。若你确定 0.1.0 就是要给所有人用的首个版本，直接 `npm publish` 即可（`latest`）。

## 任务 4：发布后验证（5 分钟）

```powershell
npm view dsh-betteroffice version dist.tarball files
```

再在**空目录**里做一次消费者视角的安装：

```powershell
mkdir C:\tmp\bo-check; cd C:\tmp\bo-check
npm init -y; npm i dsh-betteroffice
node -e "import('dsh-betteroffice').then(m => console.log(Object.keys(m).slice(0, 8)))"
```

最后在 DSH 里真实装一次（GUI 设置 → 插件，或你本机的 `dsh plugin` 命令），确认卡片和五个工具都出现。

## 任务 5（可选）：以后怎么发下一版

```powershell
npm version patch|minor --no-git-tag-version   # 或让 npm 建 tag
npm run check
npm publish
```

想做自动化再加 GitHub Actions（tag 触发 + `--provenance`），现在没必要。

## 风险与注意

- **0.1.0 一旦发出，这个版本号就永久占用**（72 小时内可 unpublish，之后只能废弃）。所以先 `--dry-run`。
- 缺 `prepack` 是这套方案里唯一会真正发出坏包的坑，务必先改。
- 若 DSH 对插件包有 scope 要求（比如必须 `@你/dsh-betteroffice`），先按那个名字重新确认未被占用；当前无 scope 名字可用。
- peer 版本不一致会让 `npm i` 在 npm 7+ 报 `ERESOLVE` 警告甚至失败，属于发之前就该修的口径问题。

## 已落地（2026-11-28，本次改动）

**package.json**

- 加 `prepack: npm run build`——`lib/` 是 git 忽略的构建产物，这一条是防「发旧包/空包」的唯一保险。
- 补 `repository`（`github.com/kuainx/dsh-betteroffice`）、`homepage`、`bugs`、`author`、`engines.node >=22.12.0`。
- 删 `files` 里的 `lib/*.d.ts`（没有根级 `.d.ts`，打包清单本就没它）。
- 删掉 `@deepseek-ai/dsh-mcp-client`：全库（src/test/client.js）**没有任何 import**，而 devDep 是 `0.0.1-rc.1`、peer 却写 `>=0.1.7-rc.2`，两个声明互相矛盾且都用不上 → devDependencies 与 peerDependencies 各删一条，lock 同步移除。

验证：`npm run check` → 211 pass / 0 fail；`npm pack --dry-run` → 61 文件 / 58.3 kB，内容与发布前一致。

**新增 `.github/workflows/publish.yml`**：改 `package.json` 的 version 推 main（或手动推 `v*` tag）→ 读版本 → npm 上已有就跳过 → 没有 tag 就补一个 → `npm ci` → `npm run check` → `npm publish --provenance`。

## GitHub 自动发版（OIDC，不存任何 token）

已核实的三个约束：

1. **首次发布不能用 OIDC**。npm 的 Trusted Publisher 配置挂在「包自己的 Settings 页」上，包不存在就没有那个页面。npm 官方 issue [#1926](https://github.com/npm/documentation/issues/1926) 至今 open，结论是：先手动发一次，之后的版本才走 OIDC。
2. **npm CLI 需 ≥ 11.5.1**，Node 22 自带的是 10.x → workflow 里加了 `npm install --global npm@11`。
3. 需要 `permissions: id-token: write`，`--provenance` 才会生成签名与包页面的 Verified 徽章（要求仓库公开）。

手动首发的收尾（只做一次）：

```
npmjs.com → 你的包 → Settings → Trusted publishing → Add
  Publisher:            GitHub Actions
  Organization/user:    kuainx
  Repository:           dsh-betteroffice
  Workflow filename:    publish.yml
  Allowed actions:      勾选 npm publish
```

以后每次发版：只改版本号，推到 main 就行（tag 由 workflow 自己补）。

```powershell
npm version patch --no-git-tag-version   # 只改 package.json 和 lock，不建 tag
git commit -am "release: 0.1.1"
git push
```

判定的顺序：

- `push` 到 main 且 `package.json` 有变化才进 workflow（`paths` 过滤），别的提交不会白跑。
- npm 上已有这个版本 → 整段跳过。所以同一版本重复推、或只改了 package.json 的别的字段，都不会重发。
- 没有 `v<版本>` tag 就建一个并推上去；tag 已存在（上次发布中途失败）就复用它继续发。
- 手动 `git tag v0.1.1 && git push origin v0.1.1` 也照样触发，但会先校验 tag 与 `package.json` 版本一致，不一致直接失败——不会把版本号对不上的东西发出去。
- workflow 用 `GITHUB_TOKEN` 推的 tag 不会再触发一次 workflow（GitHub 的规定），所以不会自己套娃重复发布。

注意：`on.push` 里同时写了 `branches` 和 `tags` 时，`paths` 过滤只对分支生效、对 tag 推送不生效（[官方语法说明](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchesbranches-ignoretagsbranches-ignore)），所以手动打 tag 的路径不会被 `paths` 挡掉。

**兜底方案**（不想用 OIDC，或 OIDC 换令牌失败）：在 npm 建一个 Granular Access Token（只授权 `dsh-betteroffice` 的 publish、开启 2FA bypass），存成仓库 secret `NPM_TOKEN`，workflow 里给它 `env: NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` 并去掉 `--provenance`。代价是多一个长期密钥要轮换。

## 本机 registry 的坑（会导致发布失败）

这台机器 `npm config get registry` = `https://registry.npmmirror.com/`。镜像是只读的，`npm publish` 打到镜像上会直接失败。所以本地登录与发布都要显式带 `--registry=https://registry.npmjs.org`（上面的命令已带）；CI 里 `actions/setup-node` 的 `registry-url` 已指向官方源，不受影响。

## 实际发布记录（已验证）

| 版本  | 怎么发的                                               | 结果                                                                 |
| ----- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| 0.1.0 | 本地手动：`npm login` → `npm publish`                  | 第一次 403（账号 2FA），带 `--otp` 重跑成功                          |
| 0.1.1 | OIDC。第一次 CI 挂了（见坑 2），修好后 Re-run all jobs | `gitHead` = 5789440，`_npmUser` = GitHub Actions，带 SLSA provenance |
| 0.1.2 | OIDC。改版本号推 main，全自动                          | `gitHead` = 49de6a2 = 当次 HEAD，tag `v0.1.2` 由 workflow 自动创建   |

两条命令就能确认一次发布是真的（本机 npm 缓存目录写不进去时，把 `--cache` 指到仓库里）：

```powershell
npm view dsh-betteroffice dist-tags --registry=https://registry.npmjs.org --cache .\.npm-cache
npm view dsh-betteroffice@<版本> gitHead _npmUser.name dist.attestations.provenance.predicateType --cache .\.npm-cache
```

`_npmUser.name` 是 `GitHub Actions` 而不是你自己的用户名，说明 OIDC 换令牌成功；`gitHead` 与本地提交对得上，说明发出去的确实是你以为的那个提交。

### 坑 1：`0.0.0-stage` 是哪来的

首次发布时 registry 上会先出现一个 `0.0.0-stage` 版本（`stub: true`，2 个文件 338 B，描述是 `Temporary package placeholder for staged publishing`）。它是 npm 在正式上传前建的占位版本，归属仍是发布者本人 —— 不是被抢注。那一小段时间里 `dist-tags.latest` 指向它，如果正好在这几十秒内跑 `npm view`，会看到版本是 `0.0.0-stage`，换掉缓存再查就是真实版本。它不参与安装，不用清理（也删不掉）。

### 坑 2：CI 上挂掉的测试，本地是绿的

`0.1.1` 第一次 CI 就红在这里：`lib/test/mcp.test.js` 的「子进程不肯退出时 close 也不无限等」报 `Promise resolution is still pending but the event loop has already resolved`，同一进程里后面 20 多条测试被连带标记成 `cancelledByParent`。

根因是 `src/mcp.ts` 的 `close()` 给兜底定时器加了 `unref()`：假子进程永远不退出时，事件循环里唯一还没结束的对象就是这个定时器，`unref` 之后进程直接走完，`await` 永不返回。本地 node 24 容忍这种写法、CI 的 node 22 不容忍 —— **所以「本地绿」对这类问题不构成证据**；改动碰到事件循环或定时器时，要在 node 22 上跑一次 `npm run check`。

### 待办（不影响发布）

`package-lock.json` 里 52 个 `resolved` 仍指向 `registry.npmmirror.com`。CI 已经能装（0.1.1、0.1.2 都跑通了），只是从国内镜像拉包慢。想统一成官方源：`npm install --package-lock-only --registry=https://registry.npmjs.org`，用 `git diff` 复核后单独提交。
