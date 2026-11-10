/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-11
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// WorkBuddy 11128 / 11140 的**判别与解封语义**自测。
//
// 背景（2026-11-11 实测纠正，都是真踩过的坑）：
//   ① 11128 与 11140 的 msg 字段**一模一样**，都是 "request illegal"：
//        11128: {"code":11128,"msg":"request illegal","displayMsg":{"zh":"请求被拦截，请重新发送"}}
//        11140: {"code":11140,"msg":"request illegal","displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}
//      旧判据兜底用 /request illegal/i → **所有 11128 都被当成封号**，触发 2h 冷却 + 整池暂停，
//      等于把「内容拦截」升级成「全渠道停发」。
//   ② 11140 是账号级限制，上游**不给恢复时间**（官方报文自带 retry_policy:{retry:false}），
//      实测停 12 小时仍未恢复。旧实现给它 2h cooling 并让它随计时自动复活，于是界面显示「在线」
//      而实际每次请求都 403——「看不出哪个号被封」。
//
// 本自测钉住三件事：
//   ① 11128 绝不被判成 account_blocked（用你日志里的真实报文逐字节）；
//   ② 11140 被判成 account_blocked，且落 restricted 状态；
//   ③ restricted **不随计时复活**，只有真实成功一次才解除；手动解封也有效。
//
// 用法：node tools/proxy-wb-restricted-state-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-wb-restrictedstate-"));
process.env.APPDATA = tmp;
process.env.LOCALAPPDATA = path.join(tmp, "LocalAppData");
process.env.AGENT_SKILLS_HOME = path.join(tmp, "Skills");

