// ZCode start-plan 三段式 system + 1005 分类 自测
// 用法：node tools/proxy-zcode-startplan-selftest.cjs
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-zsp-"));
process.env.AGENTHUB_DATA_DIR = dir;

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok ${name}`); return true; }
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  return false;
}

const z = require("../electron/backend/proxy/zcodeOfficialSystem.cjs");
const P = z.PROMPT_3172;

// ===== 1. 提示词数据完整性（文本错 → 线上全挂）=====
console.log("1. 3.17.2 提示词数据");
{
  ok("PROMPT_VERSION 是 3.17.2", z.PROMPT_VERSION === "3.17.2", z.PROMPT_VERSION);
  ok("cliPrefix 精确一致", P.cliPrefix === "You are ZCode, an interactive agent", P.cliPrefix);
  ok("stableSections 两段", Array.isArray(P.stableSections) && P.stableSections.length === 2, String(P.stableSections && P.stableSections.length));
  ok("stableSections[0] 以 agent working 开头", P.stableSections[0].trimStart().startsWith("You are an agent working with the user"), P.stableSections[0].slice(0, 50));
  ok("stableSections[0] 含 IMPORTANT 安全声明", P.stableSections[0].includes("IMPORTANT: Assist with authorized security testing"));
  ok("stableSections[0] 含 # Harness", P.stableSections[0].includes("# Harness"));
  ok("stableSections[1] 是 ZCode Desktop Context", P.stableSections[1].startsWith("# ZCode Desktop Context"), P.stableSections[1].slice(0, 40));
  ok("dynamicBehavior 非空", typeof P.dynamicBehavior === "string" && P.dynamicBehavior.length > 500);
  ok("contextManagement 含 # Context management", String(P.contextManagement).startsWith("# Context management"));
  ok("poweredBy 含占位符", String(P.poweredBy).includes("{provider}") && String(P.poweredBy).includes("{model}"));
  ok("sessionGuidance 含 Skill 引导", String(P.sessionGuidance).includes("Skill"));
  ok("environment 有 heading", !!(P.environment && P.environment.heading), JSON.stringify(P.environment));

  // 尺寸护栏：官方块 1+2 合计实测 2608 字符，偏差过大说明取错版本
  const fixedLen = P.cliPrefix.length + 1 + P.stableSections.join("\n\n").length;
  ok("固定段长度在 2600±60 区间（防版本错配）", fixedLen > 2540 && fixedLen < 2670, String(fixedLen));
}

// ===== 2. 三段式形状 =====
console.log("2. 三段式形状（上游硬要求）");
{
  const blocks = z.buildOfficialSystemBlocks("You are a helpful assistant.", {
    model: "GLM-5.3-Flash",
    provider: "bigmodel-api",
    hasSkillTool: false,
    envInfo: { cwd: "D:\\projects\\AgentHub", isGitRepo: true, platform: "win32", osVersion: "10.0.26200" },
  });
  ok("恰好 3 块", blocks.length === 3, String(blocks.length));
  ok("每块 type=text", blocks.every((b) => b.type === "text"));
  ok("每块都有 cache_control.ephemeral", blocks.every((b) => b.cache_control && b.cache_control.type === "ephemeral"));
  ok("[0] === cliPrefix 逐字节", blocks[0].text === P.cliPrefix, blocks[0].text);
  ok("[1] === stableSections.join 逐字节", blocks[1].text === P.stableSections.join("\n\n"));
  ok("[2] 以 \\n\\n 开头（官方形状）", blocks[2].text.startsWith("\n\n"), JSON.stringify(blocks[2].text.slice(0, 6)));
  ok("[2] 含客户端自有 system", blocks[2].text.includes("You are a helpful assistant."));
  ok("[2] 含 powered-by 且已替换 provider/model", blocks[2].text.includes("bigmodel-api") && blocks[2].text.includes("GLM-5.3-Flash"));
  ok("[2] 含环境段 cwd", blocks[2].text.includes("D:\\projects\\AgentHub"));
  ok("无 Skill 工具时不出现 sessionGuidance", !blocks[2].text.includes("# Session-specific guidance"));

  const withSkill = z.buildOfficialSystemBlocks("x", { model: "m", hasSkillTool: true });
  ok("有 Skill 工具时出现 sessionGuidance", withSkill[2].text.includes("# Session-specific guidance"));
}

// ===== 3. 幂等与边界 =====
console.log("3. 幂等与边界");
{
  const own = "You are a helpful assistant.";
  const once = z.injectOfficialSystemBlocks(own, { model: "m" });
  ok("isOfficialSystemBlocks 识别为已包装", z.isOfficialSystemBlocks(once));
  ok("重复包装不叠加", z.injectOfficialSystemBlocks(once, { model: "m" }) === once);

  // 客户端系统提示是 block 数组时要合并进第三块
  const arr = [{ type: "text", text: "AAA" }, { type: "text", text: "BBB" }];
  const fromArr = z.buildOfficialSystemBlocks(arr, { model: "m" });
  ok("数组 system 被合并进第三块", fromArr[2].text.includes("AAA") && fromArr[2].text.includes("BBB"));
  ok("数组 system 仍只 3 块", fromArr.length === 3);

  const empty = z.buildOfficialSystemBlocks("", { model: "m" });
  ok("空 system 也能构造 3 块", empty.length === 3);
  ok("空 system 时第三块仍非空", empty[2].text.length > 100);

  const nullSys = z.buildOfficialSystemBlocks(null, { model: "m" });
  ok("null system 不抛错", nullSys.length === 3);

  // 严禁出现第 4 块（实测会 3012）
  const all = [once, fromArr, empty, nullSys];
  ok("任何情况都不产生第 4 块", all.every((b) => b.length === 3));
}

// ===== 4. 环境段 =====
console.log("4. 环境段");
{
  const e = z.buildEnvironmentSection({ cwd: "D:\\x", isGitRepo: false, platform: "win32", osVersion: "10.0" });
  ok("含工作目录", /working directory/i.test(e) && e.includes("D:\\x"), e);
  ok("isGitRepo=false 写 false", /git repository: false/i.test(e), e);
  ok("含 Platform", /Platform:/i.test(e) && e.includes("win32"));
  const e2 = z.buildEnvironmentSection({});
  ok("空输入不抛错", typeof e2 === "string");
}

// ===== 5. 1005 分类（额度未生效必须报 402，不能静默成功）=====
console.log("5. 1005 / planLimit 语义");
{
  const zcA = require("../electron/backend/proxy/zcodeAnthropic.cjs");
  const br = zcA.createSseBridge(() => {});
  // 上游在额度未生效时返回的就是这种 error 事件
  br.onEvent("error", JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "exceed quota limit", code: 1005 } }));
  ok("1005 记为 planLimit", br.result.planLimit === true);
  ok("1005 记录原始 msg", br.result.planLimitMsg === "exceed quota limit", br.result.planLimitMsg);
  ok("1005 记为 sawError", br.result.sawError === true);

  const br2 = zcA.createSseBridge(() => {});
  br2.onEvent("error", JSON.stringify({ type: "error", error: { message: "insufficient balance", code: 1113 } }));
  ok("1113 欠费也归 planLimit", br2.result.planLimit === true);

  const br3 = zcA.createSseBridge(() => {});
  br3.onEvent("error", JSON.stringify({ type: "error", error: { message: "request has been blocked due to unusual activity", code: 3012 } }));
  ok("3012 不算 planLimit（不罚额度）", br3.result.planLimit === false);
}

// ===== 6. 源码契约 =====
console.log("6. 源码契约");
{
  const ad = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
  ok("start-plan 走 injectOfficialSystemBlocks", /injectOfficialSystemBlocks\(payload\.system/.test(ad));
  ok("不再用旧的前缀注入（start-plan）", !/if \(plan === "start-plan"\) payload\.system = zcodeOfficialSystem\.injectOfficialZcodeSystem/.test(ad));
  ok("传了 model 给三段式", /injectOfficialSystemBlocks\(payload\.system,\s*\{[\s\S]{0,300}model: upstreamModel/.test(ad));
  ok("planLimit 不再静默放行", /if \(result\.planLimit && !zcProduced\)/.test(ad));
  // HTTP 200 + JSON 业务错（额度未生效就是这样）必须先于 SSE 泵被判出来
  ok("先探 content-type 再交给 SSE 泵", /!\/event-stream\/i\.test\(zcCtype\)/.test(ad));
  ok("HTTP200 的 JSON 走 zcodeMapBizError", /zcodeMapBizError\(200, zcData, zcRaw\)/.test(ad));

  // ---- 2026-11-07 实测的 1214 修复（缺 x-session-id / device-mid / 版本错配）----
  ok("x-session-id 两种 plan 都发", /h\["x-session-id"\] = sid;/.test(ad));
  ok("会话 ID 统一走 zcodeSessionId()", /function zcodeSessionId\(convId\)/.test(ad) && /const zcSid = zcodeSessionId\(convId\)/.test(ad));
  ok("头与 body 共用同一个 zcSid", /zcodeLlmHeaders\(c, account, secrets, plan, zcSid\)/.test(ad) && /session_id: zcSid/.test(ad));
  ok("LLM 面带 X-Device-Mid", /h\["X-Device-Mid"\] = String\(devMid\)/.test(ad));
  ok("X-Release-Channel 是 production（官方值）", /"X-Release-Channel": "production"/.test(ad));
  ok("不再残留旧的 stable 渠道值", !/"X-Release-Channel": "stable"/.test(ad));
}

// ===== 7. zcodeSessionId 兜底规则（1214 的直接防线）=====
console.log("7. zcodeSessionId 长度兜底");
{
  // 通过源码契约 + 行为契约双验：该函数不导出，故用适配器行为间接验证规则常量
  const ad = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "adapters.cjs"), "utf8");
  ok("剥 sess_ 前缀", /\^\\(sess_\|subagent_agent_\\)/.test(ad) || /replace\(\/\^\(sess_\|subagent_agent_\)\//.test(ad));
  ok("长度 6-64 校验存在", /length >= 6 && s\.length <= 64/.test(ad));
  ok("不合规时回落 uuid", /return util\.uuid\(\);/.test(ad));

  // appVersion 必须与提示词版本一致（版本 × 模板一致性校验）
  const rj = fs.readFileSync(path.join(__dirname, "..", "electron", "backend", "proxy", "rules.cjs"), "utf8");
  ok("rules 里 zcode.appVersion 是 3.17.2", /appVersion: "3\.17\.2"/.test(rj));
  ok("rules 里不再有 4.1.10", !/appVersion: "4\.1\.10"/.test(rj));
  ok("appVersion 与 PROMPT_VERSION 同版本", /appVersion: "3\.17\.2"/.test(rj) && z.PROMPT_VERSION === "3.17.2");
}

console.log("");
if (failures.length) {
  console.log("失败项：\n - " + failures.join("\n - "));
  console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
  process.exit(1);
}
console.log(`结果：${pass} 通过 / 0 失败`);
console.log("ZCODE START-PLAN SELFTEST OK（三段式 system / 1005 分类 / 幂等）");
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
