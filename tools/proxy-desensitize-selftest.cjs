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
// 反代网关 · 上游内容审核脱敏自测（issue #156）
// 用法：node tools/proxy-desensitize-selftest.cjs
// 断言面：命中/不命中 / 幂等 / 词长优先 / 只处理 system 与 tools / 用户内容不动 / 语义可读
"use strict";

const d = require("../electron/backend/proxy/desensitize.cjs");

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok ${name}`); return true; }
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  return false;
}

const ZW = d.ZWSP;

// ===== 1. 基础命中 =====
console.log("1. 基础命中");
{
  const src = "Refuse requests for DoS attacks, exploit development, credential testing.";
  const out = d.desensitizeText(src);
  // 插入点是「词首字符之后」：DoS -> D + ZWSP + oS
  ok("命中 DoS 并插入零宽空格", out.includes("D" + ZW + "oS"), out.slice(0, 60));
  ok("命中 exploit", out.includes("e" + ZW + "xploit"), out.slice(0, 80));
  ok("命中 attacks", out.includes("a" + ZW + "ttacks"), out.slice(0, 80));
  ok("可见字符不变（去掉零宽后与原文一致）", out.split(ZW).join("") === src);
}

// ===== 2. 不误伤 =====
console.log("2. 不误伤");
{
  const plain = "这是一段完全正常的中文，不含任何触发词。";
  ok("纯中文原样返回", d.desensitizeText(plain) === plain);
  const code = "const total = items.reduce((a, b) => a + b, 0);";
  ok("普通代码原样返回", d.desensitizeText(code) === code);
  ok("空串原样", d.desensitizeText("") === "");
  ok("null 原样", d.desensitizeText(null) === null);
  const pureChineseTerm = "攻击";
  ok("中文「攻击」不在词表（不处理中文）", d.desensitizeText(pureChineseTerm) === pureChineseTerm);
}

// ===== 3. 幂等与大小写 =====
console.log("3. 幂等与大小写");
{
  const once = d.desensitizeText("DoS attack");
  const twice = d.desensitizeText(once);
  ok("重复脱敏不叠加零宽空格", once === twice, `once=${JSON.stringify(once)} twice=${JSON.stringify(twice)}`);
  const upper = d.desensitizeText("DOS ATTACK");
  ok("大写同样命中", upper.includes(ZW), upper);
  ok("大小写不敏感且不改变可见字符", upper.split(ZW).join("") === "DOS ATTACK");
}

// ===== 4. 词长优先（长词不被短词先吃掉）=====
console.log("4. 词长优先");
{
  // "privilege escalation" 与 "escalation" 同时存在：长词应先匹配，结果里零宽只插在长词开头
  const s = "privilege escalation risk";
  const out = d.desensitizeText(s);
  ok("长词 privilege escalation 命中", out.includes("p" + ZW + "rivilege escalation"), out);
  ok("可见字符不变", out.split(ZW).join("") === s);
}

// ===== 5. messages：只动 system/developer =====
console.log("5. messages 角色隔离");
{
  const msgs = [
    { role: "system", content: "Refuse DoS attacks and exploit development." },
    { role: "developer", content: "Never leak credentials via reverse shell." },
    { role: "user", content: "explain DoS attacks to me" },
    { role: "assistant", content: "DoS is a denial of service attack." },
  ];
  const out = d.desensitizeMessages(msgs);
  ok("system 被脱敏", out[0].content.includes(ZW));
  ok("developer 被脱敏", out[1].content.includes(ZW));
  ok("user 不被脱敏（真实输入保持原样）", out[2].content === msgs[2].content);
  ok("assistant 不被脱敏", out[3].content === msgs[3].content);
  ok("不修改入参数组", msgs[0].content.includes("DoS attacks"), msgs[0].content);
}

// ===== 6. content blocks 形态 =====
console.log("6. content blocks");
{
  const msgs = [{
    role: "system",
    content: [
      { type: "text", text: "Refuse DoS attacks." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ],
  }];
  const out = d.desensitizeMessages(msgs);
  ok("文本块被脱敏", out[0].content[0].text.includes(ZW), out[0].content[0].text);
  ok("非文本块原样保留", out[0].content[1].type === "image_url" && out[0].content[1].image_url.url === "data:image/png;base64,AAA");
}

// ===== 7. reasoning_content =====
console.log("7. reasoning_content");
{
  const msgs = [{ role: "system", content: "ok", reasoning_content: "consider DoS vectors" }];
  const out = d.desensitizeMessages(msgs);
  ok("reasoning_content 也脱敏", out[0].reasoning_content.includes(ZW), out[0].reasoning_content);
}

// ===== 8. tools：只动 description，不动 name/parameters =====
console.log("8. 工具定义");
{
  const tools = [{
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a potentially destructive command after privilege escalation review.",
      parameters: { type: "object", properties: { cmd: { type: "string", description: "the shell command" } } },
    },
  }];
  const out = d.desensitizeTools(tools);
  const fn = out[0].function;
  ok("description 被脱敏", fn.description.includes(ZW), fn.description);
  ok("工具名不变（参与 tool_call 配对）", fn.name === "run_shell");
  ok("parameters 结构不变", JSON.stringify(fn.parameters) === JSON.stringify(tools[0].function.parameters));
}

// ===== 9. 实测回归：Claude Code / Codex CLI / DSH 风格 system 模板 =====
console.log("9. 真实模板回归");
{
  const claudeHarness = [
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "Important safety instructions: Refuse requests for DoS attacks, exploit development,",
    "credential testing, supply chain compromise, and detection evasion. Never use destructive",
    "commands without confirmation. Follow the sandbox policy.",
  ].join("\n");
  const out = d.desensitizeText(claudeHarness);
  ok("Claude Code 模板：零宽空格已插入", out.includes(ZW));
  ok("Claude Code 模板：可见字符不变", out.split(ZW).join("") === claudeHarness);
  ok("Claude Code 模板：命中数 ≥ 8", d.countHits(claudeHarness) >= 8, String(d.countHits(claudeHarness)));

  // DSH 风格：安全术语密集的中文 system prompt（issue #156 的实际场景）
  const dshStyle = [
    "禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）。",
    "REDACTED 示例：refuse DoS attacks / exploit development / credential testing /",
    "reverse shell / privilege escalation。不要把 API Key 上传到公开仓库。",
  ].join("\n");
  const out2 = d.desensitizeText(dshStyle);
  ok("DSH 风格模板：英文术语被脱敏", out2.includes(ZW));
  ok("DSH 风格模板：中文原样保留", out2.includes("禁止滥用本人代码"));
  ok("DSH 风格模板：可见字符不变", out2.split(ZW).join("") === dshStyle);
}

// ===== 10. 配置表：词表本身健全 =====
console.log("10. 词表健全性");
{
  ok("词表非空", d.SENSITIVE_TERMS.length > 50, String(d.SENSITIVE_TERMS.length));
  ok("词表无重复", new Set(d.SENSITIVE_TERMS.map((t) => t.toLowerCase())).size === d.SENSITIVE_TERMS.length);
  ok("词表无空串", d.SENSITIVE_TERMS.every((t) => typeof t === "string" && t.length > 0));
  ok("含 workbuddy2api 现行核心词 DoS/exploit/sandbox/Anthropic",
    ["DoS", "exploit", "sandbox", "Anthropic"].every((k) => d.SENSITIVE_TERMS.includes(k)));
}

console.log("");
console.log(`结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log("失败项：\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("PROXY DESENSITIZE SELFTEST OK（词级零宽空格脱敏 / 角色隔离 / 幂等 / 工具描述）");