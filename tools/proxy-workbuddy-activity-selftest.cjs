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
// WorkBuddy 国际版「每日活跃」保活自测：验证三条通道各自的请求形状、错误容错与汇总口径。
//
// 依据：上游保活接口（issue #277 的实测结论）——
//   ① POST /v2/report            活跃上报（chat_request_send 事件数组）→ 点亮连登 streak
//   ② POST {chat}/chat/completions  免费模型最小对话（维持「账号有调用」）
//   ③ POST /console/as/conversations/  网页会话（**每日活跃计数只认它**）
// 本自测不起真实上游：用本地 http 服务逐个断言「打到哪个路径、带了什么头、体是什么形状」，
// 并覆盖三条都失败时 dailyActivity 仍返回结构化结果（不让签到因此翻成失败）。
//
// 用法：node tools/proxy-workbuddy-activity-selftest.cjs
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let failures = 0;
function assert(cond, label, extra) {
  if (cond) console.log("  ok   " + label);
  else { failures++; console.error("  FAIL " + label + (extra ? " —— " + extra : "")); }
}

/** 取 rules.cjs 里某个渠道在 **headers.json** 配置段的源码（供真值断言用）。
 *  同一渠道名在文件里出现多次（wb_models.json 目录段 / headers.json 配置段），
 *  必须挑含 chatUrl 的那一处——否则断言读到的是模型目录而不是配置，
 *  会全部假失败（实测踩过：indexOf 命中第一处就返回了）。 */
const fsRead = require("node:fs");
const pathMod = require("node:path");
function rulesSrcFor(channel) {
  const src = fsRead.readFileSync(pathMod.join(__dirname, "..", "electron", "backend", "proxy", "rules.cjs"), "utf8");
  const needle = `${channel}: {`;
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start < 0) return "";
    const end = src.indexOf("\n    },", start);
    const block = src.slice(start, end < 0 ? undefined : end + 6);
    if (block.includes("chatUrl")) return block;
    from = start + needle.length;
  }
}

