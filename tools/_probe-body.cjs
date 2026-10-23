// 打印 AgentHub 对 workbuddy_ai 的出站请求体，与官方抓包对照
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-body-"));
process.env.AGENTHUB_DATA_DIR = dir;
process.env.AGENT_SKILLS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ah-sk-"));

const rules = require("../electron/backend/proxy/rules.cjs");
rules.init();
const adapters = require("../electron/backend/proxy/adapters.cjs");
const ad = adapters.get("workbuddy_ai");

// 模拟一个 DSH 真实请求：system + user + 一次 assistant(tool_calls) + tool 结果
const body = {
  model: "deepseek-v4.1-flash",
  messages: [
    { role: "system", content: "You are an AI assistant." },
    { role: "user", content: "帮我看下这个文件" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "hello" },
    { role: "user", content: "继续" },
  ],
  stream: true,
  stream_options: { include_usage: true },
};

const out = ad.rewriteBody("deepseek-v4.1-flash", body, { id: "a1", uid: "u-1" });
console.log("=== AgentHub 出站 body 顶层键 ===");
Object.keys(out).sort().forEach((k) => {
  const v = out[k];
  const s = typeof v === "object" ? (Array.isArray(v) ? `[${v.length} 项]` : JSON.stringify(v).slice(0, 70)) : String(v);
  console.log("  " + k + " = " + s);
});

console.log("\n=== 官方 body 顶层键（对照）===");
console.log("  model, messages, stream, stream_options");

console.log("\n=== 多余的顶层键（官方没有）===");
const official = ["model", "messages", "stream", "stream_options"];
Object.keys(out).filter((k) => !official.includes(k)).forEach((k) => console.log("  " + k));

console.log("\n=== messages 角色序列 ===");
console.log("  " + out.messages.map((m) => m.role).join(" → "));

console.log("\n=== messages[0] 的键 ===");
console.log("  " + Object.keys(out.messages[0]).join(", "));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);