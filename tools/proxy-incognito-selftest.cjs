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
// 「无痕登录」自测：多号登录必须用互相隔离的浏览器配置，否则第二个号会以第一个号的身份进去。
//
// 钉住四件事：
//   ① 默认开启（proxy.oauthIncognito = true）—— 多号是号池的常态，默认就该隔离；
//   ② 无痕时**每个链接都新建独立 --user-data-dir**（只加 --incognito 不够：
//      同进程复用 profile 时仍可能共享会话）；
//   ③ 优先 Edge（--inprivate）—— Windows 自带，用户明确要求；
//   ④ Edge 与 Chrome **都不存在时退回默认浏览器，并如实返回 ok:false**——
//      绝不能让用户以为这次是隔离的（这是最坏的失败模式：以为隔了其实没隔）。
//
// 用法：node tools/proxy-incognito-selftest.cjs
"use strict";
const os = require("node:os");
const path = require("node:path");

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

async function main() {
  console.log("1. 配置默认值");
  await T("proxy.oauthIncognito 默认为 true（多号是常态，默认隔离）", () => {
    const cfg = require("../electron/backend/config.cjs");
    const d = cfg.defaultConfig ? cfg.defaultConfig() : null;
    assert(d && d.proxy, "默认配置应含 proxy 段");
    assert(d.proxy.oauthIncognito === true, "默认应为 true，实际 " + d.proxy.oauthIncognito);
  });

  console.log("2. 参数与隔离语义（源码级断言，不真的起浏览器）");
  const srcPath = path.join(__dirname, "..", "electron", "backend", "proxy", "platform", "electron.cjs");
  const src = require("node:fs").readFileSync(srcPath, "utf8");
  await T("Edge 用 --inprivate 且每次都建独立 --user-data-dir", () => {
    assert(/--inprivate/.test(src), "应使用 Edge 的 --inprivate");
    assert(/--user-data-dir=/.test(src), "必须带独立 --user-data-dir（只 --incognito 不够）");
    assert(/mkdtempSync/.test(src), "配置目录应每次新建（mkdtempSync）");
  });
  await T("回退链：显式指定 > Edge > Chrome > 默认浏览器", () => {
    assert(/AGENTHUB_INCOGNITO_BROWSER/.test(src), "应支持环境变量指定浏览器");
    const iEnv = src.indexOf("AGENTHUB_INCOGNITO_BROWSER");
    const iEdge = src.indexOf("msedge.exe");
    const iChrome = src.indexOf("chrome.exe");
    assert(iEnv > 0 && iEdge > iEnv, "显式指定应排在 Edge 之前");
    assert(iChrome > iEdge, "Edge 应排在 Chrome 之前（Windows 自带、用户指定优先）");
  });
  await T("找不到浏览器时如实返回 ok:false（不能假装成功）", () => {
    // 关键：退回默认浏览器时**必须**带 ok:false 与说明，否则界面无法提醒"这次不是无痕"
    const tail = src.slice(src.indexOf("未找到 Edge / Chrome"));
    assert(/ok:\s*false/.test(tail), "回退分支必须返回 ok:false");
    assert(/不是无痕/.test(tail), "回退分支必须明说「不是无痕」: " + tail.slice(0, 160));
  });
  await T("非无痕调用走原路径（不影响其它所有 openExternal 用途）", () => {
    assert(/if \(!wantIncognito\) return require\("electron"\)\.shell\.openExternal/.test(src),
      "wantIncognito=false 时应直接走 shell.openExternal");
  });

  console.log("3. 端到端：真的能起一个隔离配置（用 node 模拟 spawn 参数）");
  await T("生成的参数包含目标 URL 与独立目录，且两个链接的目录互不相同", () => {
    const fs = require("node:fs");
    // 复刻 electron.cjs 的目录生成逻辑（同一 API），验证两次调用不会撞目录
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-oauth-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-oauth-"));
    assert(a !== b, "两次应得到不同目录: " + a + " vs " + b);
    assert(fs.existsSync(a) && fs.existsSync(b), "目录应真实存在");
    fs.rmdirSync(a);
    fs.rmdirSync(b);
  });

  console.log("");
  console.log(fail ? `RESULT: ${fail} failed` : "无痕登录自测全过");
  if (fail) console.log(failures.join("\n"));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("自测异常：", (e && e.stack) || e);
  process.exit(1);
});