async function main() {
  const seen = [];
  let failMode = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, headers: { ...req.headers }, body });
      if (failMode === "all") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"code":500,"message":"boom"}');
        return;
      }
      if (req.url.includes("/console/as/conversations")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"code":0,"data":{"conversationId":"c1"}}');
        return;
      }
      if (req.url.includes("/activity/growth/streak")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"code":0,"data":{"streak":{"days":3}}}');
        return;
      }
      if (req.url.endsWith("/report") || req.url.includes("/v2/report")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"code":0}');
        return;
      }
      // chat/completions：最小 SSE
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"h"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-activity-"));
  const locFile = path.join(os.homedir(), ".Dosage_sync.location");
  const prevLoc = fs.existsSync(locFile) ? fs.readFileSync(locFile, "utf8") : null;
  fs.writeFileSync(locFile, JSON.stringify({ path: dir }));
  try {
    const rules = require("../electron/backend/proxy/rules.cjs");
    // 全新沙箱里 rules/ 还不存在：init() 会把内置默认值落盘，之后才能改 headers.json
    rules.init();
    const cfgPath = path.join(rules.rulesDir(), "headers.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    // 三个域都指到本地假上游：billingBase（report/streak）、chatUrl（免费模型）、pluginBase
    cfg.workbuddy_ai.chatUrl = `${base}/v2/chat/completions`;
    cfg.workbuddy_ai.billingBase = base;
    cfg.workbuddy_ai.pluginBase = base;
    cfg.workbuddy_ai.webBase = base;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    rules.reload("headers.json");

    const adapters = require("../electron/backend/proxy/adapters.cjs");
    const ad = adapters.get("workbuddy_ai");
    const account = { id: "a1", uid: "u-123", channel: "workbuddy_ai" };
    const secrets = { token: "tk", refreshToken: "rt" };

    // ---- ① 活跃上报 ----
    seen.length = 0;
    const rep = await ad.reportActivity(account, secrets);
    assert(rep.succeeded === true, "活跃上报成功", rep.message);
    assert(rep.streakDays === 3, "回读连登天数", String(rep.streakDays));
    const reportReq = seen.find((s) => /\/report$|\/v2\/report/.test(s.url));
    assert(!!reportReq, "打到 /report");
    const reportBody = JSON.parse(reportReq.body);
    assert(Array.isArray(reportBody) && reportBody.length === 1, "体是「一个事件的数组」");
    const ev = reportBody[0];
    assert(ev.eventCode === "chat_request_send", "eventCode=chat_request_send");
    assert(ev.mode === "craft" && ev.agentType === "conversation", "mode/agentType 形状对齐");
    assert(ev.userId === "u-123", "事件带 userId");
    assert(typeof ev.presentAt === "number" && typeof ev.timestamp === "number", "时间戳为数字");

    // ---- ② 免费模型保活 ----
    seen.length = 0;
    const poke = await ad.pokeActivity(account, secrets);
    assert(poke.succeeded === true, "免费模型保活成功", poke.message);
    const chatReq = seen.find((s) => s.url.includes("/chat/completions"));
    assert(!!chatReq, "打到 chat/completions");
    const chatBody = JSON.parse(chatReq.body);
    assert(chatBody.stream === true && chatBody.max_tokens === 16, "最小流式体（stream + max_tokens=16）");
    assert(Array.isArray(chatBody.messages) && chatBody.messages.length === 2, "system+user 两条消息");
    // 必须与真对话同头族（缺 X-CodeBuddy-Request 就会被 11128 渠道校验拒）
    assert(chatReq.headers["x-codebuddy-request"] === "1", "保活沿用真对话的风控闸门头");
    assert(String(chatReq.headers.authorization || "").startsWith("Bearer "), "保活沿用 Bearer 鉴权");

    // ---- ③ 网页会话 ----
    seen.length = 0;
    const web = await ad.webConversation(account, secrets);
    assert(web.succeeded === true, "网页会话建立成功", web.message);
    const webReq = seen.find((s) => s.url.includes("/console/as/conversations"));
    assert(!!webReq, "打到 /console/as/conversations/");
    assert(!webReq.headers["x-ide-name"] && !webReq.headers["x-machine-id"], "网页链路剥掉桌面端指纹头");
    assert(webReq.headers["x-user-id"] === "u-123", "带 X-User-Id");
    const webBody = JSON.parse(webReq.body);
    assert(webBody.conversationOrigin === "workbuddy-app", "体带 conversationOrigin");
    assert(Array.isArray(webBody.plugins) && webBody.plugins.length === 1, "体带 plugins");

    // ---- 汇总：三步互补，任一成功即 ok ----
    seen.length = 0;
    const da = await ad.dailyActivity(account, secrets);
    assert(da.ok === true && da.report.succeeded && da.poke.succeeded && da.web.succeeded, "组合动作三步都成功");
    assert(/活跃上报|网页会话/.test(da.message), "汇总文案包含各步结论", da.message);

    // ---- 全失败：仍返回结构化结果，不抛 ----
    failMode = "all";
    const bad = await ad.dailyActivity(account, secrets);
    assert(bad && bad.ok === false && bad.report && bad.poke && bad.web, "全失败时返回结构化结果（不抛）");
    assert(typeof bad.message === "string" && bad.message.includes("失败"), "全失败文案如实报错");

    // ---- ④ 门槷回归：加油包领不到，每日活跃也必须跑 ----
    // 加油包是一次性 trial 端点，领过或下线后必然返回失败。若每日活跃以
    // trial 成败为门槛，领不到加油包的账号就永远拿不到「免费模型对话」这条
    // 每日积分主通道——用户反馈的实证。这里用源码断言把这个门槛钉住。
    const idxSrc = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "index.cjs"), "utf8");
    assert(
      /isIntlWorkBuddy && useAct === "checkin"/.test(idxSrc),
      "每日活跃挂在「国际版签到」分支上（不再挂在 trial 上——trial 是一次性的，领过即失败）"
    );
    assert(
      !/r\.ok !== false && typeof ad\.dailyActivity/.test(idxSrc),
      "旧的「trial 成功才跑每日活跃」门槛已移除"
    );
    assert(
      /if \(tr && tr\.ok\) r\.ok = true;/.test(idxSrc) && /if \(da && da\.ok\) r\.ok = true;/.test(idxSrc),
      "加油包失败但活跃通道走通时，本次动作判成功（主通道不被 trial 埋掉）"
    );

    // ---- ⑤ 保活模型链只放实测免费的模型 ----
    // hy4-preview / hy4-preview-f / deepseek-v4.1-flash 现已不再免费（2026-10 实测）。
    // 留在兜底链里，hy3 一失败就会自动试付费模型——一次保活烧掉用户真实额度。
    // 这里用源码断言把「宁肯失败不扣费」钉住，防止后人再把付费模型加回默认链。
    const adSrc = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
    assert(
      /const FREE_MODELS = \["hy3"\];/.test(adSrc),
      "保活默认模型链只有 hy3（不拿付费模型兜底）"
    );
    assert(
      !/const FREE_MODELS = \["hy3", "hy4/.test(adSrc),
      "默认链里没有 hy4 / deepseek 等已转付费的模型"
    );
    assert(
      /c\.keepaliveModels/.test(adSrc),
      "仍保留 keepaliveModels 配置口（确知免费时可显式扩展）"
    );
    // 顺序：keepaliveModels 在前，用户显式配置优先于硬编码默认
    assert(
      /\[\.\.\.new Set\(\[\.\.\.\(c\.keepaliveModels \|\| \[\]\), \.\.\.FREE_MODELS\]\)\]/.test(adSrc),
      "配置项排在默认链前面（显式配置优先）"
    );

    // ---- ⑥ 客户端标识必须对齐官方抓包真值 ----
    // 真值来源：官方 WorkBuddy AI 桌面端抓包 2026-10-23（5.8.4 / CLI 2.161.0）。
    // 版本三件套过期 → 上游渠道校验 400/11128，且**与请求体内容无关**
    // （实测：干净到只有 "You are a helpful assistant." + "hi" 的保活请求同样被拦），
    // 内容层怎么改都救不了。故这里把每个字段钉住。
    const EXPECT_UA = "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0";
    assert(/clientVersion: "5\.8\.4"/.test(adSrc) || /clientVersion: "5\.8\.4"/.test(rulesSrcFor("workbuddy_ai")),
      "clientVersion = 5.8.4（官方抓包真值）");
    assert(/cliVersion: "2\.161\.0"/.test(rulesSrcFor("workbuddy_ai")), "cliVersion = 2.161.0");
    assert(rulesSrcFor("workbuddy_ai").includes(`userAgent: "${EXPECT_UA}"`), "userAgent 三段式对齐官方（注意是小写 workbuddy-ai）");
    assert(rulesSrcFor("workbuddy_ai").includes(`productCode: "SaaS"`), "productCode = SaaS（官方实发值，不是 ideName）");
    // 出站头必须带 x-agent-intent / x-agent-type，且 x-product 不能是 ideName
    assert(/"x-agent-intent": "craft"/.test(adSrc), "出站带 x-agent-intent: craft");
    assert(/"x-agent-type": "main"/.test(adSrc), "主对话出站带 x-agent-type: main");
    assert(/"x-product": c\.productCode/.test(adSrc), "x-product 取配置的 productCode（不回退成 ideName）");
    // 保活是旁路，用 auxiliary
    assert(/"x-agent-type": "auxiliary"/.test(adSrc), "保活旁路用 x-agent-type: auxiliary");
    // X-Private-Data：官方桌面端对话请求带它（AutoBuddy 国际版实现 + dsh-connect-workbuddy#127）
    assert(/"x-private-data": "true"/.test(adSrc), "出站带 x-private-data: true");
    // 追踪族组合头（官方抓包有，此前完全没发）
    assert(/h\["b3"\] =/.test(adSrc) && /h\["traceparent"\] =/.test(adSrc), "出站带 b3 与 traceparent 组合头");
    // OpenAI SDK 标准头族（官方抓包有）
    assert(/"x-stainless-runtime": "node"/.test(adSrc), "出站带 x-stainless-* 头族");
    // 版本号不该再出现写死的 5.5.4 兜底
    assert(!/clientVersion \|\| "5\.5\.4"/.test(adSrc), "出站头没有写死的 5.5.4 兜底");

    // ---- 计费端点路径降级（404/405 必须换下一候选）----
    // 早先实现「拿到第一个响应就返回」不判状态码 → 排在前面但已下线的路径
    // （实测 /report 已 404，/v2/report 活着）会把后续候选饿死，上报恒定 404。
    assert(
      /if \(r\.status === 404 \|\| r\.status === 405\) \{/.test(adSrc) && /lastNotFound = r;/.test(adSrc),
      "billingCall 遇 404/405 换下一候选（不吞掉后面的活路径）"
    );
    assert(
      /billingCall\(account, secrets, \["\/v2\/report", "\/report"\]/.test(adSrc),
      "活跃上报用 /v2/report 优先（实测 /report 已 404）"
    );
    // 反向：实测 /v2/billing/ide/trial 已 404 而 /billing/ide/trial 活着，
    // 所以**不能**把候选表一律改成 v2 优先——必须靠 404 降级而非改顺序
    assert(
      /billingCall\(account, secrets, \["\/billing\/ide\/trial", "\/v2\/billing\/ide\/trial"\]/.test(adSrc),
      "trial 保持非 v2 优先（实测 /v2/billing/ide/trial 已 404）"
    );

    console.log("7. 国际版签到动作不得被改道成加油包");
    const ix = fsRead.readFileSync(pathMod.join(__dirname, "..", "electron", "backend", "proxy", "index.cjs"), "utf8");
    // 旧实现：`act === "checkin" && acc.channel === "workbuddy_ai" ? "trial" : act`
    // → workbuddy_ai 从来没调用过 /v2/billing/meter/daily-checkin，
    //   而每日积分正是走 daily-checkin 领的（trial 是一次性的，领过即 14051）。
    assert(
      !/act === "checkin" && acc\.channel === "workbuddy_ai" \? "trial"/.test(ix),
      "checkin 动作不再把 workbuddy_ai 改道成 trial（否则每日签到端点从没被领过）"
    );
    // 三件事互补：签到 + 加油包 + 每日活跃，都跑，结论取并集
    assert(/isIntlWorkBuddy && useAct === "checkin"/.test(ix), "国际版签到走三件事合并分支");
    assert(/ad\.trial\(acc, secrets\)/.test(ix) && /ad\.dailyActivity\(acc, secrets\)/.test(ix),
      "国际版签到同时跑加油包与每日活跃");
    assert(/if \(tr && tr\.ok\) r\.ok = true;/.test(ix) && /if \(da && da\.ok\) r\.ok = true;/.test(ix),
      "任一通道成功即算本次动作成功（不因单条失败判死）");
    // 每日签到端点必须在适配器里实现（否则改道解除了也没得领）
    assert(
      /"\/v2\/billing\/meter\/daily-checkin"/.test(adSrc),
      "适配器实现了 daily-checkin（国际版每日积分的领取端点）"
    );
    assert(
      /"\/billing\/meter\/checkin-activity-status"/.test(adSrc),
      "适配器实现了 checkin-activity-status（活动是否开放的探测端点）"
    );
    // 旧的重复分支必须移除，否则每日活跃会跑两次
    assert(!/if \(useAct === "trial" && typeof ad\.dailyActivity === "function"\)/.test(ix),
      "旧的 trial 分支不再重复跑每日活跃");
    // UI 按钮必须发 checkin（发 trial 只跑加油包，每日签到端点不会被调用）
    const vw = fsRead.readFileSync(pathMod.join(__dirname, "..", "src", "views", "proxy", "ProxyAgentsView.vue"), "utf8");
    assert(
      /action: "checkin"[\s\S]{0,200}workbuddy_ai|proxyCheckinRun\(\{ channel: "workbuddy_ai", action: "checkin" \}\)/.test(vw),
      "号池页「每日领积分」按钮发 action:checkin（发 trial 只会跑加油包）"
    );
    assert(!/proxyCheckinRun\(\{ channel: "workbuddy_ai", action: "trial" \}\)/.test(vw),
      "号池页不再对 workbuddy_ai 发 action:trial");

    console.log("8. 幂等判定必须看 code 字段（不是只扫 msg）");
    // 上游实际报文：{"code":14051,"msg":"has applied trial"} / {"code":14001,"msg":"already checked in"}
    // 14051 / 14001 在 code 里，msg 里没有数字；英文文案也不含 "already"（trial 那条是 "has applied"）
    // 旧实现只正则扫 msg → 「已领过 / 已签到」落到失败分支 → 明明领过却报失败
    assert(
      /code === 14051 \|\|/.test(adSrc),
      "trial 幂等判定看 code === 14051"
    );
    assert(
      /has applied|applied trial/i.test(adSrc),
      "trial 幂等文案覆盖英文 has applied trial"
    );
    assert(
      /code === 10001 \|\| code === 14001 \|\|/.test(adSrc),
      "checkin 幂等判定看 code === 10001/14001"
    );
    assert(
      /code === 14001 \|\| code === 10001 \|\|/.test(adSrc.split("checkin-activity-status").join("")) ||
        /unavailable = code === 14001/.test(adSrc),
      "checkinStatus 的 unavailable 判定也看 code"
    );
  } finally {
    server.close();
    if (prevLoc === null) fs.rmSync(locFile, { force: true });
    else fs.writeFileSync(locFile, prevLoc);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\nRESULT: ${failures} failed` : "\nWorkBuddy 每日活跃自测全过");
  // Windows 上 fetch（undici）的连接池会在 process.exit 与 libuv 关闭句柄之间抢跑，
  // 触发 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 并把退出码变成 127。
  // 让事件循环自然收尾（undici 的连接在 keep-alive 超时后释放）比强退更可靠；
  // 5 秒兜底仍不退就说明真有挂起句柄，此时 exitCode 已设置，断言结果仍可被 CI 读到。
  process.exitCode = failures ? 1 : 0;
  const t = setTimeout(() => process.exit(failures ? 1 : 0), 5000);
  t.unref();
}

main().catch((e) => {
  console.error("自测异常：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
