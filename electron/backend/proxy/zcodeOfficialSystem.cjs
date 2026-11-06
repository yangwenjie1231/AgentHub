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
"use strict";
/**
 * ZCode 官方客户端 system 提示词前缀（官方客户端检测，防 405/3012）
 *
 * 背景：zcode 的 start-plan 出线 https://zcode.z.ai/api/v1/zcode-plan/anthropic 对 system
 * 不以官方 ZCode 智能体提示词开头的请求，一律返回 HTTP 405 + code 3012
 * "request has been blocked due to unusual activity"。二分实测：
 *   · 门禁是**真文本前缀匹配**，不是长度启发式——官方块1 + 1300 字纯填充、纯填充 1300 字均被拦；
 *   · 官方正文前 1257 字可过、前 1200 字被拦；本文件的 A 常量（块1+Agent Identity，1253 字）实测可过；
 *   · 与 system 的形状（string / 数组块）、max_tokens、metadata、device_id 及传输层均无关。
 *
 * 前缀来源与优先级：
 *   B（优先）运行时从本机 ZCode 客户端 bundle 提取——按**内容锚点**（不依赖压缩后的变量名）复原
 *     官方客户端自己的拼装规则：块1 = CLI Prefix；块2 开头 = Agent Identity
 *     = [["", 句子, "", 安全声明].join("\n"), "", Harness].join("\n")
 *     客户端升级后自动跟随，仓库无需内嵌厂商文本。
 *   A（兜底）内置常量，B 不可用时（未安装客户端 / bundle 结构变化 / 读取失败）使用。
 *
 * 注意：注入会把官方提示词拼在 system 最前面，下游客户端自己的 system 追加在其后。
 * 代价是每次请求多出约 1253 字符（≈358 token），且模型会先读到官方
 * 「You are ZCode…」人设，回复风格可能略有变化——这是换取该渠道可用的代价。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

// ===== A：内置兜底常量（官方 块1 + Agent Identity，实采自官方客户端 3.14.4 并逐字校验）=====
const FALLBACK_PREFIX = "You are ZCode, an interactive coding agent\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.";

// ===== B：运行时从本机客户端 bundle 提取 =====
const ANCHOR_BLOCK1 = "You are ZCode, an interactive coding agent";
const ANCHOR_SENTENCE = "You are an interactive ZCode agent that helps users";
const ANCHOR_NOTICE = "IMPORTANT: Assist with authorized security testing";
const ANCHOR_HARNESS = "# Harness";
const MIN_VALID_LENGTH = 1240;   // 实测门禁阈值在 1200~1253 之间，低于此值视为提取失败

/** 候选 bundle 路径（按平台给出常见安装位置；ZCODE_BUNDLE_PATH 显式指定时只用它） */
function bundleCandidates() {
  const env = process.env.ZCODE_BUNDLE_PATH;
  if (env) return [env];
  const out = [];
  const push = (p) => { if (p) out.push(p); };
  const la = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env["ProgramFiles(x86)"];
  if (la) push(path.join(la, "Programs", "ZCode", "resources", "glm", "zcode.cjs"));
  if (pf) push(path.join(pf, "ZCode", "resources", "glm", "zcode.cjs"));
  if (pf86) push(path.join(pf86, "ZCode", "resources", "glm", "zcode.cjs"));
  push(path.join(os.homedir(), ".zcode", "cli", "zcode.cjs"));
  return out;
}

/** 从 anchor 处（必须是字面量起始）读一个 JS 字符串字面量并解码 */
function readLiteralAt(s, idx) {
  let i = idx;
  const out = [];
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { out.push(c, s[i + 1]); i += 2; continue; }
    if (c === '"') break;
    if (c === "\n") throw new Error("literal not closed");
    out.push(c); i++;
  }
  return JSON.parse('"' + out.join("") + '"');
}

/** 字符串感知的括号匹配：从 start（'['）取到配对的 ']'（元素里可能含 [label](url) 这类中括号） */
function readArrayAt(s, start) {
  let depth = 0, i = start, inStr = false, q = "";
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) break; }
  }
  return s.slice(start, i + 1);
}

/** 求值纯字符串数组（元素可能混用单/双引号，JSON.parse 会失败） */
function evalStringArray(text) {
  const arr = vm.runInNewContext("(" + text + ")", Object.create(null), { timeout: 2000 });
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) throw new Error("not a string array");
  return arr;
}

/** 从客户端 bundle 文本中按官方拼装规则复原前缀；失败返回 "" */
function extractFromBundle(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  const i1 = text.indexOf(ANCHOR_BLOCK1);
  const i2 = text.indexOf(ANCHOR_SENTENCE);
  const i3 = text.indexOf(ANCHOR_NOTICE);
  const i4 = text.indexOf(ANCHOR_HARNESS);
  if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0) return "";
  const block1 = readLiteralAt(text, i1);
  const sentence = readLiteralAt(text, i2);
  const notice = readLiteralAt(text, i3);
  // Harness 段：离 "# Harness" 最近的数组起点即该数组（元素为各文本行）
  const arrStart = text.lastIndexOf("[", i4);
  if (arrStart < 0) return "";
  const harness = evalStringArray(readArrayAt(text, arrStart)).join("\n");
  // 复刻官方 CJs()：[[ "", 句子, "", 安全声明 ].join("\n"), "", Harness].join("\n")
  const identity = [["", sentence, "", notice].join("\n"), "", harness].join("\n");
  return block1 + identity;
}

const looksValid = (p) => typeof p === "string" && p.startsWith(ANCHOR_BLOCK1) && p.length >= MIN_VALID_LENGTH;

let cache = { file: "", mtimeMs: 0, prefix: "" };
let warned = false;
let lastSource = "unknown";

