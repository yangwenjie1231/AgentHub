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
// 反代网关 · 积分保底与「免费模型不被连坐」自测（issue #157）
// 用法：AGENTHUB_DATA_DIR=<临时目录> node tools/proxy-credit-floor-selftest.cjs
// 断言面：modelRateOf 倍率判定 / modelConfirmedPaid / isCreditExhausted /
//         保底关停语义 / 免费模型放行语义 / 收费模型拦截语义
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// 沙箱：必须在 require store 之前设置，避免碰真实用户数据
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-creditfloor-"));
process.env.AGENTHUB_DATA_DIR = dir;
process.env.AGENT_SKILLS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ah-skills-"));

const pool = require("../electron/backend/proxy/pool.cjs");

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok ${name}`); return true; }
  failures.push(name + (extra ? ` — ${extra}` : ""));
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  return false;
}

// ===== 1. 倍率判定（catalog.json 的 rate）=====
console.log("1. 倍率判定");
{
  // 内置 catalog 的 workbuddy_ai 默认条目 rate: null（未观测 = 未知，应放行）
  ok("未观测模型倍率为 null", pool.modelRateOf("workbuddy_ai", "deepseek-v4.1-flash") === null,
    String(pool.modelRateOf("workbuddy_ai", "deepseek-v4.1-flash")));
  ok("未知模型倍率为 null", pool.modelRateOf("workbuddy_ai", "no-such-model-xyz") === null);
  ok("空模型名倍率为 null", pool.modelRateOf("workbuddy_ai", "") === null);
  ok("未知渠道倍率为 null", pool.modelRateOf("no-such-channel", "x") === null);
}

// ===== 2. 收费判定（只有明确 > 0 才算收费）=====
console.log("2. 收费判定");
{
  ok("未知倍率不算收费（宁放行，不误锁）", pool.modelConfirmedPaid("workbuddy_ai", "deepseek-v4.1-flash") === false);
  ok("未知模型不算收费", pool.modelConfirmedPaid("workbuddy_ai", "nope") === false);
  ok("空模型不算收费", pool.modelConfirmedPaid("workbuddy_ai", "") === false);
}

// ===== 3. 积分耗尽账号识别 =====
console.log("3. 积分耗尽账号识别");
{
  ok("online 账号不算积分耗尽", pool.isCreditExhausted({ status: "online", credits: 0, creditsAt: 1 }) === false);
  ok("cooling 账号不算积分耗尽", pool.isCreditExhausted({ status: "cooling", credits: 0, creditsAt: 1 }) === false);
  ok("exhausted + 余额原因 → 是", pool.isCreditExhausted({ status: "exhausted", coolReason: "余额不足，已自动切换" }) === true);
  ok("exhausted + 积分原因 → 是", pool.isCreditExhausted({ status: "exhausted", coolReason: "积分耗尽" }) === true);
  ok("exhausted + 余额已到期 → 是", pool.isCreditExhausted({ status: "exhausted", coolReason: "余额已到期，已自动切换" }) === true);
  ok("exhausted + 无原因但观测余额 0 → 是", pool.isCreditExhausted({ status: "exhausted", coolReason: "", credits: 0, creditsAt: 1 }) === true);
  ok("exhausted + 其它原因且未观测 → 否", pool.isCreditExhausted({ status: "exhausted", coolReason: "手动停用", creditsAt: 0 }) === false);
}

// ===== 4. 积分保底阈值 API =====
console.log("4. 保底阈值 API");
{
  ok("默认关闭（0）", pool.getCreditFloor() === 0, String(pool.getCreditFloor()));
  ok("设置 100 生效", pool.setCreditFloor(100) === 100);
  ok("get 读到 100", pool.getCreditFloor() === 100);
  ok("负数/非法回落到关闭", pool.setCreditFloor(-5) === 0 && pool.getCreditFloor() === 0);
  ok("非数字回落到关闭", pool.setCreditFloor("abc") === 0 && pool.getCreditFloor() === 0);
  ok("小数向下取整", pool.setCreditFloor(99.9) === 99);
  pool.setCreditFloor(0); // 复位
}

// ===== 5. 端到端：号码池行为（免费模型放行 / 收费模型拦截）=====
console.log("5. 号码池行为（免费 vs 收费）");
{
  const store = require("../electron/backend/proxy/store.cjs");
  store.open();
  const ch = "workbuddy_ai";
  // 造一个余额为 0 的账号（模拟额度耗尽）
  const accId = "creditfloor-acc-1";
  try { store.removeAccount(id); } catch { /* 不存在 */ }
  const created = store.addAccount({
    channel: ch, uid: "uid-cf1", name: "额度耗尽号",
    token: "tok", refreshToken: "", source: "selftest", expiresAt: 0,
  });
  const id = (created && (created.id || created)) || accId;
  // 余额置 0（模拟额度耗尽）：creditsAt 非 0 表示「已观测到余额」
  store.updateAccount(id, { status: "online", coolUntil: 0, coolReason: "", credits: 0, creditsAt: Date.now() });

  // 5a. 未知/免费倍率 → 该账号仍应被选中（这是 #157 的核心修正）
  const freeAcc = pool.pickAccount(ch, "expire_first", [], 0, "deepseek-v4.1-flash");
  ok("免费/未知模型：余额 0 的号仍可选（不再连坐）", !!freeAcc && freeAcc.id === id,
    freeAcc ? freeAcc.id : "null");

  // 5b. 把该模型标成收费（写进 catalog.json），收费模型应不再选它
  // rules 是文件驱动：沙箱里写一份 catalog.json 再 reload
  const rules = require("../electron/backend/proxy/rules.cjs");
  const rulesPath = path.join(store.proxyDir(), "rules");
  fs.mkdirSync(rulesPath, { recursive: true });
  const cat = JSON.parse(JSON.stringify(rules.get("catalog.json") || {}));
  if (!cat[ch]) cat[ch] = { syncedAt: 0, models: [] };
  cat[ch].models = Array.isArray(cat[ch].models) ? cat[ch].models : [];
  cat[ch].models = cat[ch].models.filter((m) => !["paid-model-x", "free-model-y"].includes(String(m.id || "").toLowerCase()));
  cat[ch].models.push({ id: "paid-model-x", name: "paid-model-x", rate: 3, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
  cat[ch].models.push({ id: "free-model-y", name: "free-model-y", rate: 0, capabilities: {}, contextLength: 0, maxOutputTokens: 0 });
  fs.writeFileSync(path.join(rulesPath, "catalog.json"), JSON.stringify(cat, null, 2), "utf8");
  rules.reload("catalog.json");
  ok("收费模型倍率读到 3", pool.modelRateOf(ch, "paid-model-x") === 3, String(pool.modelRateOf(ch, "paid-model-x")));
  ok("收费模型判定为 confirmed paid", pool.modelConfirmedPaid(ch, "paid-model-x") === true);
  ok("rate=0 的免费模型不算收费", pool.modelConfirmedPaid(ch, "free-model-y") === false);

  // 注意：5a 的 pickAccount 可能已把余额 0 的号标成 exhausted，
  // 这里把它复位成 online 再验收费路径（模拟额度刷新刚拿到 0 余额）
  store.updateAccount(id, { status: "online", coolUntil: 0, coolReason: "", credits: 0, creditsAt: Date.now() });
  const paidAcc = pool.pickAccount(ch, "expire_first", [], 0, "paid-model-x");
  ok("收费模型：余额 0 的号被跳过（不白撞 402）", !paidAcc, paidAcc ? paidAcc.id : "null");

  // 5c. 保底阈值：余额 50 < floor 100 → 收费模型不选；免费模型仍选
  store.updateAccount(id, { status: "online", coolUntil: 0, coolReason: "", credits: 50, creditsAt: Date.now() });
  pool.setCreditFloor(100);
  const floorPaid = pool.pickAccount(ch, "expire_first", [], 0, "paid-model-x");
  ok("保底生效：余额 50 < floor 100 时收费模型不选", !floorPaid, floorPaid ? floorPaid.id : "null");
  const floorFree = pool.pickAccount(ch, "expire_first", [], 0, "deepseek-v4.1-flash");
  ok("保底不影响免费模型：余额 50 仍可选", !!floorFree && floorFree.id === id, floorFree ? floorFree.id : "null");

  // 5d. 关闭保底后，余额 50 的号可以接收费模型（行为回落）
  pool.setCreditFloor(0);
  store.updateAccount(id, { status: "online", coolUntil: 0, coolReason: "", credits: 50, creditsAt: Date.now() });
  const noFloorPaid = pool.pickAccount(ch, "expire_first", [], 0, "paid-model-x");
  ok("关闭保底：余额 50 可接收费模型", !!noFloorPaid && noFloorPaid.id === id, noFloorPaid ? noFloorPaid.id : "null");

  store.removeAccount(id);
  store.close();
}

console.log("");
console.log(`结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log("失败项：\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("PROXY CREDIT-FLOOR SELFTEST OK（免费模型不被连坐 / 收费模型保底 / 阈值边界）");

// 清理沙箱
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }