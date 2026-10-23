# AGENTS.md — AgentHub 独立维护分支

本文件是 AI agent 在本仓库工作时的**入口索引**。先读这里，再按需跳到对应文档。

> ⚠️ 本仓库是 [HUIdada1/AgentHub](https://github.com/HUIdada1/AgentHub) 的**独立维护 fork**，
> 不是上游官方仓库。上游自 v1.83.0 起下线了「反代网关」，本 fork 回退到 v1.82.2 并自行维护。
> **动手前必读 [FORK.md](./FORK.md)**——尤其是授权合规与上游同步纪律两节。

## 文档索引

| 文档 | 什么时候读 | 内容 |
| --- | --- | --- |
| **[FORK.md](./FORK.md)** | **开工前必读** | 本 fork 的全部维护约定：回退原因、基线、远程拓扑、已做改动、版本号规则、发版流程、授权合规、上游同步策略、**上游风控对策**、CI、本地自测、已知坑 |
| [README.md](./README.md) | 了解功能全貌 | 面向用户的中文说明：四大板块（技能仓库 / 用量统计 / 反代网关 / 记忆中枢）、安装、使用声明 |
| [README.en.md](./README.en.md) | 同上（英文） | 英文版 |
| [SPONSOR.md](./SPONSOR.md) | 一般不用 | 上游作者的联系与合作渠道 |

## 项目速览

- **形态**：Windows 桌面应用（Electron 35 + Vue 3 + TypeScript + Vite）+ Docker 版网关
- **进程结构**：`electron/main.cjs` 主进程 → `electron/preload.cjs` IPC 白名单 → `src/` 渲染层
- **四大板块**：技能仓库 / 用量统计 / **反代网关** / 记忆中枢
- **数据库**：Node 内置 `node:sqlite`（`DatabaseSync`），schema 版本 10，迁移只升不降

## 目录地图

```
electron/
  main.cjs                 主进程入口（窗口/托盘/单实例锁/生命周期）
  preload.cjs              IPC 白名单（renderer 只能调这里登记过的命令）
  backend/
    ipc.cjs                IPC 注册总入口
    config.cjs             全局配置默认值 + 读写（proxy.* / memory.* / update.*）
    updater.cjs            软件自更新（⚠ 已改指本 fork 的 GitHub，见 FORK.md）
    db.cjs                 数据库与迁移
    billing.cjs            计费规则与价格来源
    sync*.cjs              用量同步
    memory/                记忆中枢
    proxy/                 ★ 反代网关（本 fork 的核心维护对象）
      server.cjs           请求管线：路由 / 换号 / 错误分类 / 流式转发
      adapters.cjs         各渠道适配器（含 makeWorkBuddy）
      pool.cjs             号池：选号 / 冷却 / 熔断 / 积分保底
      accio/ autoclaw/ catpaw/ cline/ codearts/ loomy/   渠道模块（各自 adapter/协议/目录拉取）
      platform/            平台适配层
      protocols/           入站协议转换（Anthropic Messages / OpenAI Responses）
      desensitize.cjs      上游内容审核脱敏（issue #156）
      rules.cjs            渠道规则默认值（模型目录 / 头 / 指纹改写表）
      store.cjs            网关数据库读写
gateway/                   Docker 形态网关（独立可跑，见 gateway/README.md）
src/                       渲染层（Vue 3）
  views/proxy/             反代网关各页面
  components/config/       全局设置各分区
tools/                     自测与校验脚本（proxy-*.cjs / memory-*.cjs / verify/）
.github/workflows/
  gateway-ci.yml           网关自测 + 镜像构建 + 容器冒烟
  release.yml              手动发版（版本校验 → 构建 → 发布）
```

## 常用命令

```bash
npm ci                    # 装依赖（electron 二进制可能需手动装，见 FORK.md 环境备注）
npm run build             # vue-tsc 类型门禁 + vite 打包（提交前必跑）
npm run verify:memory     # 记忆中枢纯代码验证（26 项）
npm run dev               # 起 vite + electron 开发

# 网关自测：每个脚本必须独立沙箱目录（共用的会串味假失败）
for t in proxy-crypto-envelope proxy-adapter-contract proxy-key-lww proxy-failover \
         proxy-modelscope proxy-credits-expiry proxy-cost-route proxy-empty-pool-route \
         proxy-stats-rename proxy-channels proxy-agents-switch proxy-command-table \
         proxy-desensitize proxy-credit-floor; do
  d=$(mktemp -d); s=$(mktemp -d)
  AGENTHUB_DATA_DIR="$d" AGENT_SKILLS_HOME="$s" node "tools/$t-selftest.cjs" || echo "FAILED: $t"
done

node tools/gateway-closure-check.cjs   # 网关闭包断言（防 Dockerfile COPY 漂移）
```

## 硬性约束（改代码前必看）

1. **授权**：上游是「MIT + 附加使用条款」复合授权，**禁止商业用途**。不得删除 `LICENSE`
   与源文件头的版权声明。详见 [FORK.md](./FORK.md) 第七节。
2. **不要 `git merge upstream/main`**。上游 1.83+ 已砍掉反代网关，合并进来等于自杀。
   跟进上游只能逐个 `cherry-pick`，且先过 SKIP 判据（FORK.md 第八节）。
3. **`src/types/index.ts` 的 `SettingsTab` 是雷区**。上游在砍网关的同一个提交里给它加了
   `"models"`，本 fork 是手工补回来的；上游再动这个联合类型必须手工合并（FORK.md 第四节）。
4. **错误码分类不要写死进单渠道**。`4008 / 6004 / 11102` 是 trae / workbuddy / qoder
   **共用**的一族码，搬进单个渠道的 `classifyError` 会改变其它渠道的分类结果。
5. **改上游风控相关逻辑前，先验方案新鲜度**：`git log -1 --format=%ci -- <path>`，
   半年没动或在 legacy 目录的当**过时**处理（FORK.md 第九节）。
6. **提交信息用 UTF-8 文件传入**（`git commit -F file`），PowerShell 直接传中文参数会乱码。
7. **不要提交** `废弃代码（禁止git提交推送）/`，也不要把 `docs/` 里的内部文档加进来（均在 `.gitignore`）。

## 上游风控这条线（最需要持续维护）

上游砍掉网关后风控适配没人跟了，但上游策略仍在变。本 fork 已落地的两处对策：

| Issue | 问题 | 本 fork 的做法 | 落点 |
| --- | --- | --- | --- |
| **#156** | WorkBuddy CN 请求被拦截（11128） | 词级**零宽空格脱敏**（`DoS` → `Do‍S`），与客户端模板无关 | `proxy/desensitize.cjs` |
| **#157** | 额度耗尽后免费模型也用不了 | 402 按「模型是否确认收费」分流 + `proxy.creditFloor` 积分保底 | `proxy/pool.cjs`、`proxy/server.cjs` |

对策来源（均为 2026-10 仍在活跃维护的项目，**不是**过时配方）：
[hawklithm/workbuddy2api](https://github.com/hawklithm/workbuddy2api)（`desensitize.py`）、
[linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)（`credit_floor`）。

细节、边界与维护纪律见 [FORK.md](./FORK.md) 第九节。

## 提交前自查

- [ ] `npm run build` 通过（含 `vue-tsc --noEmit`）
- [ ] 网关 14 套自测全绿（各自独立沙箱）
- [ ] `npm run verify:memory` 通过
- [ ] `node tools/gateway-closure-check.cjs` 闭包完整
- [ ] 没碰 `LICENSE` 与源文件版权头
- [ ] 提交信息用 `-F` 文件传（中文不乱码）