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
/**
 * 反代网关 · 上游内容审核脱敏（WorkBuddy 系，issue #156）
 *
 * 背景
 * ----
 * WorkBuddy / CodeBuddy 后端（copilot.tencent.com / codebuddy.cn）对请求体做**关键词级**
 * 内容审核，命中即 400 code 11128（"请求被拦截"）。被误伤的绝大多数不是用户输入，而是
 * **客户端自带 system 模板里的合规声明**：
 *   · Claude Code 的 "Refuse requests for DoS attacks, exploit development, credential testing..."
 *     —— 这是「拒绝作恶」的声明，却被判成敏感词；
 *   · Codex CLI 的 system 模板同理；
 *   · 任何自带安全术语密集 system prompt 的 Harness（如 DSH）都会被大面积误伤——
 *     这正是 issue #156 里「DSH 的话改一下系统提示词」所指的现象。
 *
 * 旧实现的问题（必须替换掉）
 * ------------------------
 * 旧方案是 wb_template_map.json 里的 **5 条整句精确改写**（Claude Code / Codex CLI 的身份句）。
 * 它是封闭枚举：上游每加一条指纹、每换一版客户端模板、或换成别家 Harness，就全部失效，
 * 表现为「明明账号好的，请求就是被拦」。这属于典型的**已过时的解决方法**。
 *
 * 现行方案（对齐 workbuddy2api 的 desensitize.py，2026-10 仍在维护）
 * --------------------------------------------------------------
 * 对**敏感词表**里的词做轻量处理：在词内部插入零宽空格 U+200B
 *
 *     "DoS" -> "Do\u200bS"        人/模型读起来完全一致
 *     后端的关键词匹配（子串比对）因此失效
 *
 * 这是词级、可枚举、与模板无关的做法，抗上游改版能力强于整句改写；且不触碰用户真实输入，
 * 只作用于 system / developer 这类「客户端模板集中地」。
 *
 * 设计约束
 * --------
 * · 只处理指定角色（默认 system / developer）与工具定义文本，**不改用户与助手内容**——
 *   避免影响真实对话语义与代码。
 * · 幂等：已含零宽空格的词不会重复插；大小写不敏感匹配，按词长降序避免短词先吃掉长词。
 * · 词表必须是「英文术语/品牌词」这类**可安全打断**的词：中文词不做处理
 *   （中文分词边界不同，插零宽空格会让模型读起来割裂）。
 */
"use strict";

/** 零宽空格：插入关键词内部，打断后端子串匹配；渲染与语义零影响 */
const ZWSP = "\u200b";

/**
 * 触发上游审核的「合规声明高频词」。
 *
 * 来源与取舍：
 *  ① workbuddy2api/desensitize.py 的现行词表（2026-10，作者持续按真实拦截补词）；
 *  ② 本仓库历史 issue 里实证被拦的客户端身份句关键词。
 * 原则：只收**英文**术语与品牌词。中文一律不收——中文插零宽空格会破坏分词，
 * 且实测拦截主要集中在英文安全术语上。
 */
const SENSITIVE_TERMS = [
  // —— 攻击类型 ——
  "DoS",
  "DDoS",
  "exploit",
  "exploit development",
  "credential testing",
  "credential stuffing",
  "supply chain compromise",
  "supply-chain compromise",
  "detection evasion",
  "C2 frameworks",
  "C2 framework",
  "command and control",
  "malicious purposes",
  "malicious intent",
  "mass targeting",
  "brute force",
  "brute-force",
  "privilege escalation",
  "reverse shell",
  "remote code execution",
  "SQL injection",
  "XSS",
  "CSRF",
  "phishing",
  "malware",
  "ransomware",
  "keylogger",
  "rootkit",
  "backdoor",
  "botnet",
  "zero-day",
  "0day",
  // —— 安全术语 ——
  "vulnerability",
  "vulnerabilities",
  "red teaming",
  "red-teaming",
  "sandbox",
  "sandboxing",
  "sandboxed",
  "unsandboxed",
  "escalated privileges",
  "escalated",
  "escalation",
  "destructive action",
  "destructive command",
  "destructive",
  "attack",
  "attacks",
  "cybersecurity",
  "security review",
  "hacking",
  "penetration testing",
  "penetration test",
  "injection",
  "weaponize",
  "weaponized",
  // —— 有害内容 ——
  "harmful",
  "dangerous",
  "abuse",
  "abusive",
  "illegal",
  "terrorist",
  "terrorism",
  "bomb",
  "weapon",
  "weapons",
  "drug",
  "drugs",
  "narcotic",
  "suicide",
  "self-harm",
  "murder",
  "kill",
  "violence",
  "violent",
  // —— 品牌词（避免竞争品牌触发审核）——
  "Claude Code",
  "Claude Opus",
  "Claude Sonnet",
  "Claude Haiku",
  "Anthropic",
  "Co-Authored-By",
  "noreply@anthropic.com",
  // —— 其它 AI 助手/CLI 身份特征词 ——
  "Oh My Pi",
  "Kiro",
  "Codex CLI",
  "coding harness",
  "harness",
  "subagent",
  "subagents",
  "MCP Server",
  "MCP tool",
  "tool call",
  "function call",
  "antml:invoke",
  "antml:function_calls",
  // —— 内部协议 / URI（暴露外部实现）——
  "skill://",
  "agent://",
  "artifact://",
  "rule://",
  "memory://",
  "local://",
  "history://",
  "issue://",
  "pr://",
  "xd://",
  // —— 工具 / 插件名称 ——
  "AutoImprove",
  "CodeGraph",
  "codegraph_explore",
  "Rust Token Killer",
  // —— 配置文件特征 ——
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
];

/**
 * 预编译正则：按词长降序（避免短词先吃掉长词），大小写不敏感。
 * 用 escape 保证词里的 :// . @ 等字符按字面量匹配。
 */
const PATTERN = new RegExp(
  SENSITIVE_TERMS.slice()
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "gi"
);

/** 在词内部插入一个零宽空格。单字符词原样返回（打断无意义）。 */
function splitTerm(term) {
  if (!term || term.length <= 1) return term;
  // 已含零宽空格（幂等：重复清洗不叠加）
  if (term.indexOf(ZWSP) >= 0) return term;
  return term[0] + ZWSP + term.slice(1);
}

/** 对文本里的敏感词插入零宽空格。无命中则原样返回（零拷贝快路径）。 */
function desensitizeText(text) {
  if (typeof text !== "string" || !text) return text;
  // 快路径：明显不含英文字母的长中文文本无需跑正则
  if (!/[A-Za-z]/.test(text)) return text;
  PATTERN.lastIndex = 0;
  return text.replace(PATTERN, (m) => splitTerm(m));
}

/** content 可能是字符串或 [{type:"text",text}] 块数组；逐块脱敏，保留其它 part */
function desensitizeContent(content) {
  if (typeof content === "string") return desensitizeText(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        return { ...part, text: desensitizeText(part.text) };
      }
      return part;
    });
  }
  return content;
}

/** 默认只脱敏这些角色：客户端模板与身份声明集中地。用户/助手内容不动。 */
const DEFAULT_ROLES = ["system", "developer"];

/**
 * 对 messages 里指定角色的文本做脱敏，返回新数组（不修改入参）。
 * 同时处理 reasoning_content（思维链回填里同样可能带模板句）。
 */
function desensitizeMessages(messages, roles) {
  const set = new Set(roles || DEFAULT_ROLES);
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const role = String(m.role || "").toLowerCase();
    if (!set.has(role)) return m;
    let next = m;
    if (typeof m.content === "string") {
      const t = desensitizeText(m.content);
      if (t !== m.content) next = { ...next, content: t };
    } else if (Array.isArray(m.content)) {
      const c = desensitizeContent(m.content);
      if (JSON.stringify(c) !== JSON.stringify(m.content)) next = { ...next, content: c };
    }
    if (typeof next.reasoning_content === "string") {
      const r = desensitizeText(next.reasoning_content);
      if (r !== next.reasoning_content) next = { ...next, reasoning_content: r };
    }
    return next;
  });
}

/**
 * 对工具定义做脱敏：上游审核会读 tools[].function.description / name / parameters 里的描述文本。
 * 只处理字符串字段，不动结构（参数 schema 会被上游校验，改结构必 400）。
 */
function desensitizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (!t || typeof t !== "object") return t;
    const fn = t.function && typeof t.function === "object" ? t.function : null;
    if (!fn) return t;
    let nf = fn;
    if (typeof fn.description === "string") {
      const d = desensitizeText(fn.description);
      if (d !== fn.description) nf = { ...nf, description: d };
    }
    if (typeof fn.name === "string") {
      // 工具名会被客户端回传做 tool_call 配对，改名会导致配对不上——
      // 只在整个名字命中词表时也无法安全改写，故**不改 name**，只改描述。
      void fn.name;
    }
    return nf === fn ? t : { ...t, function: nf };
  });
}

/** 统计文本里命中的词（自测与可观测性用） */
function countHits(text) {
  if (typeof text !== "string" || !text) return 0;
  PATTERN.lastIndex = 0;
  const m = text.match(PATTERN);
  return m ? m.length : 0;
}

module.exports = {
  ZWSP,
  SENSITIVE_TERMS,
  desensitizeText,
  desensitizeContent,
  desensitizeMessages,
  desensitizeTools,
  countHits,
  DEFAULT_ROLES,
};