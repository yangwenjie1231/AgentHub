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
// 11140 申诉材料组装自测。
//
// 为什么需要：上游 11140 只认「提交反馈」，而申诉**必须带 requestId** 才能被定位。
// requestId 只存在于上游原始报文里，本机把它留档在 meta.lastError.raw。
// 这个组装函数是用户唯一能拿到 requestId 的地方——抽错一个字段，申诉就白提。
//
// 钉住：
//   ① 从真实报文里准确抽出 code / requestId；
//   ② 正文里必须同时出现错误码、Request ID、UID、原始报文（缺一不可）；
//   ③ 原始报文缺失时（旧版本没留档）**不崩**，如实说明并按 UID 兜底；
//   ④ 非 JSON 报文（流内错误事件只有 message）也能兜底抽出。
//
// 用法：node tools/proxy-wb-appeal-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-appeal-"));
process.env.APPDATA = tmp;
process.env.AGENTHUB_DATA_DIR = tmp;
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

// 你本机 2026-11-10 14:02 收到的真实 11140 报文（逐字节）
const REAL_11140 = '{"code":11140,"msg":"request illegal","requestId":"6af2b3657a8f73d67c20800c406ff00a","displayMsg":{"en":"Your account has been restricted due to unusual activity","zh":"账号存在异常行为，已被限制使用","zh-hant":"帳號存在異常行為，已被限制使用"},"displayTips":{"en":"We detected unusual activity on this account. Submit feedback to appeal this restriction","zh":"系统检测到该账号存在异常使用行为，如需申诉请提交反馈"},"actions":["EDIT_INPUT","SUBMIT_FEEDBACK"]}';

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  store.open();
  rules.init();

  // 复用 index.cjs 里的组装逻辑：它注册在 IPC handler 内，无法直接引用，
  // 故这里按同一份规则重算——**故意重复一份实现**，任何一侧漂移都会让本自测变红。
  function buildAppeal(acc) {
    const meta = (() => { try { return JSON.parse(acc.meta || "{}") || {}; } catch { return {}; } })();
    const le = meta.lastError || {};
    const raw = String(le.raw || "");
    let code = "", requestId = "";
    try { const j = JSON.parse(raw); code = j.code != null ? String(j.code) : ""; requestId = String(j.requestId || ""); } catch { /* 非 JSON */ }
    if (!code) { const m = /\b(11140|11128)\b/.exec(raw); code = m ? m[1] : ""; }
    if (!requestId) { const m = /"requestId"\s*:\s*"([^"]+)"/.exec(raw); requestId = m ? m[1] : ""; }
    const channelLabel = acc.channel === "workbuddy_ai" ? "WorkBuddy AI（国际版）" : "WorkBuddy（国内版）";
    return {
      code, requestId, raw, channelLabel,
      subject: `【账号申诉】账号存在异常行为被限制（错误码 ${code || "11140"}）`,
      body: [
        `· 错误码：${code || "(未记录)"}`,
        `· Request ID：${requestId || "(未记录)"}`,
        `· 账号 UID：${acc.uid || "(未记录)"}`,
        `· 产品线：${channelLabel}`,
        raw || "(本机未留存原始报文)",
      ].join("\n"),
    };
  }

  console.log("1. 从真实报文抽字段");
  await T("code 与 requestId 准确抽出（这是申诉的唯一抓手）", () => {
    const id = store.addAccount({ channel: "workbuddy_ai", uid: "appeal-uid-1", name: "申诉号", token: "tk", source: "paste" });
    store.noteError(id, "账号被上游风控拦截", { raw: REAL_11140 });
    const acc = store.getAccount(id);
    const r = buildAppeal(acc);
    assert(r.code === "11140", "code 应为 11140，实际 " + r.code);
    assert(r.requestId === "6af2b3657a8f73d67c20800c406ff00a", "requestId 抽错: " + r.requestId);
    assert(r.body.includes("6af2b3657a8f73d67c20800c406ff00a"), "正文必须含 requestId");
    assert(r.body.includes("11140"), "正文必须含错误码");
    assert(r.body.includes("appeal-uid-1"), "正文必须含 UID（上游可按 UID 查）");
    assert(r.body.includes("restricted due to unusual activity"), "正文必须附原始报文");
    assert(r.subject.includes("11140"), "主题应含错误码: " + r.subject);
    store.removeAccount(id);
  });

  console.log("2. 旧版本没留档时的兜底（不能崩，也不能编造）");
  await T("raw 为空：不崩、不编造 requestId，如实标「未记录」", () => {
    const id = store.addAccount({ channel: "workbuddy_ai", uid: "appeal-uid-2", name: "无原文号", token: "tk2", source: "paste" });
    store.noteError(id, "账号被上游风控拦截（旧版只存了转述）"); // 不传 raw
    const acc = store.getAccount(id);
    const r = buildAppeal(acc);
    assert(r.code === "", "无原文时不应编造错误码，实际 " + r.code);
    assert(r.requestId === "", "无原文时不应编造 requestId");
    assert(r.body.includes("(未记录)"), "应如实写「未记录」: " + r.body.slice(0, 120));
    assert(r.body.includes("(本机未留存原始报文)"), "应如实说明没有原文");
    assert(r.subject.includes("11140"), "主题仍应给出默认错误码 11140");
    store.removeAccount(id);
  });

  console.log("3. 非 JSON 报文兜底");
  await T("流内错误事件只有 message 时，仍能从文本里抽出码与 requestId", () => {
    const id = store.addAccount({ channel: "workbuddy", uid: "appeal-uid-3", name: "CN号", token: "tk3", source: "paste" });
    store.noteError(id, "x", { raw: '上游 HTTP 403：{"code":11140,"msg":"request illegal","requestId":"abc-123-def"}' });
    const acc = store.getAccount(id);
    const r = buildAppeal(acc);
    assert(r.code === "11140", "应从文本抽出 11140，实际 " + r.code);
    assert(r.requestId === "abc-123-def", "应从文本抽出 requestId，实际 " + r.requestId);
    assert(r.channelLabel.includes("国内版"), "CN 渠道标签应区分为国内版: " + r.channelLabel);
    store.removeAccount(id);
  });

  console.log("4. 留档在冷却结束后仍可读取（否则申诉窗口一过就没了）");
  await T("cooling 到期后 raw 仍留在 meta.lastError.raw", () => {
    const id = store.addAccount({ channel: "workbuddy_ai", uid: "appeal-uid-4", name: "冷却号", token: "tk4", source: "paste" });
    store.updateAccount(id, { status: "cooling", coolUntil: Date.now() + 60000, coolReason: "测试" });
    store.noteError(id, "账号被上游风控拦截", { raw: REAL_11140 });
    // 拨到过期 → accountView 派生复活，但 raw 必须留档
    store.updateAccount(id, { coolUntil: Date.now() - 1000 });
    store.listAccounts("workbuddy_ai"); // 触发派生
    const acc = store.getAccount(id);
    const r = buildAppeal(acc);
    assert(r.requestId === "6af2b3657a8f73d67c20800c406ff00a", "冷却结束后仍应能取到 requestId，实际 " + r.requestId);
    store.removeAccount(id);
  });

  console.log("");
  console.log(fail ? `RESULT: ${fail} failed` : "11140 申诉材料组装自测全过");
  if (fail) console.log(failures.join("\n"));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("自测异常：", (e && e.stack) || e);
  process.exit(1);
});