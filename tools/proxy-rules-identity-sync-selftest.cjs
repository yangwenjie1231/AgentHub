// 验证 forceUpstreamIdentity：旧磁盘配置必须被强制同步成内置值
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-force-"));
process.env.AGENTHUB_DATA_DIR = dir;

let fail = 0;
const ok = (c, l, e) => { if (c) console.log("  ok   " + l); else { fail++; console.error("  FAIL " + l + (e ? " —— " + e : "")); } };

const rules = require("../electron/backend/proxy/rules.cjs");
rules.init();

const p = path.join(rules.rulesDir(), "headers.json");

// 模拟「装过旧版本」的磁盘配置：身份字段全是旧值
const stale = JSON.parse(fs.readFileSync(p, "utf8"));
stale.workbuddy.clientVersion = "5.5.4";
stale.workbuddy.cliVersion = "2.137.1";
stale.workbuddy.userAgent = "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1";
stale.workbuddy.billingUA = "WorkBuddy/5.5.4";
stale.workbuddy.catalogUA = "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1";
stale.workbuddy_ai.clientVersion = "5.5.4";
stale.workbuddy_ai.userAgent = "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1";
// 用户自定义项（不该被覆盖）
stale.workbuddy.origin = "https://my-custom-proxy.example.com";
fs.writeFileSync(p, JSON.stringify(stale, null, 2), "utf8");

// 重新触发 ensureFiles（模拟应用重启）
rules.reload("headers.json");
rules.init();

const after = JSON.parse(fs.readFileSync(p, "utf8"));

console.log("1. CN 身份字段被强制同步");
ok(after.workbuddy.clientVersion === "5.5.6", "CN clientVersion 5.5.4 → 5.5.6", after.workbuddy.clientVersion);
ok(after.workbuddy.userAgent === "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1", "CN UA 同步", after.workbuddy.userAgent);
ok(after.workbuddy.billingUA === "WorkBuddy/5.5.6", "CN billingUA 同步", after.workbuddy.billingUA);
ok(after.workbuddy.catalogUA.includes("5.5.6"), "CN catalogUA 同步", after.workbuddy.catalogUA);
ok(after.workbuddy.productCode === "SaaS", "CN productCode = SaaS", after.workbuddy.productCode);

console.log("2. AI 身份字段被强制同步");
ok(after.workbuddy_ai.clientVersion === "5.8.4", "AI clientVersion 5.5.4 → 5.8.4", after.workbuddy_ai.clientVersion);
ok(after.workbuddy_ai.userAgent === "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0", "AI UA 同步", after.workbuddy_ai.userAgent);

console.log("3. 用户自定义项不被覆盖");
ok(after.workbuddy.origin === "https://my-custom-proxy.example.com", "自定义 origin 保留（不强制同步）", after.workbuddy.origin);

console.log("4. 内存中的值也已是新值");
const loaded = rules.get("headers.json");
ok(loaded.workbuddy.clientVersion === "5.5.6", "内存 CN clientVersion = 5.5.6", loaded.workbuddy.clientVersion);
ok(loaded.workbuddy_ai.clientVersion === "5.8.4", "内存 AI clientVersion = 5.8.4", loaded.workbuddy_ai.clientVersion);

console.log("");
console.log(fail ? `RESULT: ${fail} failed` : "身份字段强制同步自测全过");
process.exitCode = fail ? 1 : 0;
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }