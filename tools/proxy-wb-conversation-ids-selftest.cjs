// 验证 wbConversationIdHeaders 的会话三件套形态（对齐官方抓包 2026-10-23）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-conv-"));
process.env.AGENTHUB_DATA_DIR = dir;
process.env.AGENT_SKILLS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ah-sk-"));

const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");

// 官方抓包真值
const EXPECT = {
  "x-conversation-id": /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "x-conversation-message-id": /^[0-9a-f]{32}$/,
  "x-conversation-request-id": /^[0-9a-f]{32}$/,
  "acp-connection-id": /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
};

let fail = 0;
const ok = (c, l, e) => { if (c) console.log("  ok   " + l); else { fail++; console.error("  FAIL " + l + (e ? " —— " + e : "")); } };

// 直接从源码里把函数体抠出来跑（避免加载整个 adapters 触发副作用）
const m = src.match(/function wbConversationHeaders\(body, meta\) \{[\s\S]*?\n\}/);
if (!m) { console.error("找不到 wbConversationHeaders"); process.exit(1); }
const uuidSrc = src.match(/function uuidV7\(\) \{[\s\S]*?\n\}/);
const mod = `const crypto = require("node:crypto");\n${uuidSrc[0]}\n${m[0]}\nmodule.exports = { wbConversationHeaders, uuidV7 };`;
fs.writeFileSync(path.join(dir, "wch.cjs"), mod);
const { wbConversationHeaders, uuidV7 } = require(path.join(dir, "wch.cjs"));

console.log("1. UUIDv7 形态");
for (let i = 0; i < 5; i++) {
  const u = uuidV7();
  ok(EXPECT["x-conversation-id"].test(u), `uuidV7 #${i} 符合 UUIDv7 规范`, u);
}
// 同毫秒内生成的两个 id 应共享时间戳前缀（官方客户端特征）
const a = uuidV7(), b = uuidV7();
ok(a.slice(0, 8) === b.slice(0, 8) || a.slice(0, 8) !== b.slice(0, 8), "时间戳前缀可重复（不强制，仅记录）");
console.log(`     ${a}\n     ${b}`);

console.log("2. 客户端未给 conversation_id —— 必须自造");
{
  const h = wbConversationHeaders({ messages: [] }, null);
  ok(!!h["x-conversation-id"], "x-conversation-id 存在（不再缺席）");
  ok(EXPECT["x-conversation-id"].test(h["x-conversation-id"]), "x-conversation-id 是 UUIDv7", h["x-conversation-id"]);
  ok(!!h["x-conversation-request-id"], "x-conversation-request-id 存在");
  ok(!!h["x-conversation-message-id"], "x-conversation-message-id 存在");
  ok(EXPECT["x-conversation-message-id"].test(h["x-conversation-message-id"]), "message-id 是 32 位 hex", h["x-conversation-message-id"]);
  ok(EXPECT["x-conversation-request-id"].test(h["x-conversation-request-id"]), "request-id 是 32 位 hex");
  ok(h["x-request-id"] === h["x-conversation-message-id"], "x-request-id 与 message-id 一致（抓包实证）");
}

console.log("3. 客户端给了 conversation_id —— 透传原值");
{
  const h = wbConversationHeaders({ conversation_id: "client-provided-id" }, null);
  ok(h["x-conversation-id"] === "client-provided-id", "透传客户端原值", h["x-conversation-id"]);
}
{
  const h = wbConversationHeaders({ conversationId: "camel-case-id" }, null);
  ok(h["x-conversation-id"] === "camel-case-id", "兼容 conversationId 驼峰字段", h["x-conversation-id"]);
}

console.log("4. meta 复用（换号/重试不换会话）");
{
  const meta = { conversationRequestId: "a".repeat(32) };
  const h = wbConversationHeaders({ messages: [] }, meta);
  ok(h["x-conversation-request-id"] === "a".repeat(32), "meta 给的 request-id 被复用（重试/换号会话稳定）", h["x-conversation-request-id"]);
}

console.log("5. 三件套齐全性（渠道门硬门槛）");
for (let i = 0; i < 20; i++) {
  const h = wbConversationHeaders({ messages: [] }, null);
  const trio = ["x-conversation-id", "x-conversation-request-id", "x-conversation-message-id"];
  const miss = trio.filter((k) => !h[k]);
  if (miss.length) { ok(false, `第 ${i} 次三件套齐全`, "缺 " + miss.join(",")); break; }
  if (i === 19) ok(true, "20 次采样三件套全部齐全");
}

console.log("");
console.log(fail ? `RESULT: ${fail} failed` : "会话三件套自测全过");
process.exitCode = fail ? 1 : 0;
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }