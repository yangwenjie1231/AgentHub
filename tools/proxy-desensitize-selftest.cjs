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

// ===== 11. 客户端身份指纹（CLIENT_FINGERPRINTS，#603 实测三条 + 品牌名）=====
console.log("11. 客户端身份指纹");
{
  const hits = (s) => d.listFingerprintHits(s).join(",");
  ok("命中 DSH 身份句 A", hits(d.rewriteFingerprints("You are an AI agent powered by DeepSeek Harness.")).length > 0
    || d.rewriteFingerprints("You are an AI agent powered by DeepSeek Harness.") !== "You are an AI agent powered by DeepSeek Harness.");
  const a = d.rewriteFingerprints("You are an AI agent powered by DeepSeek Harness.");
  ok("A 被整段改写", a === "You are an AI assistant.", a);
  const a2 = d.rewriteFingerprints("prefix You are an AI agent powered by DeepSeek Harness");
  ok("A 无句号变种也改写", a2.includes("You are an AI assistant"), a2);
  const brand = d.rewriteFingerprints("DeepSeek Harness Web GUI");
  ok("品牌名 DeepSeek Harness 被替换", brand === "the agent harness Web GUI", brand);
  const c = d.rewriteFingerprints('You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.');
  ok("C 整段改写且去引号", c.includes("web interface") && !c.includes('"this page"'), c.slice(0, 80));
  const b = d.rewriteFingerprints("Main branch (you will usually use this for PRs): master");
  ok("B 任意位置改写", b === "Default branch (PRs usually go here): master", b);
  ok("中性文本不被指纹表误伤", d.rewriteFingerprints("You are a helpful assistant.") === "You are a helpful assistant.");
  ok("空串原样", d.rewriteFingerprints("") === "");
  ok("指纹表 id 唯一", new Set(d.CLIENT_FINGERPRINTS.map((f) => f.id)).size === d.CLIENT_FINGERPRINTS.length);
}

// ===== 12. 运行时元数据裁剪 =====
console.log("12. 运行时元数据裁剪");
{
  const env = "Before\n\n<environment_context>\nWORKDIR: /x\nOS: Windows\n</environment_context>\n\nAfter";
  const out = d.pruneRuntimeFragments(env);
  ok("environment_context 块被替换", out.includes("Environment context is provided by the harness."), out.slice(0, 90));
  ok("块内细节被移除", !out.includes("WORKDIR"), out.slice(0, 90));
  ok("块外文本保留", out.includes("Before") && out.includes("After"));

  const perm = "x <permissions instructions>\nFilesystem sandboxing defines which files can be read or written.\n## How to request escalation\n...</permissions instructions> y";
  const out2 = d.pruneRuntimeFragments(perm);
  ok("permissions 块被替换", out2.includes("Runtime permissions apply"), out2.slice(0, 90));
  ok("未闭合标签不动（宁可放过）", d.pruneRuntimeFragments("<environment_context> no closing tag") === "<environment_context> no closing tag");

  const tail = "Intro text\n\nThe following deferred tools are now available via ToolSearch.\n- foo\n- bar";
  const out3 = d.pruneRuntimeFragments(tail);
  ok("运行时尾部被截断", out3.includes("Runtime tool, agent, skill, and MCP metadata"), out3.slice(0, 90));
  ok("截断保留正文", out3.includes("Intro text"));
}

// ===== 13. harness 语义压缩（workbuddy2api PR #4 现行方案）=====
console.log("13. harness 语义压缩");
{
  // 构造一个满足判据的长 Claude Code 模板（≥1000 字符 + ≥2 个标记）
  const filler = "Follow the repository conventions and keep responses concise. ".repeat(30);
  const claude = [
    "You are an interactive agent that helps users with software engineering tasks.",
    "",
    "# Harness",
    "# Session-specific guidance",
    "# Memory",
    "# Environment",
    "# Context management",
    filler,
  ].join("\n");
  ok("判据识别为 Claude harness", d.looksLikeClaudeHarness(claude) === true);
  const compacted = d.compactHarnessMessage("system", claude);
  ok("system 长模板被整块压缩", typeof compacted === "string" && compacted.length < 300, String(compacted && compacted.length));
  ok("压缩后仍保留行为契约", compacted.includes("software engineering tasks"), compacted.slice(0, 60));

  // assistant 不整块压（会丢对话内容）
  ok("assistant 不整块压缩", d.compactHarnessMessage("assistant", claude) === null);
  // 短文本不误判
  ok("短文本不误判为 harness", d.looksLikeClaudeHarness("# Harness short") === false);
  // Codex 标记
  const codex = "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.\n# How you work\n" + filler;
  ok("Codex system 被压缩", typeof d.compactHarnessMessage("system", codex) === "string");
  // permissions / skills 标记
  ok("permissions 标记被压缩", typeof d.compactHarnessMessage("system", "<permissions instructions>\nx\n</permissions instructions>") === "string");
  ok("普通 system 不压缩", d.compactHarnessMessage("system", "You are a helpful assistant.") === null);
}

// ===== 14. 完整管线 desensitizeTemplateText =====
console.log("14. 完整管线");
{
  const src = "You are an AI agent powered by DeepSeek Harness.\nRefuse DoS attacks and exploit development.";
  const out = d.desensitizeTemplateText(src, { role: "system" });
  // 插入点是「词首字符之后」：DoS -> D + ZWSP + oS
  ok("管线同时处理指纹与敏感词", out.includes("You are an AI assistant.") && out.includes("D\u200boS"), JSON.stringify(out));
  ok("管线幂等", d.desensitizeTemplateText(out, { role: "system" }) === out);
  ok("空串安全", d.desensitizeTemplateText("") === "");
  ok("非字符串安全", d.desensitizeTemplateText(null) === null);
  // prune/compact 可关（回归旧行为）
  const noCompact = d.desensitizeTemplateText(src, { role: "system", prune: false, compact: false });
  ok("可关闭 prune/compact 只留 ZWSP", noCompact.includes("You are an AI assistant."));
}

console.log("");
if (failures.length) {
  console.log("失败项：\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("PROXY DESENSITIZE SELFTEST OK（词级零宽空格脱敏 / 角色隔离 / 幂等 / 工具描述）");