/** 解析要注入的前缀：B 优先，失败回落 A */
function resolveOfficialSystemPrefix() {
  for (const file of bundleCandidates()) {
    try {
      const st = fs.statSync(file);
      if (cache.prefix && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.prefix;
      const p = extractFromBundle(fs.readFileSync(file, "utf8"));
      if (looksValid(p)) {
        cache = { file, mtimeMs: st.mtimeMs, prefix: p };
        lastSource = "client-bundle:" + file;
        return p;
      }
    } catch (e) { /* 试下一个候选 */ }
  }
  if (!warned) {
    warned = true;
    lastSource = "builtin-fallback";
    try {
      console.warn("[zcode] 未能从本机客户端 bundle 提取官方 system 前缀，回落内置常量（" + FALLBACK_PREFIX.length + " 字）");
    } catch (e) { /* ignore */ }
  }
  return FALLBACK_PREFIX;
}

/** 供诊断：本次前缀来自哪里 */
function officialSystemPrefixSource() {
  return lastSource;
}

/** 让 system 以官方前缀开头：已是官方形式则原样返回；否则前置拼接（数组块同样支持） */
function injectOfficialZcodeSystem(system) {
  const prefix = resolveOfficialSystemPrefix();
  if (!prefix) return system;
  const flatten = (s) => (Array.isArray(s) ? s.map((b) => (b && b.text) || "").join("") : String(s == null ? "" : s));
  if (flatten(system).startsWith(prefix)) return system;
  if (Array.isArray(system)) return [{ type: "text", text: prefix }, ...system];
  return system ? prefix + "\n\n" + system : prefix;
}

/**
 * ===== 3.17.2 三段式构造（2026-11-06 实测，唯一能过 3012 的形状）=====
 *
 * 背景：2026-11-03 起上游风控再收紧。实测三组对照（同机同号同额度）：
 *   A. 旧实现（3.14.4 文本 + 单块前缀拼接）           → 405/3012
 *   B. 3.17.2 文本 + **严格三段式 cache_control 块**   → 200 ✅
 *   C. 3.17.2 文本但**单块**拼接                      → 405/3012
 * 结论：**文本要对（3.17.2）+ 形状要对（三段式）**，缺一不可。
 *   之前「前缀匹配、拼在 system 最前」的做法在 3.17.2 上完全失效。
 *
 * 官方形状（ZCode 3.17.2 ContextBuilder.assembleSystemMessages，实测复现）：
 *   system = [
 *     { type:"text", text: cliPrefix,                    cache_control:{type:"ephemeral"} },
 *     { type:"text", text: stableSections.join("\n\n"),   cache_control:{type:"ephemeral"} },
 *     { type:"text", text: "\n\n" + dynamic.join("\n\n"), cache_control:{type:"ephemeral"} },
 *   ]
 *   · **禁止第 4 块**（实测：第 4 块 → 405/3012，见 oc-auth #343）
 *   · 前两块必须与官方逐字节一致；第三块是动态段，客户端自有 system 拼在最后
 *
 * 来源：player462/opencode-zcode-auth 0.1.52 的 prompt.mjs，
 *   其文本取自 ZCode 3.17.2 源码（a9fe401，apps/zcode-cli/packages/core/src/context/）。
 */
const PROMPT_3172 = require("./zcodeSystemPrompt.json");

/** 三段式要求的 fixed 文本指纹（用于自测：文本被误改会导致线上全挂） */
const PROMPT_VERSION = "3.17.2";

const EPHEMERAL = { type: "ephemeral" };

/** 环境段（第三块的一部分）：工作目录 / 是否 git 仓 / 平台。
 *  形状取自 oc-auth 的 environment()：逗号分行的 Key: Value。 */
function buildEnvironmentSection(info) {
  const e = PROMPT_3172.environment || {};
  const i = info || {};
  const lines = [];
  if (e.heading) lines.push(e.heading);
  if (i.cwd) lines.push(`${e.cwdLabel || "Working directory"}: ${i.cwd}`);
  if (i.isGitRepo != null) lines.push(`${e.gitLabel || "Is git repo"}: ${i.isGitRepo ? (e.gitYes || "yes") : (e.gitNo || "no")}`);
  if (i.platform) lines.push(`${e.platformLabel || "Platform"}: ${i.platform}`);
  if (i.osVersion) lines.push(`${e.osVersionLabel || "OS Version"}: ${i.osVersion}`);
  if (e.untrustedNote) lines.push(e.untrustedNote);
  return lines.join("\n");
}

/**
 * 把「客户端自己的 system」包成官方三段式。
 *
 * @param {string|Array} ownSystem  客户端原本的 system（string 或 text block 数组）
 * @param {object} opts
 * @param {string} opts.model       上游模型名（用于 "powered by" 那句）
 * @param {string} opts.provider    "bigmodel-api" | "zai-api"
 * @param {object} opts.envInfo     buildEnvironmentSection 的输入（cwd/isGitRepo/platform/osVersion）
 * @param {boolean} opts.hasSkillTool 请求里是否有名为 Skill 的工具（决定是否加 sessionGuidance）
 * @returns {Array} 三个 cache_control text block
 */
function buildOfficialSystemBlocks(ownSystem, opts) {
  const o = opts || {};
  const own = [];
  if (typeof o.primary === "string" || typeof ownSystem === "string") {
    const s = typeof ownSystem === "string" ? ownSystem : String(o.primary || "");
    if (s.trim()) own.push(s);
  } else if (Array.isArray(ownSystem)) {
    for (const b of ownSystem) {
      if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) own.push(b.text);
    }
  }

  const provider = o.provider || "bigmodel-api";
  const model = o.model || "";
  const dynamic = [
    PROMPT_3172.dynamicBehavior,
    ...(o.hasSkillTool ? [PROMPT_3172.sessionGuidance] : []),
    buildEnvironmentSection(o.envInfo),
    ...(model ? [String(PROMPT_3172.poweredBy).replace("{provider}", provider).replace("{model}", model)] : []),
    PROMPT_3172.contextManagement,
    ...own,
  ].filter((s) => typeof s === "string" && s.length);

  return [
    { type: "text", text: PROMPT_3172.cliPrefix, cache_control: EPHEMERAL },
    { type: "text", text: PROMPT_3172.stableSections.join("\n\n"), cache_control: EPHEMERAL },
    { type: "text", text: "\n\n" + dynamic.join("\n\n"), cache_control: EPHEMERAL },
  ];
}

/** 三段式是否已是目标形状（防重复包装：system 已是 3 块且首块等于 cliPrefix） */
function isOfficialSystemBlocks(system) {
  if (!Array.isArray(system) || system.length !== 3) return false;
  const first = system[0];
  return !!(first && typeof first.text === "string" && first.text === PROMPT_3172.cliPrefix);
}

/**
 * 官方形状注入（**新的默认入口**）：把客户端 system 包成 3.17.2 三段式。
 * 与旧 injectOfficialZcodeSystem 的区别：这个会**替换**整个 system，不是追加前缀——
 * 因为上游要求严格三段，多一块就 3012。
 */
function injectOfficialSystemBlocks(system, opts) {
  if (isOfficialSystemBlocks(system)) return system;
  return buildOfficialSystemBlocks(system, opts);
}

module.exports = {
  PROMPT_3172,
  PROMPT_VERSION,
  buildOfficialSystemBlocks,
  buildEnvironmentSection,
  isOfficialSystemBlocks,
  injectOfficialSystemBlocks,
  FALLBACK_PREFIX,
  MIN_VALID_LENGTH,
  extractFromBundle,
  resolveOfficialSystemPrefix,
  officialSystemPrefixSource,
  injectOfficialZcodeSystem,
};
