# AgentHub 独立维护分支（FORK 说明）

> 本文件是本仓库（`yangwenjie1231/AgentHub`）的维护说明。
> 上游是 [HUIdada1/AgentHub](https://github.com/HUIdada1/AgentHub)，原作者沐晖（HUIdada1）。
>
> **AI agent 请先读 [AGENTS.md](./AGENTS.md)**（入口索引 + 硬性约束），再回到本文查细节。

## 快速导航

| 我要… | 看这节 |
| --- | --- |
| 知道为什么回退、基线是哪个 commit | 一、二 |
| 推代码 / 看远程拓扑 | 三 |
| 知道本 fork 改了什么、移植了什么 | 四 |
| 定版本号 / 发版 | 五、六 |
| **确认能不能这么用（授权）** | **七（必读）** |
| 跟进上游（哪些能 cherry-pick、哪些必须 SKIP） | 八 |
| **修上游风控相关的问题** | **九** |
| 跑自测 / 看 CI | 十、十一 |
| 排坑 | 十二 |

---

## 一、为什么回退

上游在 **v1.83.0**（commit `fdb3e55`「refactor(pool): 反代网关停止维护，改造为号池管家」）中
**下线了「反代网关」板块**：

| 被下线的内容 | 说明 |
| --- | --- |
| 转发链路（`server` / `provider` / `ccswitch` / `remote` / `inflight`） | 归档到「废弃代码（禁止git提交推送）/」，并加入 `.gitignore` |
| API Keys、模型目录、用量统计、自定义提供商、生态接入 | 配置页只保留额度监控与凭证数据 |
| 网络代理（出口池） | 端口 / 路由 / 规则热加载 / 远程实例一并移除 |
| Docker 版与远程实例 | `gateway/` 目录整体删除 |
| 记忆中枢的「本机网关」档位 | v1.85.0（`a5d160e`）把模型来源收敛为「自定义供应商 + 内置降级档」 |

本分支的目的就是**保留一个可用、可自行维护的反代网关**，同时继续跟进上游其它模块的改进。

---

## 二、回退基线

| 项 | 值 |
| --- | --- |
| 基线 commit | `bbe8373`（`feat(billing): 接入 New API 站点价格源…`） |
| 对应上游版本 | **v1.82.2**（上游 tag `v1.82.2` = `f562916`，是 `bbe8373` 的父提交） |
| package.json 版本 | 已改为 `1.86.0`（本 fork 独立编排，见第五节） |
| 上游最新版本 | v1.85.0（`a5d160e`）——**已无反代网关**，不可直接合并 |

`bbe8373` 是**最后一个反代网关完整可用**的提交：它比 tag `v1.82.2` 多一个提交
（New API 价格源），且额外包含上游 `feat/gateway-docker` 分支上的全部 Docker 形态工作
（`70f8d69` 及其祖先 4 个提交，已是 `bbe8373` 的祖先，无需 cherry-pick）。

基线包含的网关能力：

- `electron/backend/proxy/` —— 43 个后端模块（server / provider / pool / credits / rules / adapters / netproxy / 各渠道适配器等）
- `src/views/proxy/` —— 16 个前端视图（总览 / API Keys / 模型目录 / 自定义提供商 / 网络代理 / 用量统计 / 渠道切换 / 日志等）
- `gateway/` —— Docker 形态完整实现（Dockerfile / docker-compose.yml / src）
- `.github/workflows/gateway-ci.yml` —— 网关 Docker 形态 CI（自测 + 镜像构建 + 容器冒烟）

---

## 三、分支与远程拓扑

采用 GitHub 标准 fork 布局：**origin = 自己的 fork，upstream = 上游**。

> 为什么不是「origin 仍指上游、另加一个 fork 远程」：那样 `git pull` 会把**上游的
> gateway-less main 拉进来**——恰好是要躲的东西。上游代码 `electron/backend/memory/layout.cjs`
> 的注释已明确按「origin（自己的 fork）+ upstream（上游）」这个拓扑设计：
> 「一个仓库常同时挂 origin（自己的 fork）与 upstream（上游）」。

```
origin    →  https://github.com/yangwenjie1231/AgentHub.git   （本 fork，推送目标）
upstream  →  https://github.com/HUIdada1/AgentHub.git          （上游，只读参考）
```

本地分支：

| 分支 | 指向 | 用途 |
| --- | --- | --- |
| `main` | 回退基线 + 本 fork 的维护提交 | **日常开发分支**，与 fork 的 `main` 一致，跟踪 `origin/main` |

已完成的初始化（实际执行过的命令）：

```bash
git remote rename origin upstream                      # 原 origin 其实指上游
git remote add origin https://github.com/yangwenjie1231/AgentHub.git
git checkout -B main feat/gateway-maintain             # 本地 main 移到回退线
git branch -D feat/gateway-maintain
git push origin main --force                           # 覆盖 fork 继承来的 main
git branch --set-upstream-to=origin/main main
```

> **为什么要 `--force`**：fork 从上游继承的 `main` 停在 `a5d160e`（v1.85.0，无网关），
> 而回退线 `bbe8373` 是它的祖先，所以是「回退」而非快进。推的是自己的 fork，
> 且 `a5d160e` 仍可经 `upstream/main` 取到，历史不会丢。

fork 仓库当前状态：

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/yangwenjie1231/AgentHub |
| 可见性 | PUBLIC（GitHub 网络内的真 fork，parent = `HUIdada1/AgentHub`） |
| 默认分支 | `main` → 已指向本回退线 |
| 仓库描述 | 已标注「非官方 fork / 自行维护 / 非商业 / 同款授权」 |
| homepage | 指向上游仓库 |
| Issues / Wiki | 已开启 |

---

## 四、本 fork 已做的改动

与上游 v1.82.2 的差异，全部是「让 fork 能独立活着」所必需的改动，**不含功能删减**：

| 文件 | 改动 | 为什么必须改 |
| --- | --- | --- |
| `electron/backend/updater.cjs` | `GITHUB_REPO_URL` → 本 fork 仓库 | **最关键**：不改的话客户端会去上游查更新，把本 fork「更新」成没有反代网关的 v1.85.x，功能被静默抹掉 |
| `package.json` | `build.publish.owner` → `yangwenjie1231` | electron-updater 的更新源由 electron-builder 写入的 `app-update.yml` 决定，必须指向本 fork |
| `package.json` | `version` → `1.86.0` | 见第五节版本号规则 |
| `electron/backend/ipc.cjs` | 外链白名单同时放行本 fork 与上游 | 反馈入口指向本 fork；上游的致谢 / 授权链接仍需能打开 |
| `src/components/config/ConfigFeedbackSection.vue` | `REPO` → 本 fork | Issue 表单提交到本 fork 的 tracker |
| `tools/patch-release-notes.cjs` | `REPO` → 本 fork | 发版时写 Release body 到本 fork 的仓库 |
| `.github/workflows/release.yml` | 两处硬编码仓库 URL → 本 fork | tag 校验与 latest.yml 校验都指向本 fork |
| `tools/verify-project-regroup-e2e.cjs` | 断言放宽为「仓库族」 | 项目身份取自 `origin`，本 fork 的 origin 变了，钉死上游地址会误报失败 |
| `README.md` / `README.en.md` | 加 fork 声明；下载与 clone 链接指向本 fork | 避免用户从上游页面下到没有反代网关的版本 |
| `AGENTS.md` / `CLAUDE.md` | 新增（agent 入口索引；`CLAUDE.md` 是 `@AGENTS.md` 转发） | 让 AI agent 一进仓库就知道这是 fork、必读本文件、以及硬性约束（授权 / 不 merge 上游 / `SettingsTab` 雷区 / 改风控前先验方案新鲜度） |
| `FORK.md` | 新增 | 本文件 |

### 从上游移植的三个提交（已落地）

回退不是「停在旧版本不动」——上游在网关下线之后仍在改进计费与记忆中枢，
这些改动与网关正交，已经挑选移植过来：

| 上游 commit | 内容 | 与网关的关系 | 落地方式 |
| --- | --- | --- | --- |
| `58927fd` | 优化计费规则（新增 `billing_expr` 分层表达式解析、models.dev 预设解析、缓存读写价默认系数） | **零交集** —— 不碰任何网关文件，配置命名空间是 `billing.*`（网关在 `proxy.*`） | cherry-pick，零冲突 |
| `437afbd` | 模型与网关迁入全局设置，路由链独立成面板 | 相关但不冲突 —— 面板从记忆中枢搬到全局设置，**网关档保留**（只是默认序从第 2 位降到末位） | cherry-pick + 版本号冲突解 ours + **手工补 `models` 页签**（见下） |
| `a38940d` | 三套在线价格表同构卡片（官方倍率 / models.dev / 远程表），schema 9 → 10 | **零交集** —— 只动 `electron/preload.cjs` 的计费白名单段，网关 `proxy_*` 82 条完整保留 | cherry-pick，零冲突（须排在 `58927fd` 之后） |

移植后实测：`vue-tsc --noEmit` exit 0 · `vite build` exit 0 · 计费自测 65/0 ·
记忆供应商自测 66/0（基线 55/0）· `verify:memory` 26/0 · 网关闭包 145 文件完整 ·
代理命令表 8/0（82 条命令）· 网关自测 11/11。

> **`437afbd` 踩过的坑（务必知道）**：它依赖上游 `fdb3e55`（正是我们回滚掉的那个
> 网关下线提交）引入的 `src/types/index.ts` 改动 —— `SettingsTab` 联合类型加
> `"models"`、`SETTINGS_TABS` 加一个页签条目。cherry-pick **不会**把这两处带过来，
> 于是：编译期 9 条 TS 错误（`vue-tsc` 退出码 2）；即使绕过类型检查，设置弹窗
> **根本不渲染「模型与网关」页签**，整个面板静默不可达。
> 本 fork 已手工补齐（`src/types/index.ts` + `src/api/mock.ts`）。
> **后续若上游再动 `SettingsTab` 联合类型，需手工合并，不能直接 cherry-pick。**

**刻意没移植的**：`a5d160e`「网关档下线」—— 它正面删除记忆模型来源里的 `gateway` 档，
与本 fork 的前提直接矛盾。

---

### 刻意没改的

- `appId` / `productName` 保持 `com.huidada1.agenthub` / `AgentHub` —— 数据目录 `%APPDATA%\AgentHub`
  与上游连续，号池 / 记忆库 / 用量数据直接继承，不用迁移。
- 全部源文件的版权头与 `LICENSE` 原样保留 —— 见第七节。
- `electron/backend/proxy/` 与 `gateway/` —— 上游 v1.82.2 的代码，**一行未改**（移植三个提交
  也没碰它们），保证网关行为与上游 v1.82.2 完全一致。

---

## 五、版本号规则

**本 fork 的版本号与上游独立编排，不再跟随上游。**

- 基线是上游 `1.82.2`，但 **1.83 / 1.84 / 1.85 在上游代表的是「已砍掉反代网关」的版本**，
  在本 fork 语义里被占用会造成混淆。
- 因此本 fork 从 **`1.86.0`** 起编号（高于上游当前最高 1.85.0）。
  往后递增 `1.86.1` / `1.87.0` / …，**不回退、不复用上游已发布的号**。
- **不要用预发布号**（`1.86.0-beta.1` 这类）。原因：
  electron-builder 会把带预发布标识的版本发布成 GitHub **prerelease**，
  GitHub 不会把它标记为 Latest，于是 `releases/latest/download/latest.yml` 取不到，
  客户端的自动更新会永久失效。便携版的 `compareVersions` 与 electron-updater 的
  semver 比较对预发布号也不友好。

> 上游 tag 与本 fork tag 各自独立，互不占用。`release.yml` 的版本校验读的是本 fork 的 tag 列表。

---

## 六、发版流程

```bash
# 1. 改版本号（package.json），写更新说明
npm version 1.86.1 --no-git-tag-version
#    更新说明写到 build/release-notes.md 顶部（该文件同时是 Release body 与 latest.yml 的来源）

# 2. 本地校验（typecheck + 构建 + 记忆中枢自测）
npm ci
npm run build
npm run verify:memory

# 3. 提交并推送
git add -A && git commit -m "chore(release): v1.86.1 —— 说明"
git push origin main

# 4. 触发发版流水线（手动 dispatch，版本号留空即用 package.json 的 version）
gh workflow run release.yml --repo yangwenjie1231/AgentHub
```

发版前自查：

- [ ] `package.json` 的 `version` 已递增，且**严格高于**本 fork 仓库现有最高 tag
- [ ] `build/release-notes.md` 顶部有本次更新说明（客户端更新弹窗与 Release 页都读它）
- [ ] `npm run build` 通过（`vue-tsc` 类型门禁 + vite 打包）
- [ ] `npm run verify:memory` 通过
- [ ] `electron/backend/updater.cjs` 的 `GITHUB_REPO_URL` 与 `package.json` 的 `build.publish.owner` 都指向本 fork

---

## 七、授权与合规（必读）

上游的 `LICENSE` **不是纯 MIT**，而是「MIT + 附加使用条款」的复合授权：

- **MIT 部分**授予使用 / 复制 / 修改 / 合并 / 发布 / 分发 / 再许可 / 销售的权利，
  但以「保留版权声明与许可声明」为条件。
- **附加使用条款**（与 MIT 不可分割，只接受一部分即不得使用）限制：
  1. **禁止商业用途**；2. **禁止二次分发牟利**；3. 禁止批量账号运营；
  4. 禁止绕过计费与配额；5. 禁止攻击与干扰；6. 禁止违法用途；7. 商业用途需另获作者书面授权。

**本 fork 的合规基线（请严格遵守）**：

1. **非商业**：本 fork 及其构建产物不得用于任何商业目的，不得以本项目为载体牟利
   （不做付费镜像、不卖安装包、不挂广告、不做赞助分成、不承接商业交付）。
2. **保留署名**：`LICENSE` 与全部源文件的版权头**原样保留，不得删除**（源文件头明确写了
   「此注释为版权与授权声明，禁止删除」）。
3. **署名上游**：本 fork 的一切分发都应保留对 [HUIdada1/AgentHub](https://github.com/HUIdada1/AgentHub)
   与原作者沐晖的署名（本仓库 README 顶部已声明）。
4. **超出上述范围**（尤其是商业化、或作者就「直接搬运」另作限制的解读），
   需事先联系原作者取得书面授权。

> **第二层限制：源文件头的「直接搬运」条款。**
> 上游 437 个源文件（fork 中 455 个）顶部都带这段：
>
> ```
>  *  版权声明：本代码归沐晖所有。
>  *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
>  *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
>  *    此注释为版权与授权声明，禁止删除。
> ```
>
> 其中「禁止在未经本人授权的情况下**直接搬运**本代码（含复制、转载、用于商业项目）」
> 比 LICENSE 附加条款 2（只禁「牟利」型二次分发）**更严格**——它把复制/转载也列了进去，
> 没有附带「牟利」限定。
>
> **本 fork 的立场**：「直接搬运」指向的是**不署名、逐字照搬的原文转载**，
> 而非「保留全部版权声明与授权条款、注明出处、非商业的再分发」。
> 依据有三：① 文件头本身要求「禁止删除」版权声明——真要禁止署名式 fork 不会这么写；
> ② LICENSE 第三部分写明「如两者表述有出入，**以本文件为准**」，而 LICENSE 明确授予
> 「发布、分发」权；③ 附加条款 1/2 禁的是**商业用途**与**牟利型再分发**，
> 本 fork 两者都不涉及。
>
> **但作者的沉默不等于许可。** 时间线值得注意：
>
> | 时间 | 事件 |
> | --- | --- |
> | 2026-10-15 14:00 | `b468e84e` LICENSE 改为「MIT + 附加使用条款」复合授权 |
> | 2026-10-22 01:37 | `2b080de` 批量给源文件补版权头（8 → 453 个文件） |
> | 2026-10-22 14:55 | `fdb3e55` 下线反代网关 |
> | 2026-10-22 15:01 | 发布 v1.83.0 |
>
> 一天之内「先硬化授权 → 再给每个文件加头 → 再下线网关」，这在时序上**不能证明**文件头
> 就是针对这种恢复而设，但也意味着不能把作者的沉默当作默许。
>
> **建议（成本极低、未执行）**：向上游作者发一条**事实告知**（不是请求许可），
> 说明本 fork 的存在、基线 commit、非商业性质与保留全部声明的事实。
> 这能把唯一可争议的那一条从「单方判断」变成「已知情且未反对」。
> 上游留有 QQ 群 `110336924` 与 `SPONSOR.md` 的商务合作渠道；
> 本 fork 的「反馈与需求」入口也已指向其 issue 模板。**是否发、发什么，由维护者定。**

### 合规自查清单

| # | 要求 | 本 fork 现状 |
| --- | --- | --- |
| 1 | `LICENSE` 与上游**逐字节一致**（blob `453c6113`），不得改写、不得只保留 MIT 一半 | ✅ 未改动 |
| 2 | 全部源文件版权头**原样保留**（455 个文件） | ✅ 未改动 |
| 3 | 非商业：不做付费镜像 / 卖安装包 / 广告 / 赞助分成 / 商业交付 | ✅ 需持续自律 |
| 4 | 不标注为「纯 MIT」，不重新授权 | ✅ README 与仓库描述均写明「MIT + 附加使用条款」 |
| 5 | 不用于批量账号运营、不绕过上游计费与配额 | ✅ README「使用声明」与 LICENSE 原文已覆盖 |
| 6 | 沿用上游的风险免责声明 | ✅ README 顶部提示 + 「使用声明」第二节原文保留 |
| 7 | 声明非官方、无隶属与背书关系 | ✅ README 顶部 + 「本 fork 说明」+ 仓库描述 |
| 8 | 如实转述上游下线网关的**理由**，不歪曲为「上游错了」 | ✅ README 顶部按上游原意转述 |
| 9 | 指向上游官方版本入口（偏好官方构建的用户） | ✅ README「本 fork 说明」已给上游 Releases 链接 |

---

## 八、上游同步策略

上游仍在活跃开发（记忆中枢、计费）。本 fork 可以选择性跟进，但**不是 `git merge`**。

### 绝对不要合并 / cherry-pick 的提交

| commit | 为什么 |
| --- | --- |
| `fdb3e55` 反代网关停止维护，改造为号池管家 | 就是本次回退要躲开的提交，合并即等于重新下线网关 |
| `a5d160e` 网关档下线，模型来源收敛 | 把记忆中枢模型来源里的 `gateway` 档位删掉，与本 fork 的前提直接冲突 |
| `05b4b03` v1.83.0 发版 | 号池管家改造的版本号与发版说明 |

### 已移植的提交

`58927fd`（优化计费规则）、`437afbd`（模型与网关迁入全局设置）、
`a38940d`（三套在线价格表同构卡片）—— 三个都已落地并通过全部自测，
详见第四节「从上游移植的三个提交」。

### 判一个上游提交该不该 SKIP 的三条判据

命中**任意一条** → SKIP：

1. 提交是否删除 `models.sourceOrder` 里的 `"gateway"`？
2. 提交是否删除 `ConfigModelsSection.vue` 的网关档 UI？
3. 提交是否删除 `electron/preload.cjs` 的 `proxy_*` 白名单？

### 同步操作

```bash
git fetch upstream
git log --oneline upstream/main ^main          # 看上游比本 fork 多了什么
git cherry-pick <commit>                        # 单个提交，不做 merge
# 每次 cherry-pick 后必跑：npm run build && npm run verify:memory
```

**纪律**：不要把上游 `main` 合进来。上游 `main` 与本 fork 的差异不是「落后多少」，
而是**两个产品**——上游的 1.83+ 砍掉了网关，合进来等于自杀。

**另外两条移植纪律**：

- **`src/types/index.ts` 是雷区**。上游在 `fdb3e55` 里给 `SettingsTab` 加了 `"models"`，
  我们回滚后自己补回（见第四节）。上游后续若再动这个联合类型，需手工合并。
- **schema 迁移链必须逐级对齐**。本 fork 与上游同处 9 → 10 的迁移点（纯视图重建，
  不改表结构，无断层）。上游若再升 schema，迁移块是 `if (current < N)` 逐级追加，
  **本 fork 必须保持同样的逐级链**，否则跨版本数据库会跳过中间步骤。
  迁移只升不降：回退到旧代码时 `user_version` 不会自动降级（对本 fork 无害，
  视图结构兼容），但**不要在同一台机器上反复切换 schema 版本不同的构建**。

---

## 九、上游风控对策（本 fork 自行维护的部分）

上游把反代网关整个砍掉，意味着**风控适配这条线彻底没人跟了**——但上游（腾讯、
字节等）的风控策略仍在变。这是本 fork 最需要持续维护的部分，也是最容易过时的地方。

社区上报的两个 issue（#156 请求被拦截 / #157 额度耗尽后免费模型不可用）都属于这条线。

### 对策来源（都是**现行**实现，不是过时配方）

| 项目 | 最后提交 | 取了什么 |
| --- | --- | --- |
| [hawklithm/workbuddy2api](https://github.com/hawklithm/workbuddy2api) | 2026-10-23 | `desensitize.py` 的**词级零宽空格** + `PR #4` 的**harness 语义压缩** |
| [linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel) | 2026-10-21 | `pool/credit_floor*` 的**积分保底**与「免费模型不被连坐」 |
| [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) issue #544 / #568 / #570 / #603 | 2026-10-22 ~ 10-23 | **11128 判定语义的实测测绘**（12 组探针、三条指纹、双端点对照） |
| [deltrivx/AutoBuddy](https://github.com/deltrivx/AutoBuddy) `gateway/vendor/workbuddy_intl_daily.py` | 2026-10-23 | **国际版专用**的对话头族 / 活跃三端点 / 报告事件形状 |
| [FlapPearLabs/workbuddy-toolkit](https://github.com/FlapPearLabs/workbuddy-toolkit) `scripts/compat_monitor.py` | 2026-10-23 | **上游协议漂移监控**清单 + 官方更新接口的用法 |

> 核对过：这些仓库/issue 在 2026-10 仍在按真实拦截补词、补判据，代码在活跃路径上
> （不是 legacy 目录、不是关着的开关）。**不要**去抄 AgentHub 旧版那种
> 「5 条整句精确改写」的封闭枚举——那正是 issue #156 的根因。

### ⚠ 抄别人实现前，先确认「是不是同一个东西」

同类项目**普遍同时支持国内版与国际版**，两条产品线是**两套独立实现**，细节互不相同。
踩过的坑：AutoBuddy 的 `workbuddy_daily.py`（国内，`www.workbuddy.cn` /
`copilot.tencent.com`）与 `workbuddy_intl_daily.py`（国际，`www.workbuddy.ai`）
是两个文件——把国内版的做法套到国际版上是错的（一度以为它的活跃上报要送
「环境指纹对象」，其实国际版送的就是 `chat_request_send` 事件数组，与本 fork 一致）。

**规矩**：

1. 先按**产品线**定位到对应文件（国际版 = `workbuddy.ai` / `workbuddy_intl_*`），
   不要看仓库首页或文件名。
2. 登录态、账号体系、模型目录、错误码语义**两条线互不通用**
   （AutoBuddy 代码里明写「国际版 www.workbuddy.ai 与国内版 www.workbuddy.cn 的
   登录态互不通用」）。
3. 端点存活情况**按域分别探测**，不能跨域推断。本 fork 2026-10-23 的实测：
   `POST /report` 在两个域都 404，而 `POST /v2/report` 都活着；
   但 `/v2/billing/ide/trial` 404 而 `/billing/ide/trial` 活着——**v2 优先级并不一致**。
   故 `billingCall` 改成「遇 404/405 换下一候选」，而不是改顺序去猜。
4. 头部差异要**逐个字段**比。本 fork 对照官方抓包（`getmessaagefromai` 的
   `requests-2026-10-23.jsonl`）与 AutoBuddy 国际版实现后补了 `X-Private-Data`、
   `x-stainless-*` 全族、`b3`、`traceparent`、`acp-connection-id`。
5. 别人「特意不发」的头，往往是**实测出来的网关特征**——AutoBuddy 国际版明确注释
   「不再发 X-Session-ID —— 官方对话请求不带它，旧的恒定派生值本身是一处网关特征」。
   本 fork 仍保留 `x-machine-id` / `x-session-id`（2026-09 的 `bdadac1` 为防
   「设备指纹缺失/漂移」风控而加，且实测可用），但已知它与官方不一致——**改动前
   先实测**，不要盲从任一方。

### 11128 到底在查什么（按 2026-10-28 最新社区实测更新）

| 实测项 | 结论 |
| --- | --- |
| 检查范围 | **所有非 user 消息**：system 提示词 + 回传的 **assistant 历史** |
| 匹配语义 | 大小写不敏感的**逐字符精确子串 / n-gram 模板匹配**（不是长度规则） |
| 不查的位置 | `user` / `tool` / `reasoning_content` / `tool_call.arguments` |
| 长度因素 | 真实请求 1.86 MB / 728 条消息 / 39 tools 可通过；短请求也可被拦——**排除长度** |
| 双端点 | `copilot.tencent.com` 与 `www.workbuddy.ai` 均有同类渠道校验，但指纹规则可能分批上线 |
| 账号因素 | 同 body 换号仍 11128；最小 system + user 同凭据可 200 —— **不是封号** |

#### 2026-10-28：旧的「品牌词根因」结论被实测推翻

`dsh-auth-hub#1` 做了约 150 次对照实验：把 `DeepSeek Harness` 以
「原样 / 零宽 U+200B / 全小写 / 全大写 / 换行拆开 / 制表拆开 / 只留 DSH /
只留单词」分别发上去，**全部 HTTP 200**；而真实 system prompt 原样发必 400/11128。

真正的触发点是 DSH 运行时上下文里的**自指内容**，两句连读才命中：

```text
Tokens prefixed with @ are paths the user explicitly referenced.
Relative paths resolve from the workspace root; absolute paths identify files or
 directories on the host.
```

三个独立 issue（`dsh-xdpool#77/#79`、`workbuddy2api-hub#680`）都定位到这里：

| 变体 | 结果 |
| --- | --- |
| 最小失败前缀（111 字符，截到 `workspace root`） | **400 / 11128** |
| 截到 `workspace r`（少最后 3 字符） | 200 |
| 只保留任意单句 | 200 |
| `workspace root` → `workspace directory` | 200 |
| `prefixed with` → `starting with` | 200 |
| 右端追加 `directory` / `folder` / 句号 | **仍 400**（原子串仍完整存在） |

**关键教训**：只有改**子串内部**才能打破命中，右端加词、零宽拆品牌、换账号均无效。
本 fork 现在做两处语义等价改写：

- `Tokens prefixed with @ ...` → `Tokens starting with @ ...`
- `Relative paths resolve from the workspace root` →
  `Relative paths are resolved against the session directory`

品牌名 `DeepSeek Harness → DeepSeek-Harness` 仍保留为加固，但已知它**不是必要触发点**，
不得再把它当根因。

**关键推论**：`assistant` 历史同样被查。一旦某轮回复复述过指纹句，它进入上下文后
该会话之后每一轮都会挂。所以清洗必须覆盖 `system` / `developer` / `assistant`，
**不动 user / tool**。

### 已落地的两处修正

**① 内容审核脱敏（#156）** — `electron/backend/proxy/desensitize.cjs`

四层管线，**顺序即优先级**（`desensitizeTemplateText` 串起来，prune/compact 可关）：

| 层 | 做什么 | 依据 |
| --- | --- | --- |
| ① 自指指纹改写 | `@` 路径两句内部改写 + 旧身份/Web GUI/Main branch 规则 | #77/#79/#680 三方真实请求二分实测 |
| ② 运行时元数据裁剪 | `environment_context` 等 5 类成对标签整段换一句话；ToolSearch / Agent 工具清单 / MCP 三类尾部截断 | workbuddy2api `_prune_runtime_fragments` |
| ③ harness 语义压缩 | system + 长度 ≥1000 + Claude 标记命中 ≥2 → 换成行为契约摘要 | workbuddy2api `PR #4` |
| ④ 词级零宽空格 | `DoS` → `D\u200boS`，仅兜底安全术语误审；**不用于 DSH 渠道指纹** | workbuddy2api `desensitize.py` |

边界（改之前先读）：
- 指纹改写只处理 `system` / `developer` / `assistant`（上游实测检查范围）；
- **不动** `user` / `tool` 内容（真实用户输入和工具结果保持原样）；
- **不改** tools 的 `name`（参与 tool_call 配对）与 `parameters`（上游做 schema 校验）；
- 幂等：重复处理不叠加；`DeepSeek-Harness` 用占位符保护，不被 ZWSP 二次拆词。

**② 积分保底与免费模型不被连坐（#157）** — `pool.cjs` / `server.cjs`

根因是 402（积分不足）被当成**账号失效**：整号 `exhausted` 封到次日 04:00，且
`pickAccount` 见 `credits === 0` 直接跳过 —— 于是付费额度耗尽后，**不扣费的免费模型
也一起不可用**。

做法：402 是「模型级收费门槛」不是「账号失效」，按**该模型是否确认收费**分流：

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| 余额 0 + 免费/未知倍率模型 | 整号跳过（免费模型也废） | **照常可用** |
| 余额 0 + 确认收费模型（目录倍率 > 0） | 整号 exhausted 到次日 04:00 | 只摘这个模型（模型级冷却） |
| 余额 < `proxy.creditFloor` + 收费模型 | 照常扣 | **不接**，把余额留给免费模型 |
| 余额 < `proxy.creditFloor` + 免费模型 | — | 照常可用 |

`proxy.creditFloor` 默认 **0 = 关闭**（行为与引入前一致）。判「收费」只认目录
`catalog.json` 的 `rate > 0`；`rate = 0`（免费）与无倍率（未知）一律放行——
宁可撞一次 402 让模型级冷却兜住，也不要把未知模型一律判死。

### 被 11128 拦住时怎么定位（排障指引）

先分清是**哪一条路径**——两者的 `msg` 不同，处理方式完全相反：

| 上游 `msg` | 含义 | 正确处理 |
| --- | --- | --- |
| `request illegal` | **内容审核**（指纹/敏感词命中） | 走脱敏四层管线；与账号无关，**不要换号、不要罚号** |
| `Illegal API invocation from an unapproved channel` | **渠道资格校验**（客户端指纹） | 属渠道级，换号照拦；如实报错 + 渠道短退避 |

AgentHub 侧 `server.cjs` 的 `isChannelBlock()` 按 `code === 11128` 判渠道级、
`isClientGate()` 按正文文本判资格校验，两条都**不罚账号**（`applyCool` 无对应分支），
这一点是对的——内容审核换号确实无效。

定位是哪一条指纹，用 `listFingerprintHits`：

```bash
node -e "
const d = require('./electron/backend/proxy/desensitize.cjs');
const s = require('fs').readFileSync(process.argv[1], 'utf8');
console.log('命中指纹:', d.listFingerprintHits(s));
console.log('命中敏感词数:', d.countHits(s));
" <被拦的请求体或 system prompt 文本>
```

**一条都没命中却仍被拦**，说明是未列入的第四条指纹。按 #603 的探针法定位：
把 system 原文**二分**，只留一半发给上游，缩到最小触发片段；再把该片段从
`system` 挪到 `user` 验证（不拦即确认是非 user 消息的字面量检查）。
定位后往 `CLIENT_FINGERPRINTS` 加一行（**长的放前面**，见上面的顺序坑），
并往自测加一条用例。

### 维护这条线的纪律

1. **先看现行实现，别抄旧配方**。抄之前用 `git log -1 --format=%ci -- <path>` 确认
   那份代码最近还在改；超过半年没动、或在 legacy 目录里的，一律当**过时**处理。
2. **词表/判据要能持续加**。脱敏词表与 `creditFloor` 都是数据驱动，补词比改逻辑安全。
3. **每次改完必跑**：`tools/proxy-desensitize-selftest.cjs` +
   `tools/proxy-credit-floor-selftest.cjs` + 既有 12 个网关自测（共 14 套，已接入 CI）。
4. **不要在分类层写死单个渠道的业务码**。`server.cjs` 的注释已说明：4008 / 6004 /
   11102 是 trae / workbuddy / qoder **共用**的一族码，搬进单个渠道的 `classifyError`
   会改变其它渠道的分类结果。
5. **改 `CLIENT_FINGERPRINTS` 后必验顺序**。长指纹必须先落，否则短规则会把长规则的
   原文改花。自测第 11 组有条顺序回归用例，别删。
6. **不要扩大清洗范围到 user**。#603 实测 user / tool 不拦，洗了纯属白改用户正文与代码，
   还会打乱前缀缓存。要扩范围先拿探针数据说话。

---

## 十、CI

| 工作流 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/gateway-ci.yml` | push / PR 命中 `gateway/**`、`electron/backend/**`、`tools/proxy-*.cjs` 等路径 | 网关 Docker 形态：**14 套共享核心自测**（含脱敏与积分保底两套）+ 镜像构建 + 容器冒烟（fail-closed、API 契约、备份端点、优雅停机） |
| `.github/workflows/release.yml` | 手动 `workflow_dispatch` | 版本校验 → typecheck+构建 → 打包发 Release → 校验 latest.yml |

上游没有「全量类型检查 + 记忆中枢自测」的常规 CI，只有发版流水线里带一道 `npm run build`。
若要加一条常驻 CI，建议如下（尚未添加，按需自取）：

```yaml
name: CI
on:
  push:
  pull_request:
jobs:
  check:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm run verify:memory
```

---

## 十一、本地自测怎么跑

### 网关自测（13 个脚本，全部纯 Node）

```bash
# 逐个脚本跑，每个脚本给一个**全新**的沙箱目录
for t in proxy-crypto-envelope proxy-adapter-contract proxy-key-lww proxy-failover \
         proxy-modelscope proxy-credits-expiry proxy-cost-route proxy-empty-pool-route \
         proxy-stats-rename proxy-channels proxy-agents-switch proxy-command-table \
         proxy-desensitize proxy-credit-floor; do
  d=$(mktemp -d); s=$(mktemp -d)
  AGENTHUB_DATA_DIR="$d" AGENT_SKILLS_HOME="$s" node "tools/$t-selftest.cjs" || echo "FAILED: $t"
done
```

> ⚠️ **每个脚本必须用独立的 `AGENTHUB_DATA_DIR` / `AGENT_SKILLS_HOME`。**
> 共用一个目录会串味：前一个脚本把某渠道的 `costTier` 写进同一个库，
> 后一个脚本就会在「未标注渠道 costTier 为空串」这类断言上假失败。
> 上游 `gateway-ci.yml` 的 `run_sbx()` 就是每个脚本 `mktemp -d` 一次——
> 本地照抄这个约定，否则会得到一堆假红。

另有依赖闭包断言（防止 Dockerfile 的 COPY 清单与真实闭包漂移）：

```bash
node tools/gateway-closure-check.cjs      # 期望：闭包完整（145 个文件）
```

### 其余自测

```bash
npm ci
npm run build          # vue-tsc 类型门禁 + vite 打包
npm run verify:memory  # 记忆中枢纯代码验证
```

> `tools/verify-project-regroup-e2e.cjs` 需要本机存在真实台账
> （`~/AgentHub/memory/projects/_index.json`），没有就会跳过；它是手动脚本，不在
> `npm run verify:memory` 里。

### 回退基线与移植后的实测结果

回退基线 `bbe8373` 上的网关自测**全部通过**（11/11，闭包断言通过）：
适配器契约 18 渠道、渠道自测 56 项、故障转移全场景、成本档路由 30 项、
空池路由 31 项、加密信封 18 项、Key LWW 17 项、ModelScope 31 项等。

移植三个上游提交后（当前 `main`）复测，**全部仍然通过、无回归**：
`vue-tsc --noEmit` exit 0 · `vite build` exit 0 · 计费自测 65/0 ·
记忆供应商自测 66/0 · `verify:memory` 26/0 · 网关闭包 145 文件完整 ·
代理命令表 8/0（82 条命令）· 网关自测 11/11。

网关完整性复核（移植后）：`electron/backend/proxy/` 43 个模块 ·
`src/views/proxy/` 16 个视图 · `gateway/` Docker 形态完整 ·
`DEFAULT_SOURCE_ORDER = ["custom", "degrade", "gateway"]`（**网关档仍在**）·
preload 白名单 82 条 `proxy_*` 命令完整。

---

## 十二、已知坑

0. **`src/types/index.ts` 的 `SettingsTab`**（移植上游提交时的头号坑）。
   上游 `437afbd` 依赖 `fdb3e55` 引入的 `"models"` 页签，cherry-pick 不会带过来 →
   9 条 TS 错误 + 设置弹窗不渲染「模型与网关」页签（面板静默不可达）。
   本 fork 已手工补齐；上游后续若再动这个联合类型，**必须手工合并**。
1. **自动更新源**（最要命）。改了 `updater.cjs` 的 `GITHUB_REPO_URL` 但忘了改
   `package.json` 的 `build.publish.owner`，或反之——`app-update.yml` 与便携版的
   `latest.yml` 直链是两条独立路径，**两处都要改**。
2. **便携版更新**：`updater.cjs` 的 `LATEST_YML_URL` 走
   `releases/latest/download/latest.yml`。GitHub 对 prerelease 不标 Latest，
   所以版本号不能用预发布格式（见第五节）。
3. **`appId` 未改**：本 fork 与上游共用 `%APPDATA%\AgentHub` 与同一套安装目录/卸载注册项。
   同机装了上游版再装本 fork 会互相覆盖——数据是连续的，但一次只能留一个。
4. **`docs/` 在 `.gitignore` 里**：上游把内部文档排除在仓库外。要在本 fork 里提交文档，
   需先调整 `.gitignore`。
5. **`废弃代码（禁止git提交推送）/` 也在 `.gitignore` 里**：那是上游下线网关时的归档目录，
   本 fork 用不到；回退后该目录在本仓库中并不存在。
6. **记忆中枢项目卡的 slug 跟着 `origin` 走**：项目身份取自 `git remote get-url origin`，
   origin 换成本 fork 后，`huidada1--agenthub` 会变成 `yangwenjie1231--agenthub`，
   旧卡片不会被合并而是新增一张。`verify-project-regroup-e2e.cjs` 的断言已放宽。
7. **不要 `git merge upstream/main`**，理由见第八节。

---

## 十三、致谢与许可

- 上游项目：[HUIdada1/AgentHub](https://github.com/HUIdada1/AgentHub) —— 作者 沐晖（HUIdada1）
- 本 fork 保留原仓库全部版权声明与 `LICENSE`（MIT + 附加使用条款）
- 上游赞助与合作渠道见原仓库 `SPONSOR.md`
