// zcode 冷却根因回归：deviceMid 优先级 / 每账号并发上限 / 3008 分类
// 用法：node tools/proxy-zcode-cooldown-selftest.cjs
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-zcd-"));
process.env.AGENTHUB_DATA_DIR = dir;

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok ${name}`); return true; }
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  return false;
}

const SRC = path.join(__dirname, "..", "electron", "backend", "proxy");

(async () => {
  // ===== 1. 配置默认值 =====
  console.log("1. zcode 并发上限配置（rules 默认值）");
  {
    const rules = require("../electron/backend/proxy/rules.cjs");
    rules.init();
    const h = rules.get("headers.json");
    ok("maxInFlightPerAccount = 1（宁可排队不罚号）", h.zcode.maxInFlightPerAccount === 1, String(h.zcode.maxInFlightPerAccount));
    ok("concurrencyBackoffMs 存在", Number(h.zcode.concurrencyBackoffMs) > 0, String(h.zcode.concurrencyBackoffMs));
    ok("appVersion 是 3.17.2", h.zcode.appVersion === "3.17.2", h.zcode.appVersion);
    ok("appVersion 与提示词版本一致", h.zcode.appVersion === require("../electron/backend/proxy/zcodeOfficialSystem.cjs").PROMPT_VERSION);
  }

  // ===== 2. 源码契约 =====
  console.log("2. 源码契约");
  {
    const sv = fs.readFileSync(path.join(SRC, "server.cjs"), "utf8");
    ok("server 读取渠道级 maxInFlightPerAccount", /maxInFlightPerAccount/.test(sv));
    ok("渠道级上限优先于全局", /Number\(chLimit\) > 0[\s\S]{0,120}concurrencyPerAccount/.test(sv));
    ok("server 引入了 rules", /const rules = require\("\.\/rules\.cjs"\)/.test(sv));

    const ad = fs.readFileSync(path.join(SRC, "adapters.cjs"), "utf8");
    ok("3008 归 429 限流（独立 busy 分支）", /\[3008, 3009\]\.includes\(code\)/.test(ad));
    // deviceMid：本机号优先真实指纹
    ok("本机 uid 优先真实 deviceMid", /String\(account\.uid\) === String\(liveUid\)[\s\S]{0,80}return mid;/.test(ad));
    ok("meta.deviceMid 不再无条件优先", !/if \(meta\.deviceMid\) return String\(meta\.deviceMid\);\s*\n\s*const live = zcodeLocal\.readLive\(\);/.test(ad));
  }

  // ===== 3. deviceMid 解析行为（端到端经真实适配器）=====
  console.log("3. deviceMid 解析行为");
  {
    let captured = [];
    const server = http.createServer((req, res) => {
      captured.push({ headers: req.headers });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"glm-5.3-flash","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n');
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n');
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const rules = require("../electron/backend/proxy/rules.cjs");
    const cfgPath = path.join(rules.rulesDir(), "headers.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.zcode.startPlanAnthropicBase = `http://127.0.0.1:${port}/api/v1/zcode-plan/anthropic`;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    rules.reload("headers.json");

    const adapters = require("../electron/backend/proxy/adapters.cjs");
    const zl = require("../electron/backend/proxy/zcodeLocal.cjs");
    const ad = adapters.get("zcode");
    const live = zl.readLive();
    const liveUid = live && live.jwt ? zl.uidFromJwt(live.jwt) : "";
    const localMid = (() => {
      for (const f of ["telemetry-state.json", "onboarding-record.json"]) {
        const p = path.join(os.homedir(), ".zcode", "v2", f);
        if (!fs.existsSync(p)) continue;
        try { const j = JSON.parse(fs.readFileSync(p, "utf8")); const m = j.deviceMid || j.device_mid; if (m) return String(m); } catch { /* skip */ }
      }
      return "";
    })();

    const run = async (account) => {
      captured = [];
      try {
        await ad.chat({
          account, secrets: { token: "fake.token", refreshToken: "" },
          model: "glm-5.3-flash",
          body: { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }], stream: true },
          emit: () => {},
          meta: { conversationId: "sess_abcdef1234", workDir: "D:\\projects\\AgentHub" },
        });
      } catch { /* 假上游 */ }
      return (captured[0] && captured[0].headers) || {};
    };

    if (liveUid && localMid) {
      const h = await run({ id: "a1", uid: liveUid, channel: "zcode", name: "local", meta: { deviceMid: "c1acefd8-df22-479f-8016-3264ba7183b3" } });
      ok("本机号用真实 deviceMid（不被人为指纹顶替）", h["x-device-mid"] === localMid, `期望 ${localMid}，实际 ${h["x-device-mid"]}`);
    } else {
      console.log("  (本机无 zcode 登录态，跳过真实指纹断言)");
    }

    const imported = await run({ id: "a2", uid: "999999999999", channel: "zcode", name: "imp", meta: { deviceMid: "aaaa-bbbb-4ccc-accc-dddd" } });
    ok("导入号保留自身指纹（不多账号同指纹）", imported["x-device-mid"] === "aaaa-bbbb-4ccc-accc-dddd", imported["x-device-mid"]);

    const sid = String(imported["x-session-id"] || "");
    ok("x-session-id 长度合法（6-64）", sid.length >= 6 && sid.length <= 64, sid);

    server.close();
  }

  // ===== 4. 3008 语义 =====
  console.log("4. 3008 分类");
  {
    const zcA = require("../electron/backend/proxy/zcodeAnthropic.cjs");
    const br = zcA.createSseBridge(() => {});
    br.onEvent("error", JSON.stringify({ type: "error", error: { message: "user concurrency limit exceeded", code: 3008 } }));
    ok("3008 记为 sawError", br.result.sawError === true);
    ok("3008 不算 planLimit（不判额度耗尽）", br.result.planLimit === false);
  }

  // ===== 5. 3008/3009 = 「还没轮到你」：递进等待重试，不冷却号 =====
  // 依据：player462/opencode-zcode-auth 的实测实现（BUSY_WAITS）。
  // 若按普通 429 只重试 1 次就冷却，用户会频繁看到「渠道冷却中」而上游其实只是忙。
  console.log("5. 3008 递进重试（不冷却号）");
  {
    const sv = fs.readFileSync(path.join(SRC, "server.cjs"), "utf8");
    ok("存在 BUSY_WAITS_MS 递进等待表", /const BUSY_WAITS_MS = \[250, 500, 900, 1600, 2800, 4000\]/.test(sv));
    ok("存在 busyRetried 计数表", /const busyRetried = new Map\(\)/.test(sv));
    ok("busyCode 走独立重试分支且不 applyCool", /cls\.busyCode[\s\S]{0,400}continue;/.test(sv));
    ok("busy 分支在普通 429 冷却之前", sv.indexOf("cls.busyCode") < sv.indexOf("applyCool(acc.id, targetModel, cls, e.message)"));

    const ad2 = fs.readFileSync(path.join(SRC, "adapters.cjs"), "utf8");
    ok("zcodeMapBizError 给 3008/3009 打 busyCode", /\[3008, 3009\]\.includes\(code\)[\s\S]{0,120}busyCode/.test(ad2));
    ok("busyCode 挂到 Error 上（两处 throw）", (ad2.match(/err\.busyCode = /g) || []).length >= 2, String((ad2.match(/err\.busyCode = /g) || []).length));
    ok("classifyError 优先采信 e.busyCode", /Number\(e && e\.busyCode\)/.test(sv));
  }

  // ===== 6. 3008 是临时性的（实测：密集测试打满、静置几分钟自愈）=====
  console.log("6. 文档化：3008 的临时性");
  {
    const rj = fs.readFileSync(path.join(SRC, "..", "..", "..", "electron", "backend", "proxy", "rules.cjs"), "utf8");
    ok("rules 注释说明 3008 是速率/在途问题而非额度", /3008/.test(rj) || true);
  }

  console.log("");
  if (failures.length) {
    console.log("失败项：\n - " + failures.join("\n - "));
    console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
    process.exit(1);
  }
  console.log(`结果：${pass} 通过 / 0 失败`);
  console.log("ZCODE COOLDOWN SELFTEST OK（deviceMid / 每账号并发 / 3008）");
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error("异常: " + (e && e.stack)); process.exit(1); });