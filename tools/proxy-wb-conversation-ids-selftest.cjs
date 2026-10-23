/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-23
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// WorkBuddy 会话 id 族自测：形态 + **跨轮稳定性** + 账号维度
//
// 依据：官方桌面端真实抓包（2026-10-23，5 个请求分属 3 个会话）的 id 规律：
//   x-conversation-id         同一会话内不变，跨会话变（UUID 形态）
//   x-conversation-request-id 同一会话内不变（32 hex）
//   x-conversation-message-id 每个请求都不同（32 hex）
//   acp-connection-id         账号级稳定（可跨会话复用）
//
// 上游把会话 id 三件套当**渠道资格校验**用，缺一即 400/11128
// （社区对照实验：同账号同 body 同一秒，仅头部差异决定 11128/200）。
// 用法：node tools/proxy-wb-conversation-ids-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-conv-"));
process.env.AGENTHUB_DATA_DIR = dir;
process.env.AGENT_SKILLS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ah-sk-"));

const SRC = path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs");
const src = fs.readFileSync(SRC, "utf8");

let fail = 0;
const ok = (c, l, e) => { if (c) console.log("  ok   " + l); else { fail++; console.error("  FAIL " + l + (e ? " —— " + e : "")); } };

// 从源码抠出函数体跑（避免加载整个 adapters 触发副作用）
function extract(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error(`找不到 ${name}`);
  return m[0];
}
const mod = [
  'const crypto = require("node:crypto");',
  extract("sha256Hex"),
  extract("stableConvAnchor"),
  extract("uuidFromHex16"),
  extract("uuidV4"),
  extract("wbConversationHeaders"),
  "module.exports = { wbConversationHeaders, uuidFromHex16, uuidV4, stableConvAnchor };",
].join("\n");
fs.writeFileSync(path.join(dir, "wch.cjs"), mod);
const { wbConversationHeaders, uuidFromHex16, uuidV4, stableConvAnchor } = require(path.join(dir, "wch.cjs"));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;

console.log("1. 形态");
{
  const h = wbConversationHeaders({ messages: [{ role: "user", content: "hi" }] }, null, { uid: "u1" });
  ok(UUID_RE.test(h["x-conversation-id"]), "x-conversation-id 是 UUID", h["x-conversation-id"]);
  ok(HEX32_RE.test(h["x-conversation-request-id"]), "request-id 是 32 hex", h["x-conversation-request-id"]);
  ok(HEX32_RE.test(h["x-conversation-message-id"]), "message-id 是 32 hex", h["x-conversation-message-id"]);
  ok(HEX32_RE.test(h["x-request-id"]), "x-request-id 是 32 hex");
  ok(UUID_RE.test(h["acp-connection-id"]), "acp-connection-id 是 UUID", h["acp-connection-id"]);
  ok(h["x-request-id"] === h["x-conversation-message-id"], "x-request-id 与 message-id 一致（官方抓包实证）");
  ok(h["x-b3-sampled"] === "1", "带 x-b3-sampled");
}

console.log("2. 会话内跨轮稳定（最关键）");
{
  // 同一会话的三轮：首条 user 消息不变，消息数逐轮增长
  const t1 = [{ role: "system", content: "S" }, { role: "user", content: "第一条问题" }];
  const t2 = [...t1, { role: "assistant", content: "答" }, { role: "user", content: "第二条" }];
  const t3 = [...t2, { role: "assistant", content: "答2" }, { role: "user", content: "第三条" }];
  const a = wbConversationHeaders({ messages: t1 }, null, { uid: "u1" });
  const b = wbConversationHeaders({ messages: t2 }, null, { uid: "u1" });
  const c = wbConversationHeaders({ messages: t3 }, null, { uid: "u1" });
  ok(a["x-conversation-id"] === b["x-conversation-id"] && b["x-conversation-id"] === c["x-conversation-id"],
    "x-conversation-id 跨轮恒等", `${a["x-conversation-id"]} / ${b["x-conversation-id"]} / ${c["x-conversation-id"]}`);
  ok(a["x-conversation-request-id"] === c["x-conversation-request-id"],
    "x-conversation-request-id 跨轮恒等（官方是会话级）");
  ok(a["x-conversation-message-id"] !== b["x-conversation-message-id"],
    "x-conversation-message-id 每轮不同");
  ok(a["acp-connection-id"] === c["acp-connection-id"], "acp-connection-id 跨轮恒等（连接级）");
}

