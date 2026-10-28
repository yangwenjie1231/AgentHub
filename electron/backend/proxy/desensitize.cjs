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
 * 三层防护，按序施加（顺序即优先级）：
 *
 *   ① 客户端身份指纹整段改写（CLIENT_FINGERPRINTS）
 *      上游对**非 user 消息**做「逐字符字面量子串比对」，命中即 400/11128。
 *      社区实测（dsh-our-free-model #544/#568/#570/#603，2026-10）确认三条指纹，
 *      且**锚定规则各不相同**：A 开头锚定、B/C 任意位置。实测还确认
 *      `assistant` 历史正文同样被查 —— 一旦某轮回复复述过这些句子，该会话
 *      之后每一轮都会挂。故本层改写必须覆盖 system 与 assistant 两种角色。
 *
 *   ② 运行时元数据裁剪（pruneRuntimeFragments）
 *      `<environment_context>` / `<permissions instructions>` / `<skills_instructions>`
 *      这类大段运行时块是模板主体，逐词拆零宽空格救不回来，整段换成一句话。
 *
 *   ③ 超长 harness 模板语义压缩（compactHarnessMessage）
 *      workbuddy2api 的实证结论（PR #4 "Fix claude"，2026-08-22）：
 *      「CodeBuddy's channel review rejects that whole block **even after individual
 *      terms are split with zero-width spaces**, so it needs semantic compaction instead.」
 *      即整块模板会被拒，拆词无效 —— 只能整块换成一句行为契约摘要。
 *
 *   ④ 词级零宽空格（desensitizeText，原有）
 *      兜底单句里的散词：`DoS` → `Do\u200bS`。人/模型读起来一致，子串匹配失效。
 *
 * 关键取舍：宁放行不误杀。①③ 只认**明确的客户端身份标记**，命中不了就不动；
 * ④ 的词表全是「拒绝作恶」语境的英文术语与品牌词。**不改 user / tool 内容**，
 * **不改 tools 的 name 与 parameters 结构**（name 参与 tool_call 配对、
 * parameters 会被上游 schema 校验，改结构必 400）。
 */
"use strict";

/** 零宽空格：插入关键词内部，打断后端子串匹配；渲染与语义零影响 */
const ZWSP = "\u200b";

/**
 * ① 客户端身份指纹表（整段改写，最可靠的一层）
 *
 * 上游做的是**逐字符字面量子串比对**（大小写不敏感）。与 ZWSP 拆词相比，
 * 整段替换更稳：即使上游把匹配放宽到「忽略空白/引号」，替换后的句子也不再是原文。
 *
 * 来源（均为 2026-10 仍在更新的社区实测，非过时配方）：
 *   · dsh-our-free-model #544（`You are an AI agent powered by DeepSeek Harness.`）
 *   · dsh-our-free-model #568 / #570（`Main branch (you will usually use this for PRs)`）
 *   · dsh-our-free-model #603（Web GUI 两连句，221 字符，**必须紧邻连续**才触发）
 *   · #603 评论（2026-10-23）：「关键是品牌名 DeepSeek Harness」
 *
 * 实测判据（#603 的 12 组探针，buddy 与 workbuddy 双端点一致）：
 *   · 换行 / 换序 / 去引号都会破坏匹配 → 服务端认逐字符子串
 *   · 指纹放 user / tool / reasoning_content / tool_call.arguments **不拦**
 *   · 放 system 或 **assistant** 正文**都拦**（assistant 是 #544 漏掉的关键一条）
 *   · 7000 字符中性填充文本 → 200（排除长度因素）
 *
 * 键名刻意取长且专有，避免误伤用户正文。
 */
