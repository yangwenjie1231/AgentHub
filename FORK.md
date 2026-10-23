# AgentHub 独立维护分支（FORK 说明）

> 本文件是本仓库（`yangwenjie1231/AgentHub`）的维护说明。
> 上游是 [HUIdada1/AgentHub](https://github.com/HUIdada1/AgentHub)，原作者沐晖（HUIdada1）。

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
（上游代码 `electron/backend/memory/layout.cjs` 的注释已明确按这个拓扑设计：
「一个仓库常同时挂 origin（自己的 fork）与 upstream（上游）」。）

```
origin    →  https://github.com/yangwenjie1231/AgentHub.git   （本 fork，推送目标）
upstream  →  https://github.com/HUIdada1/AgentHub.git          （上游，只读参考）
```

本地分支：

| 分支 | 指向 | 用途 |
| --- | --- | --- |
| `main` | 回退基线 + 本 fork 的维护提交 | **日常开发分支**，与 fork 的 `main` 一致 |
| `feat/gateway-maintain` | 回退基线 + 本 fork 的维护提交 | 首次回退的工作分支（与 `main` 同点，可删可留） |

首次推送：

```bash
git remote rename origin upstream          # 原 origin 其实是上游
git remote add origin https://github.com/yangwenjie1231/AgentHub.git
git push -u origin main
```

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
| `FORK.md` | 新增 | 本文件 |

**刻意没改的**：

- `appId` / `productName` 保持 `com.huidada1.agenthub` / `AgentHub` —— 数据目录 `%APPDATA%\AgentHub`
  与上游连续，号池 / 记忆库 / 用量数据直接继承，不用迁移。
- 全部源文件的版权头与 `LICENSE` 原样保留 —— 见第七节。
- `electron/backend/proxy/` 与 `gateway/` —— 上游 v1.82.2 的代码，**一行未改**，保证网关行为与上游 v1.82.2 完全一致。

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

> 上游源文件头写有「禁止在未经本人授权的情况下直接搬运本代码」，与 `LICENSE` 授予的
> 发布/分发权存在措辞张力。`LICENSE` 第三部分写明「如两者表述有出入，以本文件为准」，
> 故以 `LICENSE` 为准 —— **非商业、保留署名** 的 fork 落在授权范围内；
> 任何商业化或大规模再分发都应先取得作者书面许可。

---

## 八、上游同步策略

上游仍在活跃开发（记忆中枢、计费）。本 fork 可以选择性跟进，但**不是 `git merge`**。

### 绝对不要合并 / cherry-pick 的提交

| commit | 为什么 |
| --- | --- |
| `fdb3e55` 反代网关停止维护，改造为号池管家 | 就是本次回退要躲开的提交，合并即等于重新下线网关 |
| `a5d160e` 网关档下线，模型来源收敛 | 把记忆中枢模型来源里的 `gateway` 档位删掉，与本 fork 的前提直接冲突 |
| `05b4b03` v1.83.0 发版 | 号池管家改造的版本号与发版说明 |

### 可考虑的提交（与网关正交，需人工过一遍）

| commit | 内容 | 评估 |
| --- | --- | --- |
| `58927fd` | 优化计费规则 | 计费模块与网关正交，优先跟进 |
| `a38940d` | 三套在线价格表同构卡片 | 同上；数据层 schema 升到 10，与 `bbe8373` 的 newapi 来源有重叠 |
| `437afbd` | 模型与网关迁入全局设置，路由链独立成面板 | **与网关相关**，动的是「模型与网关」设置面板，合并后要逐项确认网关档位仍在 |

### 同步操作

```bash
git fetch upstream
git log --oneline upstream/main ^main          # 看上游比本 fork 多了什么
git cherry-pick <commit>                        # 单个提交，不做 merge
# 每次 cherry-pick 后必跑：npm run build && npm run verify:memory
```

**纪律**：不要把上游 `main` 合进来。上游 `main` 与本 fork 的差异不是「落后多少」，
而是**两个产品**——上游的 1.83+ 砍掉了网关，合进来等于自杀。

---

## 九、CI

| 工作流 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/gateway-ci.yml` | push / PR 命中 `gateway/**`、`electron/backend/**`、`tools/proxy-*.cjs` 等路径 | 网关 Docker 形态：共享核心自测 + 镜像构建 + 容器冒烟（fail-closed、API 契约、备份端点、优雅停机） |
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

## 十、已知坑

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

## 十一、致谢与许可

- 上游项目：[HUIdada1/AgentHub](https://github.com/HUIdada1/AgentHub) —— 作者 沐晖（HUIdada1）
- 本 fork 保留原仓库全部版权声明与 `LICENSE`（MIT + 附加使用条款）
- 上游赞助与合作渠道见原仓库 `SPONSOR.md`
