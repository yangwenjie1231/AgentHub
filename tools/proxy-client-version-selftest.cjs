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
// 客户端版本自检 + 出站头完整性自测
// 用法：node tools/proxy-client-version-selftest.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ver-"));
process.env.AGENTHUB_DATA_DIR = dir;
process.env.AGENT_SKILLS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ah-sk-"));

let fail = 0;
const ok = (c, l, e) => { if (c) console.log("  ok   " + l); else { fail++; console.error("  FAIL " + l + (e ? " —— " + e : "")); } };

const cv = require("../electron/backend/proxy/clientVersion.cjs");

console.log("1. 版本比较");
{
  ok(cv.compareVersions("5.5.4", "5.8.3") === -1, "5.5.4 < 5.8.3");
  ok(cv.compareVersions("5.8.3", "5.8.3") === 0, "相等");
  ok(cv.compareVersions("5.8.4", "5.8.3") === 1, "5.8.4 > 5.8.3");
  ok(cv.compareVersions("5.10.0", "5.9.0") === 1, "按数字段比而非字典序（5.10 > 5.9）");
  ok(cv.compareVersions("6.0.0", "5.99.99") === 1, "大版本优先");
  ok(cv.majorOf("5.8.3.41334564") === "5.8.3", "majorOf 取前三段");
  ok(cv.majorOf("5.8") === "5.8", "majorOf 容忍两段");
  ok(cv.compareVersions("", "5.8.3") === -1, "空版本视为最旧");
}

console.log("2. 漂移判定（不联网，纯逻辑）");
{
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const simulate = (configured, official) => {
    const stale = cmp(configured, official) < 0;
    return { configured, official, stale, message: stale ? `落后 ${official} → ${configured}` : "一致" };
  };
  ok(simulate("5.5.4", "5.8.3").stale === true, "5.5.4 相对 5.8.3 判为落后（正是本 fork 踩过的坑）");
  ok(simulate("5.8.4", "5.8.3").stale === false, "5.8.4 不算落后");
  ok(simulate("5.8.3", "5.8.3").stale === false, "同版本不算落后");
}

console.log("3. 官方更新接口（真实联网，失败只算 warn 不算失败）");
(async () => {
  try {
    const r = await cv.fetchOfficialLatest({ timeoutMs: 10000 });
    if (r.ok) {
      ok(/^\d+\.\d+\.\d+$/.test(r.version), "官方版本号格式正确", r.version);
      ok(!!r.url && r.url.startsWith("https://"), "拿到官方下载链接", r.url);
      ok(!!r.sha256, "拿到官方 sha256");
      console.log(`     官方当前版本 = ${r.version}（raw ${r.rawVersion}）`);
      const d = await cv.checkClientVersionDrift(r.version);
      ok(d.ok && d.stale === false, "同版本不判落后", d.message);
      const old = await cv.checkClientVersionDrift("5.5.4");
      ok(old.ok && old.stale === true, "5.5.4 相对官方判为落后", old.message);
    } else {
      console.log(`  --   官方更新接口未响应（${r.error}），跳过联网断言`);
    }
  } catch (e) {
    console.log(`  --   官方更新接口异常（${String((e && e.message) || e)}），跳过联网断言`);
  }

  console.log("4. 出站头完整性（对照官方抓包 2026-10-23）");
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    const must = [
      "x-stainless-arch", "x-stainless-lang", "x-stainless-os",
      "x-stainless-package-version", "x-stainless-retry-count",
      "x-stainless-runtime", "x-stainless-runtime-version",
      "b3", "traceparent", "acp-connection-id",
      "x-agent-intent", "x-agent-type", "x-product",
    ];
    for (const k of must) {
      ok(src.includes(`"${k}"`), `出站头含 ${k}`);
    }
    // 版本三件套不能写死在代码里
    ok(!/clientVersion \|\| "5\.5\.4"/.test(src), "没有写死的 5.5.4 兜底");
    ok(!/stainlessPackageVersion \|\| "5\.10/.test(src), "stainless 版本不是从别处抄来的旧值");
  }

  console.log("");
  console.log(fail ? `RESULT: ${fail} failed` : "客户端版本自检自测全过");
  process.exitCode = fail ? 1 : 0;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
})();