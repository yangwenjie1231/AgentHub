/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · 平台适配层 · Electron 实现（桌面壳）
// 各模块里散落的 require("electron") 收敛到这里；config 相关一律惰性 require，
// 避免顶层加载顺序耦合（config.cjs 顶层自带 electron 探测）
"use strict";

/** 事件订阅：桌面形态的事件主通道是 IPC 推送，这里同样支持订阅（网关 SSE 与语义对齐） */
const emitListeners = new Set();
function onEmit(fn) {
  emitListeners.add(fn);
  return () => emitListeners.delete(fn);
}

module.exports = {
  // 事件广播：推给所有渲染窗口（events.cjs 的出口）
  emit(payload) {
    try {
      const { BrowserWindow } = require("electron");
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("app:event", { event: "proxy", ...payload });
      }
    } catch { /* 无窗口时静默 */ }
    for (const fn of emitListeners) {
      try {
        fn(payload);
      } catch {
        /* 单个订阅者异常不影响其它 */
      }
    }
  },

  onEmit,

  getDataDir() {
    return require("../../config.cjs").dataDir();
  },

  // 人机校验：内嵌沙箱验证窗跑阿里云官方 SDK（zcodeCapture 是本能力的唯一实现）
  solveCaptcha(cfg, opts) {
    return require("../zcodeCapture.cjs").solveCaptcha(cfg, opts);
  },

  version() {
    try { return require("electron").app.getVersion(); } catch { return ""; }
  },

  log(level, msg, meta) {
    const text = meta === undefined ? String(msg) : `${msg} ${JSON.stringify(meta)}`;
    let line = text;
    try { line = require("../redact.cjs").redact(text); } catch { /* redact 不可用时原样 */ }
    (console[level] || console.log)(line);
  },

  /** 打开外部链接。opts.incognito：**无痕/独立配置打开**（多号登录用）。
   *
   *  为什么需要：号池要同时挂多个账号，而浏览器 cookie 是**按站点共享**的 —— 用系统默认浏览器
   *  登录第二个号时，第一个号的会话还在，页面直接以旧身份进去，拿到的授权码属于错误的账号。
   *  无痕模式每次开一个**全新**的临时配置目录，互不可见，才能真正"多号切换"。
   *
   *  实现顺序（从最贴合诉求到最通用）：
   *    ① 显式指定的浏览器（环境变量 AGENTHUB_INCOGNITO_BROWSER 或 opts.browser）
   *    ② Edge（`--inprivate`）—— Windows 自带，用户明确提出优先用它
   *    ③ Chrome / Chromium 系（`--incognito`）
   *    ④ 都找不到 → 退回系统默认浏览器（**如实把 ok:false 告诉调用方**，让界面提醒
   *       "这次不是无痕，多号登录请手动换一个浏览器"，绝不假装成功）
   *
   *  注意：`--incognito` 只是"这一次开无痕窗口"，不保证进程复用时的隔离；真正稳的做法是
   *  再给一个独立的 `--user-data-dir`，两者一起用。Edge/Chrome 都支持。 */
  openExternal(url, opts) {
    const target = String(url || "");
    const wantIncognito = !!(opts && opts.incognito);
    if (!wantIncognito) return require("electron").shell.openExternal(target).catch(() => {});
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { spawn } = require("node:child_process");
    // 候选浏览器：{ exe, args(profileDir) }
    const cands = [];
    const pushEdge = (exe) => cands.push({ name: "Edge", exe, arg: (dir) => ["--inprivate", `--user-data-dir=${dir}`, target] });
    const pushChrome = (exe) => cands.push({ name: "Chrome", exe, arg: (dir) => ["--incognito", `--user-data-dir=${dir}`, target] });
    const env = String(process.env.AGENTHUB_INCOGNITO_BROWSER || (opts && opts.browser) || "").trim();
    if (env) cands.push({ name: path.basename(env), exe: env, arg: (dir) => ["--incognito", `--user-data-dir=${dir}`, target] });
    for (const base of [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]) {
      if (!base) continue;
      pushEdge(path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      pushChrome(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
    const hit = cands.find((c) => { try { return fs.existsSync(c.exe); } catch { return false; } });
    if (!hit) {
      // 找不到任何可无痕启动的浏览器：**退回默认浏览器但明确报 ok:false**
      require("electron").shell.openExternal(target).catch(() => {});
      return Promise.resolve({ ok: false, message: "未找到 Edge / Chrome，已用默认浏览器打开（不是无痕；多号登录请手动换浏览器）" });
    }
    try {
      // 每次都新建独立配置目录：连"两个无痕窗口共享同一 profile"的边界情况也一并规避。
      // 用完不删（浏览器可能仍持有句柄）；临时目录由系统回收，最多占几 MB。
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-oauth-"));
      const child = spawn(hit.exe, hit.arg(dir), { detached: true, stdio: "ignore" });
      child.unref();
      return Promise.resolve({ ok: true, browser: hit.name, profileDir: dir });
    } catch (e) {
      require("electron").shell.openExternal(target).catch(() => {});
      return Promise.resolve({ ok: false, message: `无痕打开失败（${(e && e.message) || e}），已用默认浏览器打开` });
    }
  },

  openPath(p) {
    return require("electron").shell.openPath(String(p)).catch(() => {});
  },
};
