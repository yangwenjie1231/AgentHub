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
// WorkBuddy 对话链路端到端自测（issue #156/#157 的「网关能用」兜底护栏）
//
// 为什么需要这个：
//   每日保活（pokeActivity）**自己拼 payload 直接发**，完全绕过 rewriteBody ——
//   所以「保活成功」只证明了**出站头**被上游接受，**没有验证请求体管线**
//   （消息合并 / 工具调用配对 / reasoning 回填 / 字段改写）。
//   adapter-contract 自测只验「方法存不存在」，不验行为。
//   本自测把 ad.chat() 整条链路对着本地假上游跑一遍：改写 → 出站 → SSE 解析 → 事件。
//
// 用法：node tools/proxy-wb-chat-e2e-selftest.cjs
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

async function main() {
  const seen = [];
  let failMode = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, headers: { ...req.headers }, body });
      if (failMode === "500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"code":500,"message":"boom"}');
        return;
      }
      // 未知路径按 404 处理（真实上游行为）——否则端点回退分支永远测不到
      const known = req.url.includes("/chat/completions");
      if (!known) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"code":404,"message":"not found"}');
        return;
      }
      // 官方形态的 SSE：内容帧 + tool_calls 帧 + usage 帧 + [DONE]
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: {"id":"c1","object":"chat.completion.chunk","model":"deepseek-v4.1-flash","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-"));
  const locFile = path.join(os.homedir(), ".Dosage_sync.location");
  const prevLoc = fs.existsSync(locFile) ? fs.readFileSync(locFile, "utf8") : null;
  fs.writeFileSync(locFile, JSON.stringify({ path: dir }));
  try {
    const rules = require("../electron/backend/proxy/rules.cjs");
    rules.init();
    const cfgPath = path.join(rules.rulesDir(), "headers.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.workbuddy_ai.chatUrl = `${base}/v2/chat/completions`;
    cfg.workbuddy_ai.billingBase = base;
    cfg.workbuddy_ai.pluginBase = base;
    cfg.workbuddy_ai.webBase = base;
    // 假上游不校验版本，测试里用配置的版本断言即可
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    rules.reload("headers.json");

    const adapters = require("../electron/backend/proxy/adapters.cjs");
    const ad = adapters.get("workbuddy_ai");
    const account = { id: "a1", uid: "u-e2e-0001", channel: "workbuddy_ai" };
    const secrets = { token: "tk-e2e", refreshToken: "rt-e2e" };

    const body = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "system", content: "You are an AI assistant." },
        { role: "user", content: "读一下 a.txt" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "file-content" },
        { role: "user", content: "继续" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    };

    const events = [];
    console.log("1. chat() 全链路");
    seen.length = 0;
    const res = await ad.chat({
      account, secrets, model: "deepseek-v4.1-flash",
      body, meta: { conversationRequestId: "b".repeat(32) },
      emit: (e) => events.push(e),
    });
    assert(res && res.status === 200, "chat() 返回 200", JSON.stringify(res && res.status));

    const req = seen.find((s) => s.url.includes("/chat/completions"));
    assert(!!req, "打到了 /v2/chat/completions");
    if (!req) throw new Error("没有上游请求");

    console.log("2. 出站头（渠道门）");
    const h = req.headers;
    assert(h["x-conversation-id"] !== undefined, "带 x-conversation-id");
    assert(h["x-conversation-request-id"] !== undefined, "带 x-conversation-request-id");
    assert(h["x-conversation-message-id"] !== undefined, "带 x-conversation-message-id");
    assert(h["x-agent-intent"] === "craft", "带 x-agent-intent: craft", h["x-agent-intent"]);
    assert(h["x-agent-type"] === "main", "带 x-agent-type: main", h["x-agent-type"]);
    assert(h["x-product"] === "SaaS", "x-product = SaaS", h["x-product"]);
    assert(h["x-private-data"] === "true", "带 x-private-data: true", h["x-private-data"]);
    assert(h["x-ide-version"] === "5.8.4", "x-ide-version = 5.8.4", h["x-ide-version"]);
    assert(/^WorkBuddy\/5\.8\.4 workbuddy-ai\/5\.8\.4 CLI\/2\.161\.0/.test(String(h["user-agent"])), "UA 对齐官方三段式", h["user-agent"]);
    assert(h["x-codebuddy-request"] === "1", "带 x-codebuddy-request");
    assert(h["x-domain"] === "www.workbuddy.ai", "x-domain = www.workbuddy.ai", h["x-domain"]);
    assert(h["x-user-id"] === "u-e2e-0001", "带 x-user-id");
    assert(String(h.authorization || "").startsWith("Bearer "), "Bearer 鉴权");
    assert(!!h["b3"] && !!h["traceparent"], "带 b3 与 traceparent 组合头");
    assert(h["x-stainless-runtime"] === "node", "带 x-stainless-* 头族");

    console.log("3. 出站体（请求体管线）");
    const sent = JSON.parse(req.body);
    assert(sent.model === "deepseek-v4.1-flash", "model 正确", sent.model);
    assert(sent.stream === true, "stream=true");
    assert(sent.stream_options && sent.stream_options.include_usage === true, "stream_options.include_usage");
    assert(Array.isArray(sent.messages) && sent.messages.length >= 4, "messages 条数合理", String(sent.messages && sent.messages.length));
    // 工具调用配对必须保持：assistant.tool_calls 与 tool 结果都要在
    const hasToolCall = sent.messages.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length);
    const hasToolResult = sent.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1");
    assert(hasToolCall, "assistant 的 tool_calls 保留");
    assert(hasToolResult, "tool 结果与其配对保留");
    // 工具调用的 arguments 不能被脱敏破坏（JSON 结构）
    const tcMsg = sent.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    if (tcMsg) {
      let parsed = null;
      try { parsed = JSON.parse(tcMsg.tool_calls[0].function.arguments); } catch { /* ignore */ }
      assert(parsed && parsed.path === "a.txt", "tool_call.arguments 仍是合法 JSON 且内容完整", tcMsg.tool_calls[0].function.arguments);
      assert(tcMsg.tool_calls[0].function.name === "read_file", "tool_call.name 未被改写");
    }
    // 系统提示词走脱敏但可见字符不变
    const sys = sent.messages.find((m) => m.role === "system");
    assert(!!sys, "system 消息在");
    if (sys) assert(String(sys.content).split("\u200b").join("") === "You are an AI assistant.", "system 内容脱敏后可见字符不变");

    console.log("4. SSE 解析 → 客户端事件");
    const deltas = events.filter((e) => e.type === "delta");
    const finish = events.filter((e) => e.type === "finish");
    const usage = events.filter((e) => e.type === "usage");
    assert(deltas.length >= 2, "至少收到 2 个 delta", String(deltas.length));
    assert(finish.length >= 1, "收到 finish 事件", String(finish.length));
    assert(usage.length >= 1, "收到 usage 事件", String(usage.length));
    if (usage.length) {
      assert(usage[0].usage.total_tokens === 14, "usage.total_tokens 正确", String(usage[0].usage.total_tokens));
      assert(usage[0].usage.prompt_tokens === 11, "usage.prompt_tokens 正确");
    }
    assert(!events.some((e) => e.type === "error"), "没有 error 事件");

    console.log("5. 上游报错时的行为");
    seen.length = 0;
    failMode = "500";
    events.length = 0;
    let threw = null;
    try {
      await ad.chat({
        account, secrets, model: "deepseek-v4.1-flash",
        body: { ...body }, meta: { conversationRequestId: "c".repeat(32) },
        emit: (e) => events.push(e),
      });
    } catch (e) { threw = e; }
    assert(!!threw, "上游 5xx 会抛（交给上层分类换号/降级）");
    failMode = "";

    console.log("6. 端点回退（/v2 404 → console 兜底）");
    seen.length = 0;
    events.length = 0;
    // 把 chatUrl 指到一个 404 路径，验证会回退到 consoleChatUrl
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg2.workbuddy_ai.chatUrl = `${base}/v2/nonexistent`;
    cfg2.workbuddy_ai.consoleChatUrl = `${base}/console/chat/completions`;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2));
    rules.reload("headers.json");
    const adapters2 = require("../electron/backend/proxy/adapters.cjs");
    const ad2 = adapters2.get("workbuddy_ai");
    const res2 = await ad2.chat({
      account, secrets, model: "deepseek-v4.1-flash",
      body: { ...body }, meta: { conversationRequestId: "d".repeat(32) },
      emit: (e) => events.push(e),
    });
    assert(res2 && res2.status === 200, "404 后回退到 console 端点成功");
    assert(seen.some((s) => s.url.includes("/console/chat/completions")), "确实打了 console 端点");
    assert(events.filter((e) => e.type === "delta").length >= 2, "回退路径的事件解析同样正常");
  } finally {
    server.close();
    if (prevLoc === null) fs.rmSync(locFile, { force: true });
    else fs.writeFileSync(locFile, prevLoc);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  console.log(failures ? `RESULT: ${failures} failed` : "WorkBuddy 对话链路端到端自测全过");
  process.exitCode = failures ? 1 : 0;
  const t = setTimeout(() => process.exit(failures ? 1 : 0), 5000);
  t.unref();
}

main().catch((e) => {
  console.error("自测异常：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});