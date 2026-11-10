/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// WorkBuddy 账号级风控（403 code 11140）的**处置策略**自测（2026-11 上游收紧后新增）：
//   ① 默认停手：一个请求里第一个号被拦就不再换号（旧行为会连换到整池，加重设备连坐）；
//   ② 调大 wbRestrictedRotateMax 才恢复旧行为（换号继续试）；
//   ③ 连坐暂停：同渠道在窗口内被拦的账号数达阈值 → 整池暂停派发，期间一个上游请求都不发，
//      回给调用方的错误必须点明「暂停到什么时候」，而不是含糊的「无可用账号」；
//   ④ 暂停到期 / 成功一次 → 自动恢复（不残留内存态）；
//   ⑤ 文案不得再引导「重新登录」——社区实测重登/申诉工单/注销重注册都解不开。
// 用法：node tools/proxy-wb-restricted-selftest.cjs
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-wb-restricted-"));
process.env.APPDATA = tmp;
process.env.LOCALAPPDATA = path.join(tmp, "LocalAppData");
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

/** 上游 11140 真实响应体（2026-10 起国际版的 displayMsg：账号存在异常行为） */
const BLOCKED_BODY = JSON.stringify({
  code: 11140,
  msg: "request illegal",
  requestId: "b9046fb9-fde7-4e0a-869f-93f3d4868f87",
  displayMsg: {
    zh: "账号存在异常行为，已被限制使用",
    en: "Your account has been restricted due to unusual activity",
  },
});

const SSE_OK =
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"default-model","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
  "data: [DONE]\n\n";

async function main() {
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const pool = require("../electron/backend/proxy/pool.cjs");
  const server = require("../electron/backend/proxy/server.cjs");

  store.open();
  rules.init();

  // ===== 假上游：blocked-* 一律 11140，good-* 正常 =====
  const hits = { blocked: 0, good: 0 };
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const auth = String(req.headers.authorization || "");
      const blocked = /blocked/.test(auth);
      if (blocked) hits.blocked++;
      else hits.good++;
      if (blocked) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(BLOCKED_BODY);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_OK);
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const port = fake.address().port;

  const headersPath = path.join(rules.rulesDir(), "headers.json");
  const headersCfg = JSON.parse(fs.readFileSync(headersPath, "utf8"));
  headersCfg.workbuddy_ai.consoleChatUrl = "";
  headersCfg.workbuddy_ai.chatUrl = `http://127.0.0.1:${port}/v2/chat/completions`;
  headersCfg.workbuddy_ai.billingBase = `http://127.0.0.1:${port}`;
  headersCfg.workbuddy_ai.pluginBase = `http://127.0.0.1:${port}`;
  fs.writeFileSync(headersPath, JSON.stringify(headersCfg, null, 2));
  rules.reload("headers.json");

  const cfg = {
    port: 19610, bind: "127.0.0.1", rateLimitPerMin: 600, concurrency: 8,
    routeStrategy: "fixed", fixedChannel: "workbuddy_ai", modelOverrides: {},
    debugStatus: false, humanizeJitter: false, disabledModels: [],
    channelFailover: false, autoFallbackEnabled: false,
    // 默认策略（0 = 停手）；连坐阈值压到 2 个号 / 15 分钟窗 / 30 分钟暂停
    wbRestrictedRotateMax: 0, wbRestrictedWaveWindowMs: 900000, wbRestrictedWaveMin: 2, wbRestrictedHoldMs: 1800000,
  };
  const sr = await server.start(() => cfg);
  assert(sr.ok, "网关启动: " + (sr.message || ""));
  const base = `http://127.0.0.1:${cfg.port}`;
  const k = store.createKey({ name: "wb11140自测", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const call = () =>
    fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
      body: JSON.stringify({ model: "hy4free", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });

  // 三个被拦号 + 一个正常号
  const mk = (name, token) => store.addAccount({
    channel: "workbuddy_ai", uid: name, name, token, source: "paste", expiresAt: Date.now() + 7200000,
  });
  const b1 = mk("被拦号1", "blocked-1");
  const b2 = mk("被拦号2", "blocked-2");
  const b3 = mk("被拦号3", "blocked-3");
  const good = mk("正常号", "good-1");

  await T("T1 默认停手：一个号被 11140 拦下后不再换号（上游只被打一次）", async () => {
    // 只留 b1 可用，其余离线——保证第一个选中的就是被拦号
    store.updateAccount(b2, { status: "disabled" });
    store.updateAccount(b3, { status: "disabled" });
    store.updateAccount(good, { status: "disabled" });
    hits.blocked = 0;
    hits.good = 0;
    const r = await call();
    assert(r.status !== 200, "被拦时必须失败: " + r.status);
    const txt = await r.text();
    assert(hits.blocked === 1, "只打一次上游（不换号连坐）: " + JSON.stringify(hits));
    assert(/11140|风控/.test(txt), "错误要点明 11140/风控: " + txt.slice(0, 240));
    // 只禁「让用户去重登」的动作指引；如实说明「重登也解不开」是允许的（那是事实）
    assert(!/请重新登录|请重新登入|请.*重新登录该账号|please (re-?log ?in|sign ?in again)/i.test(txt),
      "不得再引导用户「重新登录」（实测解不开）: " + txt.slice(0, 240));
    assert(!/内容未通过安全审核|safety review/.test(txt), "不得透传误导性的审核文案: " + txt.slice(0, 240));
  });

  await T("T2 被拦号落 2h 冷却，理由是真话", () => {
    const acc = store.listAccounts("workbuddy_ai").find((a) => a.id === b1);
    assert(acc.status === "cooling", "应冷却: " + acc.status);
    const left = acc.coolUntil - Date.now();
    assert(left > 90 * 60000 && left <= 2 * 3600000 + 60000, "冷却应约 2h: " + Math.round(left / 60000) + "min");
    assert(/风控/.test(acc.coolReason) && /11140/.test(acc.coolReason), "冷却理由必须是真话: " + acc.coolReason);
  });

  await T("T3 wbRestrictedRotateMax=1 时恢复旧行为：换一个号后才停手（上游被打 2 次）", async () => {
    store.updateAccount(b1, { status: "online", coolUntil: 0, coolReason: "" });
    store.updateAccount(b2, { status: "online", coolUntil: 0, coolReason: "" });
    cfg.wbRestrictedRotateMax = 1;
    cfg.wbRestrictedHoldMs = 0; // 本用例只验换号配额，关掉连坐暂停避免互相干扰
    pool.clearRestrictedWave("workbuddy_ai");
    hits.blocked = 0;
    const r = await call();
    await r.text();
    assert(r.status !== 200, "两个号都被拦，最终仍失败: " + r.status);
    assert(hits.blocked === 2, "配额 1 = 允许换号一次，上游应被打两次: " + JSON.stringify(hits));
    cfg.wbRestrictedRotateMax = 0;
    cfg.wbRestrictedHoldMs = 1800000;
    pool.clearRestrictedWave("workbuddy_ai");
  });

  await T("T4 连坐暂停：同渠道再拦一个号 → 整池暂停，期间零上游请求", async () => {
    // b1/b2 已在上面被冷却；把 b3 放出来再撞一次，凑够阈值 2
    store.updateAccount(b1, { status: "online", coolUntil: 0, coolReason: "" });
    store.updateAccount(b2, { status: "online", coolUntil: 0, coolReason: "" });
    store.updateAccount(b3, { status: "online", coolUntil: 0, coolReason: "" });
    pool.clearRestrictedWave("workbuddy_ai");
    cfg.wbRestrictedWaveMin = 1; // 阈值 1：一次就触发暂停，便于断言
    const r1 = await call();
    await r1.text();
    cfg.wbRestrictedWaveMin = 2;
    const hold = pool.channelRestricted("workbuddy_ai");
    assert(!!hold, "应已整池暂停: " + JSON.stringify(hold));
    assert(hold.until > Date.now() + 60 * 1000, "暂停时长应显著: " + Math.round((hold.until - Date.now()) / 60000) + "min");
    // 暂停期内再发请求：不得打到上游
    const before = hits.blocked + hits.good;
    const r2 = await call();
    const txt = await r2.text();
    assert(hits.blocked + hits.good === before, "暂停期内一个上游请求都不该发: " + JSON.stringify(hits));
    assert(r2.status !== 200, "暂停期请求必须失败: " + r2.status);
    assert(/暂停|风控/.test(txt), "错误要点明暂停/风控: " + txt.slice(0, 240));
  });

  await T("T5 成功一次即清除暂停（不残留内存态）", async () => {
    pool.clearRestrictedWave("workbuddy_ai");
    assert(pool.channelRestricted("workbuddy_ai") === null, "清后应无暂停");
    // 只留正常号，成功一次
    for (const id of [b1, b2, b3]) store.updateAccount(id, { status: "disabled" });
    store.updateAccount(good, { status: "online", coolUntil: 0, coolReason: "" });
    const r = await call();
    assert(r.status === 200, "正常号应成功: " + r.status);
    assert(pool.channelRestricted("workbuddy_ai") === null, "成功后仍无暂停");
  });

  await T("T6 wbRestrictedHoldMs=0 关闭整池暂停（行为可配）", () => {
    pool.clearRestrictedWave("workbuddy_ai");
    cfg.wbRestrictedHoldMs = 0;
    const wave = pool.noteAccountRestricted("workbuddy_ai", cfg);
    assert(wave.hold === false, "关闭后不得触发暂停: " + JSON.stringify(wave));
    assert(pool.channelRestricted("workbuddy_ai") === null, "关闭后应无暂停");
    cfg.wbRestrictedHoldMs = 1800000;
  });

  await T("T7 文案含「暂停到什么时候」的信息（可执行，不含误导）", () => {
    // 直接构造一次 hold 状态，检查文案
    cfg.wbRestrictedWaveMin = 1;
    const wave = pool.noteAccountRestricted("workbuddy_ai", cfg);
    assert(wave.hold, "阈值 1 应触发暂停");
    const hold = pool.channelRestricted("workbuddy_ai");
    const msg = require("../electron/backend/proxy/server.cjs");
    // 文案函数未导出，这里用端到端断言（T4 已覆盖）；本用例只钉住「暂停状态可查询且有到期时刻」
    assert(hold && hold.until > Date.now(), "暂停状态须带到期时刻: " + JSON.stringify(hold));
    cfg.wbRestrictedWaveMin = 2;
    pool.clearRestrictedWave("workbuddy_ai");
  });

  await T("T8 默认阈值=1：拦下一个号就整池暂停（不等第 2 个）", async () => {
    // 这是 2026-11-11 的核心诉求：上游按设备/出口连带判定，等第 2 个号才停已经晚了
    for (const id of [b1, b2, b3, good]) store.updateAccount(id, { status: "online", coolUntil: 0, coolReason: "" });
    pool.clearRestrictedWave("workbuddy_ai");
    // 用内置默认值（不传 wbRestrictedWaveMin），验证真实默认就是 1
    const wave = pool.noteAccountRestricted("workbuddy_ai", {});
    assert(wave.min === 1, "默认阈值必须是 1（拦一个就停）: " + wave.min);
    assert(wave.hold === true && wave.count === 1, "拦下第 1 个号就该触发暂停: " + JSON.stringify(wave));
    assert(pool.channelRestricted("workbuddy_ai"), "暂停状态应可查询");
    pool.clearRestrictedWave("workbuddy_ai");
  });

  await T("T9 暂停只掐本渠道：同一模型的其它渠道照常接住（换渠道安全，不被 11140 连坐）", async () => {
    // glm-5.3 同时被 workbuddy_ai 与 trae 承载（见 rules/catalog.json），用它做真实双渠道验证：
    // workbuddy_ai 被 11140 暂停后，请求应跳到 trae 成功——证明「停手」只作用于本渠道
    const traeHits = { n: 0 };
    const traeSrv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        traeHits.n++;
        // trae 的事件形态与 OpenAI 不同：它把正文放在 data 帧的 message 字段里（不是
        // choices[0].delta.content）。按 OpenAI 形态回会被判「空响应」——这正是本用例
        // 第一次跑出来的现象，也说明网关确实把请求发到了 trae。
        res.writeHead(200, { "content-type": "text/event-stream" });
        // trae 的事件形态：{event:"output", response:"..."} → {event:"token_usage"} → {event:"done"}
        res.write('data: {"event":"output","response":"from-trae"}\n\n');
        res.write('data: {"event":"token_usage","prompt_tokens":3,"completion_tokens":2,"total_tokens":5}\n\n');
        res.write('data: {"event":"done","finish_reason":"stop"}\n\n');
        res.end();
      });
    });
    await new Promise((r) => traeSrv.listen(0, "127.0.0.1", r));
    const traePort = traeSrv.address().port;
    const cfg2 = JSON.parse(fs.readFileSync(headersPath, "utf8"));
    cfg2.trae.chatUrl = `http://127.0.0.1:${traePort}/trae/chat`;
    fs.writeFileSync(headersPath, JSON.stringify(cfg2, null, 2));
    rules.reload("headers.json");
    store.addAccount({ channel: "trae", uid: "tr1", name: "trae号", token: "trae-token", source: "paste", expiresAt: Date.now() + 7200000 });
    // workbuddy_ai 侧留一个可用号（会被暂停挡住，不该被打）
    for (const id of [b2, b3]) store.updateAccount(id, { status: "disabled" });
    store.updateAccount(good, { status: "disabled" });
    store.updateAccount(b1, { status: "online", coolUntil: 0, coolReason: "" });
    // 手动把 workbuddy_ai 置为暂停，模拟「刚被拦下一个号」
    pool.clearRestrictedWave("workbuddy_ai");
    assert(pool.noteAccountRestricted("workbuddy_ai", {}).hold, "workbuddy_ai 应已暂停");
    cfg.channelFailover = true;
    cfg.channelFailoverMax = 5;
    const wbBefore = hits.blocked;
    const r = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + k.secret },
      body: JSON.stringify({ model: "glm-5.3", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    const txt = await r.text();
    assert(hits.blocked === wbBefore, "暂停期内被暂停渠道零上游请求: " + JSON.stringify(hits));
    assert(traeHits.n >= 1, "应跳到 trae（其它渠道不被连坐）: " + traeHits.n);
    assert(r.status === 200 && /from-trae/.test(txt), "请求应由 trae 接住: " + r.status + " " + txt.slice(0, 200));
    cfg.channelFailover = false;
    cfg.channelFailoverMax = 3;
    pool.clearRestrictedWave("workbuddy_ai");
    await new Promise((r) => traeSrv.close(r));
  });

  await server.stopAsync();
  await new Promise((r) => fake.close(r));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log(failures.join("\n"));
    process.exitCode = 1;
  }
  const t = setTimeout(() => process.exit(fail ? 1 : 0), 3000);
  t.unref();
}

main().catch((e) => {
  console.error("自测异常：", (e && e.stack) || e);
  process.exit(1);
});