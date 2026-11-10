// 验证 forceUpstreamIdentity：旧磁盘配置必须被强制同步成内置值
// ⚠ 本用例刻意**不写死具体版本号**：版本三件套随上游轮换（5.5.4 → 5.8.4 → 5.9.x …），
//   写死会让「上游换版本」变成「自测变红」，逼人改测试而不是改配置——那正是这条线过期的根因。
//   这里改为：把磁盘值改成明显不同的旧值 → 断言被同步回**内置默认值**（从 rules.DEFAULTS 取）。
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
const D = rules.DEFAULTS["headers.json"];
const WANT_CN = { ...D.workbuddy };
const WANT_AI = { ...D.workbuddy_ai };

// 模拟「装过旧版本」的磁盘配置：身份字段全是假旧值（与内置值必然不同）
const stale = JSON.parse(fs.readFileSync(p, "utf8"));
const OLD = "1.0.0-old";
stale.workbuddy.clientVersion = OLD;
stale.workbuddy.cliVersion = "0.0.1-old";
stale.workbuddy.userAgent = `WorkBuddy/${OLD} WorkBuddy/${OLD} CLI/${"0.0.1-old"}`;
stale.workbuddy.billingUA = `WorkBuddy/${OLD}`;
stale.workbuddy.catalogUA = stale.workbuddy.userAgent;
stale.workbuddy_ai.clientVersion = OLD;
stale.workbuddy_ai.cliVersion = "0.0.1-old";
stale.workbuddy_ai.userAgent = `WorkBuddy/${OLD} workbuddy-ai/${OLD} CLI/0.0.1-old`;
stale.workbuddy_ai.billingUA = `WorkBuddy/${OLD}`;
stale.workbuddy_ai.catalogUA = stale.workbuddy_ai.userAgent;
// 用户自定义项（不该被覆盖）
stale.workbuddy.origin = "https://my-custom-proxy.example.com";
fs.writeFileSync(p, JSON.stringify(stale, null, 2), "utf8");

// 重新触发 ensureFiles（模拟应用重启）
rules.reload("headers.json");
rules.init();

const after = JSON.parse(fs.readFileSync(p, "utf8"));

console.log("1. CN 身份字段被强制同步回内置值");
for (const k of ["clientVersion", "cliVersion", "userAgent", "billingUA", "catalogUA"]) {
  ok(after.workbuddy[k] === WANT_CN[k], `CN ${k} = 内置值（${WANT_CN[k]}）`, after.workbuddy[k]);
}
ok(after.workbuddy.productCode === "SaaS", "CN productCode = SaaS", after.workbuddy.productCode);

console.log("2. AI 身份字段被强制同步回内置值");
for (const k of ["clientVersion", "cliVersion", "userAgent", "billingUA", "catalogUA"]) {
  ok(after.workbuddy_ai[k] === WANT_AI[k], `AI ${k} = 内置值（${WANT_AI[k]}）`, after.workbuddy_ai[k]);
}

console.log("3. 版本三件套内部自洽（防手改一半：UA 里的版本与 clientVersion 不一致）");
for (const [name, ch, want] of [["CN", after.workbuddy, WANT_CN], ["AI", after.workbuddy_ai, WANT_AI]]) {
  ok(String(ch.userAgent).includes(ch.clientVersion), `${name} UA 含 clientVersion`, `${ch.userAgent} vs ${ch.clientVersion}`);
  ok(String(ch.userAgent).includes(ch.cliVersion), `${name} UA 含 cliVersion`, `${ch.userAgent} vs ${ch.cliVersion}`);
  ok(ch.catalogUA === ch.userAgent, `${name} catalogUA 与 userAgent 同源`, ch.catalogUA);
  ok(ch.billingUA === `WorkBuddy/${ch.clientVersion}`, `${name} billingUA = WorkBuddy/clientVersion`, ch.billingUA);
}

console.log("4. 用户自定义项不被覆盖");
ok(after.workbuddy.origin === "https://my-custom-proxy.example.com", "自定义 origin 保留（不强制同步）", after.workbuddy.origin);

console.log("5. 内存中的值也已是新值");
const loaded = rules.get("headers.json");
ok(loaded.workbuddy.clientVersion === WANT_CN.clientVersion, "内存 CN clientVersion = 内置值", loaded.workbuddy.clientVersion);
ok(loaded.workbuddy_ai.clientVersion === WANT_AI.clientVersion, "内存 AI clientVersion = 内置值", loaded.workbuddy_ai.clientVersion);

console.log("");
console.log(fail ? `RESULT: ${fail} failed` : "身份字段强制同步自测全过");
process.exitCode = fail ? 1 : 0;
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
// rules.init() 会起 chokidar watcher 盯 rules 目录（生产行为，不能为了自测删掉），
// 它让事件循环永不空转——这里显式收尾，否则脚本跑完不退出、CI 里表现为「挂死」
const t = setTimeout(() => process.exit(fail ? 1 : 0), 300);
t.unref();
// setTimeout 已 unref，还需要主动触发一次退出（watcher 仍持有句柄）
setImmediate(() => process.exit(fail ? 1 : 0));