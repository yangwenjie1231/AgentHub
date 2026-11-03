// 验证：零宽字符在统一 emit 出口被剥离（覆盖所有渠道，不只是 WorkBuddy）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-zw-"));
process.env.AGENTHUB_DATA_DIR = dir;

let fail = 0;
const ok = (c, l, e) => { if (c) console.log("  ok   " + l); else { fail++; console.error("  FAIL " + l + (e ? " —— " + e : "")); } };

(async () => {
  const d = require("../electron/backend/proxy/desensitize.cjs");

  console.log("1. 剥离函数本身");
  {
    ok("删 U+200B", d.stripZeroWidth("a\u200bb") === "ab");
    ok("删 U+200C/200D/FEFF", d.stripZeroWidth("a\u200Cb\u200Dc\uFEFFd") === "abcd");
    ok("不动可见内容", d.stripZeroWidth("正常 ABC 123") === "正常 ABC 123");
    ok("空值安全", d.stripZeroWidth("") === "" && d.stripZeroWidth(null) === null && d.stripZeroWidth(undefined) === undefined);
    ok("深度：对象+数组", JSON.stringify(d.stripZeroWidthDeep({ a: "x\u200by", b: ["p\u200bq"], c: { d: "r\u200bs" } })) === '{"a":"xy","b":["pq"],"c":{"d":"rs"}}');
    ok("深度：数字/布尔/null 不动", JSON.stringify(d.stripZeroWidthDeep({ n: 1, b: true, z: null })) === '{"n":1,"b":true,"z":null}');
  }

  console.log("2. 统一出口已接线（源码契约）");
  {
    const sv = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "server.cjs"), "utf8");
    ok("server.cjs 引入 desensitize", /const desensitize = require\("\.\/desensitize\.cjs"\)/.test(sv));
    ok("emit 出口对 delta 做深度剥离", /delta: desensitize\.stripZeroWidthDeep\(ev\.delta\)/.test(sv));
    ok("emit 出口对 error.message 剥离", /message: desensitize\.stripZeroWidth\(ev\.message\)/.test(sv));
    // 这是唯一出口：适配器里 20+ 个 emit 点都汇到这里，故一处覆盖全部渠道
    ok("剥离在 emit 定义处（而非某个渠道分支）", /const emit = \(ev\) => \{[\s\S]{0,900}stripZeroWidthDeep/.test(sv));
  }

  console.log("3. 端到端：模拟上游返回带零宽的 delta");
  {
    // 假上游：delta 内容里塞 U+200B
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"你\\u200b好"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"世\\u200b界"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const rules = require("../electron/backend/proxy/rules.cjs");
    rules.init();
    const cfgPath = path.join(rules.rulesDir(), "headers.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.workbuddy.chatUrl = `http://127.0.0.1:${port}/v2/chat/completions`;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    rules.reload("headers.json");

    const adapters = require("../electron/backend/proxy/adapters.cjs");
    const ad = adapters.get("workbuddy");
    const events = [];
    await ad.chat({
      account: { id: "a1", uid: "u-1", channel: "workbuddy" },
      secrets: { token: "tk" },
      model: "deepseek-v4.1-flash",
      body: { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true },
      emit: (e) => events.push(e),
    });
    server.close();

    const text = events.filter((e) => e.type === "delta").map((e) => (e.delta && e.delta.content) || "").join("");
    ok("适配器层已剥离（WorkBuddy chat 路径）", text.indexOf("\u200b") < 0, JSON.stringify(text));
    ok("可见内容完好", text === "你好世界", JSON.stringify(text));
  }

  console.log("");
  console.log(fail ? `RESULT: ${fail} failed` : "零宽字符剥离自测全过");
  process.exitCode = fail ? 1 : 0;
  const t = setTimeout(() => process.exit(fail ? 1 : 0), 3000);
  t.unref();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
})().catch((e) => { console.error("异常: " + (e && e.stack)); process.exit(1); });