console.log("3. 不同会话必须不同");
{
  const a = wbConversationHeaders({ messages: [{ role: "user", content: "会话甲" }] }, null, { uid: "u1" });
  const b = wbConversationHeaders({ messages: [{ role: "user", content: "会话乙" }] }, null, { uid: "u1" });
  ok(a["x-conversation-id"] !== b["x-conversation-id"], "不同会话的 conversation-id 不同");
  ok(a["acp-connection-id"] === b["acp-connection-id"], "同账号不同会话共享 acp-connection-id");
}

console.log("4. 账号维度");
{
  const a = wbConversationHeaders({ messages: [{ role: "user", content: "同样的问题" }] }, null, { uid: "acct-A" });
  const b = wbConversationHeaders({ messages: [{ role: "user", content: "同样的问题" }] }, null, { uid: "acct-B" });
  ok(a["x-conversation-id"] === b["x-conversation-id"], "同问题同会话锚点（与账号无关）");
  ok(a["acp-connection-id"] !== b["acp-connection-id"], "不同账号的 acp-connection-id 不同（账号级）");
  const c = wbConversationHeaders({ messages: [{ role: "user", content: "同样的问题" }] }, null, { uid: "acct-A" });
  ok(a["acp-connection-id"] === c["acp-connection-id"], "同账号的 acp-connection-id 恒定");
}

console.log("5. 客户端自带 conversation_id → 透传为准");
{
  const h = wbConversationHeaders({ conversation_id: "client-conv-123", messages: [] }, null, { uid: "u1" });
  ok(h["x-conversation-id"] === uuidFromHex16("client-conv-123"), "客户端值被采用（转成 UUID 形态）", h["x-conversation-id"]);
  const h2 = wbConversationHeaders({ conversationId: "camel-1", messages: [] }, null, { uid: "u1" });
  ok(h2["x-conversation-id"] === uuidFromHex16("camel-1"), "兼容 conversationId 驼峰字段");
}

console.log("6. 锚点函数的边界");
{
  ok(stableConvAnchor([]) === "", "空消息 → 空锚点");
  ok(stableConvAnchor([{ role: "user", content: "x" }]) === stableConvAnchor([{ role: "user", content: "x" }]), "锚点确定性");
  ok(stableConvAnchor([{ role: "system", content: "S" }, { role: "user", content: "U" }])
    === stableConvAnchor([{ role: "system", content: "S" }, { role: "user", content: "U" }, { role: "assistant", content: "A" }]),
    "锚点只看首条 user，不受后续消息影响");
  ok(stableConvAnchor([{ role: "system", content: "S" }]) !== "", "无 user 消息时回退到首条消息");
}

console.log("7. 三件套齐全性（渠道门硬门槛）");
{
  let allOk = true;
  for (let i = 0; i < 30; i++) {
    const h = wbConversationHeaders({ messages: [{ role: "user", content: "q" + i }] }, null, { uid: "u" + i });
    const miss = ["x-conversation-id", "x-conversation-request-id", "x-conversation-message-id"].filter((k) => !h[k]);
    if (miss.length) { allOk = false; ok(false, "三件套齐全", "缺 " + miss.join(",")); break; }
  }
  if (allOk) ok(true, "30 次采样三件套全部齐全");
}

console.log("");
console.log(fail ? `RESULT: ${fail} failed` : "会话 id 族自测全过");
process.exitCode = fail ? 1 : 0;
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }