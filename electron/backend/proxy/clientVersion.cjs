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
/**
 * WorkBuddy 官方客户端版本自检（防「版本过期 → 渠道校验 400/11128」）
 *
 * 背景
 * ----
 * 上游按**客户端身份**做渠道校验，其中就包括 UA / X-IDE-Version 里报的版本号。
 * AgentHub 的版本三件套曾停在 5.5.4（2026-09-16 起未更新），而官方已到 5.8.x
 * ——差三个小版本，表现为「账号好的、请求体干净的，照样被 11128 拦」。
 *
 * 而版本过期是**静默**的：没有任何报错说「你的版本太老」，只有一句
 * 「请求被拦截」。于是只能靠人肉比对——本模块把这件事自动化。
 *
 * 原理
 * ----
 * 官方有**公开的更新查询接口**（无需鉴权）：
 *
 *   GET https://copilot.tencent.com/v2/update?platform={platform}&version={ver}
 *   Header: User-Agent: WorkBuddy/{ver}
 *
 * 返回 { version, productVersion, url, sha256hash, timestamp, ... }。
 * 传入一个旧版本号会返回比它新的版本，故要**沿版本链迭代**若干跳，
 * 直到返回的版本与请求的版本不再变化（那就是当前最新）。
 *
 * 该端点与 platform 取值的用法参考 workbuddy-toolkit 的 compat_monitor.py
 * （2026-10 仍在维护），其平台 id 为 workbuddy-win32-x64-user。
 *
 * 用途
 * ----
 * 网关启动时查一次，把「配置版本 vs 官方当前版本」写进操作日志；
 * 版本落后于官方时给出明确告警，而不是让用户去猜 11128 到底被什么拦了。
 */
"use strict";

const https = require("node:https");

/** 平台 id：官方 Windows 桌面端（与 workbuddy-toolkit compat_monitor 一致） */
const PLATFORM_ID = "workbuddy-win32-x64-user";
const UPDATE_URL = "https://copilot.tencent.com/v2/update";

/** 沿版本链最多迭代几跳（官方实现用 5） */
const MAX_HOPS = 5;

function getJson(url, ua, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.get(url, { headers: { "User-Agent": ua, accept: "application/json" } }, (res) => {
      if (res.statusCode === 204) { res.resume(); finish(null); return; }
      if (res.statusCode !== 200) { res.resume(); finish(null); return; }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; if (raw.length > 1e6) { req.destroy(); } });
      res.on("end", () => { try { finish(JSON.parse(raw.trim())); } catch { finish(null); } });
    });
    req.on("error", () => finish(null));
    req.setTimeout(timeoutMs || 8000, () => { try { req.destroy(); } catch { /* ignore */ } finish(null); });
  });
}

/** 取版本号的前三段（5.8.3.41334564 → 5.8.3） */
function majorOf(ver) {
  const p = String(ver || "").split(".");
  return p.length >= 3 ? p.slice(0, 3).join(".") : String(ver || "");
}

/** 比较两个版本号：a<b 返回 -1，a==b 返回 0，a>b 返回 1（按数字段比） */
function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 查官方当前最新版本。
 * 返回 { ok, version, productVersion, url, sha256, error }
 * 查询失败**不算错误**（网络不通、接口变更都可能），只如实报 ok:false。
 */
async function fetchOfficialLatest(opts) {
  const o = opts || {};
  const platform = o.platform || PLATFORM_ID;
  let ver = "5.0.0";
  let latest = null;
  for (let hop = 0; hop < (o.maxHops || MAX_HOPS); hop++) {
    const url = `${UPDATE_URL}?platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(ver)}`;
    const data = await getJson(url, `WorkBuddy/${ver}`, o.timeoutMs);
    if (!data) break;
    const next = String(data.version || data.productVersion || "");
    if (!next || next === ver) break;
    latest = { ...data, version: next };
    const m = majorOf(next);
    if (m === ver) break; // 已是最新一跳
    ver = m;
  }
  if (!latest) return { ok: false, error: "官方更新接口无响应（网络不通或接口已变更）" };
  return {
    ok: true,
    version: majorOf(latest.version || latest.productVersion),
    rawVersion: latest.version || latest.productVersion,
    productVersion: latest.productVersion || "",
    url: latest.url || "",
    sha256: latest.sha256hash || "",
  };
}

/**
 * 比对「本地配置的版本」与「官方当前版本」。
 * 返回 { ok, configured, official, stale, gap, message }
 */
async function checkClientVersionDrift(configuredVersion, opts) {
  const configured = majorOf(configuredVersion);
  const res = await fetchOfficialLatest(opts);
  if (!res.ok) {
    return { ok: false, configured, official: "", stale: false, gap: "", message: `未能确认官方当前版本：${res.error}` };
  }
  const cmp = compareVersions(configured, res.version);
  const stale = cmp < 0;
  const gap = stale ? `${res.version} → ${configured}` : "";
  return {
    ok: true,
    configured,
    official: res.version,
    officialRaw: res.rawVersion,
    url: res.url,
    stale,
    gap,
    message: stale
      ? `⚠ 客户端版本落后于官方：配置 ${configured}，官方当前 ${res.version}。` +
        `上游按客户端身份做渠道校验，版本过旧会被判 400/11128「请求被拦截」——` +
        `请把 rules/headers.json 里 ${configured ? "" : ""}workbuddy_ai 的 clientVersion / cliVersion / userAgent / catalogUA 更新到官方当前版本。`
      : `客户端版本 ${configured} 与官方当前 ${res.version} 一致`,
  };
}

module.exports = {
  PLATFORM_ID,
  UPDATE_URL,
  majorOf,
  compareVersions,
  fetchOfficialLatest,
  checkClientVersionDrift,
};