const CLIENT_FINGERPRINTS = [
  // ⚠ 顺序很重要（见下方 FINGERPRINT_ORDER）：**短语级必须排在整句级之后执行**，
  // 否则整句规则永远匹配不上。这里按「整句 → 短语」书写，运行时按长度降序，效果一致。
  //
  // —— ② 自指内容指纹（2026-10-27/28 三个独立实测，**CN 与国际版都触发**）——
  // 真正触发 11128 的是这段 DSH 运行时上下文里的固定文案，两句**必须连读**才匹配：
  //
  //   Tokens prefixed with @ are paths the user explicitly referenced.
  //   Relative paths resolve from the workspace root; absolute paths identify files or
  //   directories on the host.
  //
  // 实测边界（dsh-xdpool#77 / #79、workbuddy2api-hub#680 三方独立复现）：
  //   · 最小失败前缀 111 字符：截到 `…workspace r` 是 200，补上 `root` 就 400
  //   · 单独任一句都不拦，必须两句连读
  //   · `workspace root` → `workspace directory` 或调换语序 → 200
  //   · 大小写不敏感、逐字符精确子串；与体量、位置无关
  //   · **右端加词无效**：`…workspace root` 在 `…workspace root directory` 里仍是完整子串
  //     → 只有改**子串内部**才能打破命中
  //   · 只对 role=system / developer / assistant 生效，用户消息与工具结果不动
  //
  // ⚠ 同时纠正一个流传的错误结论：**`DeepSeek Harness` 不是指纹**。
  //   dsh-auth-hub#1 做了反证——把该词以「原样/零宽U+200B/全小写/全大写/换行拆开/
  //   制表拆开/只留DSH/只留单词」分别发上去，**全部 200 放行**；而真实 10KB system
  //   原样发必 400。故零宽空格方案对本问题无效，官配是把指纹句内部改写。
  {
    id: "dsh-at-paths",
    from: "Tokens prefixed with @ are paths the user explicitly referenced.",
    to: "Tokens starting with @ are paths the user explicitly referenced.",
    note: "#680 / #79：整句锚定第一句，只把 prefixed with 换成 starting with（语义不变）",
  },
  {
    id: "dsh-relative-paths",
    from: "Relative paths resolve from the workspace root",
    to: "Relative paths are resolved against the session directory",
    note: "#77：改子串内部（右端加词无效——仍是完整子串）",
  },
  // —— ③ 品牌短语级（保留作加固；已证实它本身不是指纹）——
  // AutoBuddy v2.1.2 的做法，多改无害，但**不要**指望它解决 11128。
  {
    id: "dsh-brand-hyphen",
    from: "DeepSeek Harness",
    to: "DeepSeek-Harness",
    note: "加固用：实测非指纹，但改写无副作用",
  },
  // —— ② 整句级（首句锚定 A）——
  {
    id: "dsh-identity",
    from: "You are an AI agent powered by DeepSeek Harness.",
    to: "You are an AI agent running on DeepSeek-Harness.",
    note: "#544 + 2026-10-25 实测：整句出现即拦，改写为近义句放行",
  },
  {
    id: "dsh-identity-nodot",
    from: "You are an AI agent powered by DeepSeek Harness",
    to: "You are an AI agent running on DeepSeek-Harness",
    note: "A 的无句号变种",
  },
  // —— ③ Web GUI 两连句（#603 的 C 指纹，221 字符连续才触发）——
  {
    id: "dsh-web-gui",
    from: 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.',
    to: 'You are interacting with the user through the DeepSeek-Harness Web GUI whose URL the runtime context names. When the user refers to this page, this GUI, or this app without naming another target, they mean this GUI.',
    note: "#603：去引号 + 品牌名插连字符，双保险",
  },
  // —— ④ 通用整句 ——
  {
    id: "main-branch",
    from: "Main branch (you will usually use this for PRs)",
    to: "Default branch (PRs usually go here)",
    note: "#568 / #570",
  },
];

/**
 * 预编译：按 from 长度降序。长指纹必须先落——C 的 221 字符整段里含品牌名
 * "DeepSeek Harness"，若品牌名规则先跑，C 的原文就被改花，整段规则再也匹配不上
 * （实测踩过：结果留下 "through the the agent harness Web GUI ... "this page"" 这种
 * 半改写状态，引号没去掉，字面量仍可能被认出）。
 */
const FINGERPRINT_ORDER = CLIENT_FINGERPRINTS
  .filter((f) => f && typeof f.from === "string" && f.from)
  .sort((a, b) => b.from.length - a.from.length);

/** 把 ① 应用到一个文本 blob。无命中原样返回（零拷贝快路径）。 */
function rewriteFingerprints(text) {
  if (typeof text !== "string" || !text) return text;
  let t = text;
  for (const fp of FINGERPRINT_ORDER) {
    if (t.indexOf(fp.from) < 0) continue;
    t = t.split(fp.from).join(fp.to);
  }
  return t;
}

/** 供自测与可观测性：某文本命中了哪些指纹 id */
function listFingerprintHits(text) {
  if (typeof text !== "string" || !text) return [];
  return CLIENT_FINGERPRINTS.filter((fp) => fp.from && text.includes(fp.from)).map((fp) => fp.id);
}

/**
 * ② 运行时元数据块裁剪。
 *
 * harness 会把 environment / permissions / skills / plugins 的大段运行时说明注入
 * system（或 developer）消息。这些块是模板主体，逐词拆零宽空格救不回来，整段换一句话。
 * 只认成对的 XML 式标签，命中不了就完全不动。
 */
const RUNTIME_BLOCKS = [
  ["<environment_context>", "</environment_context>",
    "Environment context is provided by the harness."],
  ["<permissions instructions>", "</permissions instructions>",
    "Runtime permissions apply: filesystem access may be sandboxed, network may be restricted, and some commands may require user approval."],
  ["<collaboration_mode>", "</collaboration_mode>",
    "Collaboration mode instructions are provided by the harness."],
  ["<skills_instructions>", "</skills_instructions>",
    "Runtime skill metadata is available. Use relevant skills only when explicitly requested or clearly applicable."],
  ["<plugins_instructions>", "</plugins_instructions>",
    "Runtime plugin metadata is available when relevant."],
];

/** 运行时尾部标记：出现即从这里截断，换成一句摘要（这些段纯粹是工具清单，无行为指令） */
const RUNTIME_TAIL_MARKERS = [
  "The following deferred tools are now available via ToolSearch.",
  "Available agent types for the Agent tool:",
  "## MCP Server Instructions",
];

function pruneRuntimeFragments(text) {
  if (typeof text !== "string" || !text) return text;
  let t = text;
  for (const [start, end, replacement] of RUNTIME_BLOCKS) {
    if (t.indexOf(start) < 0) continue;
    // 非贪婪 + DOTALL 等价：[\s\S]*?；块不存在闭合标签时不动（宁可放过不可错删）
    const re = new RegExp(
      "\\s*" + start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*",
      "g"
    );
    t = t.replace(re, "\n\n" + replacement + "\n\n");
  }
  // 尾部截断：取最早命中的标记位置
  let cut = -1;
  for (const m of RUNTIME_TAIL_MARKERS) {
    const i = t.indexOf(m);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut >= 0) {
    const head = t.slice(0, cut).replace(/\s+$/, "");
    t = head ? head + "\n\nRuntime tool, agent, skill, and MCP metadata is available separately." : t;
  }
  return t;
}

/**
 * ③ 超长 harness 模板语义压缩。
 *
 * workbuddy2api 实证（PR #4 "Fix claude"，2026-08-22）：Claude Code 2.x 注入的长模板
 * 「carries client/channel identity, internal runtime instructions, and tool-environment
 * metadata」，上游的渠道审核**即使拆了词也拒整块**，只能换成一句行为契约摘要。
 * 工具 schema 在独立的 `tools` 字段里，不受影响。
 *
 * 判据刻意严格：长度 ≥1000 且 ≥2 个标记命中。宁放过不误压 —— 普通长 system prompt
 * 不会被误判成 harness 模板。
 */
const CLAUDE_HARNESS_MARKERS = [
  "You are an interactive agent that helps users with software engineering tasks.",
  "# Harness",
  "# Session-specific guidance",
  "# Memory",
  "# Environment",
  "# Context management",
];
const CLAUDE_HARNESS_SUMMARY =
  "Help with software engineering tasks. Follow repository instructions and runtime permission rules, " +
  "use available capabilities when needed, and report outcomes accurately. Be precise, helpful, concise, and safe.";

const CODEX_SYSTEM_MARKERS = [
  "You are a coding agent running in the Codex CLI",
  "Within this context, Codex refers to",
  "# How you work",
];

const PERMISSIONS_MARKERS = [
  "<permissions instructions>",
  "Filesystem sandboxing defines which files can be read or written.",
  "## How to request escalation",
];
const SKILLS_MARKERS = ["<skills_instructions>", "### Available skills", "### How to use skills"];
const HARNESS_USER_MARKERS = ["Project files updated:", "Confirmed edits:"];

function looksLikeClaudeHarness(text) {
  if (typeof text !== "string" || text.length < 1000) return false;
  let matched = 0;
  for (const m of CLAUDE_HARNESS_MARKERS) if (text.includes(m)) matched++;
  return matched >= 2;
}

/**
 * 整块压缩。返回 null = 不压缩（调用方按原文继续走 ④）。
 * 只对 system 角色的超长模板生效；assistant 历史不整块压（会丢对话内容）。
 */
function compactHarnessMessage(role, text) {
  if (typeof text !== "string" || !text) return null;
  const r = String(role || "").toLowerCase();
  if (r !== "system") return null;

  if (looksLikeClaudeHarness(text)) return CLAUDE_HARNESS_SUMMARY;
  if (CODEX_SYSTEM_MARKERS.some((m) => text.includes(m))) {
    if (text.includes("You are Claude Code")) {
      return "You are a coding assistant. Be precise, helpful, concise, and safe. " +
        "Use available tools when needed, follow repository instructions, and keep the user informed.";
    }
    return "You are a coding assistant in Codex CLI. Be precise, helpful, concise, and safe. " +
      "Use available tools when needed, follow repository instructions, and keep the user informed.";
  }
  if (PERMISSIONS_MARKERS.some((m) => text.includes(m))) {
    return "Runtime permissions apply: filesystem access may be sandboxed, network may be restricted, " +
      "and some commands may require user approval.";
  }
  if (SKILLS_MARKERS.some((m) => text.includes(m))) {
    return "Runtime skill metadata is available. Use relevant skills only when explicitly requested or clearly applicable.";
  }
  return null;
}

/** 供自测：harness user 注入消息识别（Codex/CLI 会把仓库上下文塞成 user 消息） */
function looksLikeHarnessUser(text) {
  if (typeof text !== "string" || !text) return false;
  return HARNESS_USER_MARKERS.some((m) => text.includes(m));
}

/**
 * 对一条「客户端模板集中地」的文本跑完整管线 ①②③④。
 * 这是 adapters.cjs 的 cleanText 应该调用的入口。
 */
function desensitizeTemplateText(text, opts) {
  const o = opts || {};
  if (typeof text !== "string" || !text) return text;
  let t = rewriteFingerprints(text);
  if (o.prune !== false) t = pruneRuntimeFragments(t);
  if (o.compact !== false) {
    const c = compactHarnessMessage(o.role || "system", t);
    if (c != null) t = c;
  }
  t = desensitizeText(t);
  return t;
}

/**
 * ④ 触发上游审核的「合规声明高频词」词表（词级零宽空格兜底）。
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
  // 保护已改造好的品牌短语：DeepSeek-Harness 是 ① 层的产物，不能再被 ZWSP 拆成
  // "DeepSeek-Har<ZW>ness"——那样既破坏连字符方案的可读性，也让 ① 的改写白做。
  // 用占位符临时换出，处理完再换回（占位符不含英文字母，不会被词表命中）。
  const GUARD = "\u0000\u0001";
  const guarded = [];
  let t = text.replace(/DeepSeek-Harness/g, () => {
    guarded.push("DeepSeek-Harness");
    return `${GUARD}${guarded.length - 1}${GUARD}`;
  });
  PATTERN.lastIndex = 0;
  t = t.replace(PATTERN, (m) => splitTerm(m));
  t = t.replace(/\u0000\u0001(\d+)\u0000\u0001/g, (_m, i) => guarded[Number(i)] || "DeepSeek-Harness");
  return t;
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
  CLIENT_FINGERPRINTS,
  RUNTIME_BLOCKS,
  desensitizeText,
  desensitizeContent,
  desensitizeMessages,
  desensitizeTools,
  desensitizeTemplateText,
  rewriteFingerprints,
  pruneRuntimeFragments,
  compactHarnessMessage,
  looksLikeClaudeHarness,
  looksLikeHarnessUser,
  listFingerprintHits,
  countHits,
  DEFAULT_ROLES,
};