let pass = 0;
let fail = 0;
const failures = [];
function T(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ok  ${name}`); })
    .catch((e) => { fail++; failures.push(`${name}: ${(e && e.message) || e}`); console.log(`FAIL  ${name}: ${(e && e.message) || e}`); });
}
function assert(cond, msg) { if (!cond) throw new Error("断言失败: " + msg); }

// ===== 真实报文（逐字节）=====
// ① 来自本机 op_logs：2026-10-23 保活请求被拦时上游返回的 11128
const REAL_11128 = '{"code":11128,"msg":"request illegal","requestId":"cfc90ee9-7551-424f-86d6-628f5e0b24ff","displayMsg":{"en":"Request blocked. Please send it again","zh":"请求被拦截，请重新发送","zh-hant":"請求已被攔截，請重新傳送"}}';
// ② 来自腾讯云社区提问原文（App Version 5.9.3）：11140 的完整错误体
const REAL_11140 = '{"code":11140,"msg":"request illegal","displayMsg":{"en":"Your account has been restricted due to unusual activity","zh":"账号存在异常行为，已被限制使用"},"displayTips":{"zh":"系统检测到该账号存在异常使用行为，如需申诉请提交反馈"},"retry_policy":{"retry":false},"actions":["EDIT_INPUT","SUBMIT_FEEDBACK"],"details":"403 request illegal"}';

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const pool = require("../electron/backend/proxy/pool.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  store.open();
  rules.init();
  const wb = adapters.get("workbuddy_ai");

  console.log("1. 判据：11128 与 11140 必须分开（两者的 msg 都是 request illegal）");
  await T("真实 11128（三种通道：code 字段 / body 文本 / 仅 message）一律**不**判 account_blocked", () => {
    const cases = [
      ["code 字段", { status: 400, code: 11128, body: REAL_11128, message: `上游 HTTP 400：${REAL_11128}` }],
      ["body 文本", { status: 400, body: REAL_11128, message: `上游 HTTP 400：${REAL_11128}` }],
      ["仅 message", { status: 400, message: `上游 HTTP 400：${REAL_11128}` }],
      ["流内 error 事件", { status: 400, code: 11128, message: "request illegal" }],
    ];
    for (const [label, err] of cases) {
      const r = wb.classifyError(err);
      assert(r === null, `${label} 不该判 account_blocked，实际 ${r && r.kind}`);
    }
  });
  await T("真实 11140（code 字段 / body 文本 / 仅 displayMsg 文案）都判 account_blocked", () => {
    const cases = [
      ["code 字段", { status: 403, code: 11140, body: REAL_11140 }],
      ["body 文本", { status: 403, body: REAL_11140 }],
      ["仅 message", { status: 403, message: `上游 HTTP 403：${REAL_11140}` }],
      ["只有 displayMsg 文案（字段没解析出来）", { status: 403, message: "账号存在异常行为，已被限制使用" }],
    ];
    for (const [label, err] of cases) {
      const r = wb.classifyError(err);
      assert(r && r.kind === "account_blocked", `${label} 应判 account_blocked，实际 ${r && r.kind}`);
    }
  });
  await T("'request illegal' 单独出现不能定性（这正是旧实现的误判源）", () => {
    // 只有 msg、没有 code 也没有 11140 独有文案 —— 无法区分 11128/11140，必须放行走通用分类
    assert(wb.classifyError({ status: 403, message: "request illegal" }) === null, "纯 'request illegal' 不得判 account_blocked");
  });

  console.log("2. 状态机：11140 落 restricted，且不随计时复活");
  const accId = store.addAccount({
    channel: "workbuddy_ai", uid: "rs-1", name: "限制号",
    token: "restricted-token", source: "paste", expiresAt: Date.now() + 7200000,
  });
  await T("11140 落 restricted 状态（不是 cooling），且下次选号选不到它", () => {
    pool.coolAccount(accId, "account_blocked", "账号被上游风控拦截");
    const acc = store.getAccount(accId);
    assert(acc.status === "restricted", "状态应为 restricted，实际 " + acc.status);
    const picked = pool.pickAccount("workbuddy_ai", "expire_first", [], 0, "glm-5.3");
    assert(!picked || picked.id !== accId, "restricted 账号不得被选号选中");
  });
  await T("coolUntil 已过（模拟等很久）也**不**自动复活 —— 这是与 cooling 的关键区别", () => {
    // 把 coolUntil 拨到过去，模拟「已经等超过 2 小时了」
    store.updateAccount(accId, { coolUntil: Date.now() - 3600000 });
    const view = store.listAccounts("workbuddy_ai").find((a) => a.id === accId);
    assert(view.status === "restricted", "冷却时间到期也不得变 online，实际 " + view.status);
    const picked = pool.pickAccount("workbuddy_ai", "expire_first", [], 0, "glm-5.3");
    assert(!picked || picked.id !== accId, "到期后仍不得被选中");
  });
  await T("对照：普通 cooling 到期**会**自动复活（确认上面不是把所有复活都关掉了）", () => {
    const cid = store.addAccount({
      channel: "workbuddy_ai", uid: "rs-2", name: "冷却号",
      token: "cool-token", source: "paste", expiresAt: Date.now() + 7200000,
    });
    pool.coolAccountMs(cid, Date.now() + 60000, "429 短冷却");
    assert(store.getAccount(cid).status === "cooling", "应为 cooling");
    store.updateAccount(cid, { coolUntil: Date.now() - 1000 }); // 拨到过期
    const v = store.listAccounts("workbuddy_ai").find((a) => a.id === cid);
    assert(v.status === "online", "cooling 到期应复活为 online，实际 " + v.status);
    store.removeAccount(cid);
  });

  console.log("3. 解封通道：只有真实成功 / 手动解封");
  await T("真实成功一次 → restricted 自动解除（noteSuccess）", () => {
    pool.noteSuccess(accId, "glm-5.3");
    const acc = store.getAccount(accId);
    assert(acc.status === "online", "成功后应回 online，实际 " + acc.status);
    assert(!acc.coolReason, "成功后应清掉限制理由，实际 " + acc.coolReason);
  });
  await T("手动解封（号池页「解除限制」）也能解除 restricted", () => {
    pool.coolAccount(accId, "account_blocked", "账号被上游风控拦截");
    assert(store.getAccount(accId).status === "restricted", "先置为 restricted");
    const r = pool.releaseCool(accId);
    assert(r.ok, "手动解封应成功: " + JSON.stringify(r));
    assert(r.wasRestricted === true, "应报告这是解除上游限制");
    assert(store.getAccount(accId).status === "online", "解除后应 online");
  });

  console.log("4. 取证：11140 的**原始报文**必须留档（转述无法证明是哪个码）");
  await T("applyCool 落 noteError 时保留 raw 原文，且冷却结束后 raw 仍在", () => {
    const cid = store.addAccount({
      channel: "workbuddy_ai", uid: "rs-3", name: "取证号",
      token: "raw-token", source: "paste", expiresAt: Date.now() + 7200000,
    });
    store.updateAccount(cid, { status: "cooling", coolUntil: Date.now() + 60000, coolReason: "测试" });
    store.noteError(cid, "账号被上游风控拦截（转述文案）", { raw: REAL_11140 });
    let v = store.listAccounts("workbuddy_ai").find((a) => a.id === cid);
    assert(v.lastError && /11140/.test(v.lastError.raw || ""), "raw 应含 11140 原文: " + JSON.stringify(v.lastError));
    assert(/restricted due to unusual activity/.test(v.lastError.raw || ""), "raw 应含 displayMsg 原文");
    // 冷却到期 → 气泡不再标红，但 raw 仍在（留档）
    store.updateAccount(cid, { coolUntil: Date.now() - 1000 });
    v = store.listAccounts("workbuddy_ai").find((a) => a.id === cid);
    const archived = v.meta && v.meta.lastError;
    assert(archived && /11140/.test(archived.raw || ""), "冷却结束后 raw 必须仍在（否则无法申诉/复核）: " + JSON.stringify(archived));
    assert(archived.archived === true, "应标记 archived（前端不再当新错误标红）");
    store.removeAccount(cid);
  });

  console.log("");
  console.log(fail ? `RESULT: ${fail} failed` : "11128/11140 判别与解封语义自测全过");
  if (fail) console.log(failures.join("\n"));
  // rules.init() 起了 chokidar watcher，事件循环不会空转 → 显式退出
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("自测异常：", (e && e.stack) || e);
  process.exit(1);
});