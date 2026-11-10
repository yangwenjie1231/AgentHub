// 临时排障（不提交）：取证 3 个号被拦那一刻的完整 attempts 明细
"use strict";
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const local = (ms) => (ms ? new Date(Number(ms)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "-");

const dayStart = new Date("2026-11-10T00:00:00+08:00").getTime();

console.log("===== 含 account_blocked 的 attempts 明细（全部） =====");
const rows = db.prepare("select ts,channel,target,detail from op_logs where ts>=? and detail like '%account_blocked%' order by id").all(dayStart);
console.log(`共 ${rows.length} 条\n`);
for (const r of rows) console.log(`${local(r.ts)}\t${r.channel}\t${r.target}\n   ${r.detail}\n`);

console.log("===== 这 3 个号在 11-08~11-10 的最后成功与失败 =====");
for (const name of ["yangwenjie1231@gmail.com", "izhuangfangyi", "dafdasfwqdas", "yangwenjie1231"]) {
  const lastOk = db.prepare("select ts,status from usage_requests where channel='workbuddy_ai' and account_name=? and status=200 order by ts desc limit 1").get(name);
  const lastAny = db.prepare("select ts,status,substr(error,1,120) e from usage_requests where channel='workbuddy_ai' and account_name=? order by ts desc limit 1").get(name);
  console.log(`${name}`);
  console.log(`   最后成功: ${local(lastOk && lastOk.ts)}`);
  console.log(`   最后记录: ${local(lastAny && lastAny.ts)} HTTP ${lastAny && lastAny.status} ${(lastAny && lastAny.e) || ""}`);
}

console.log("\n===== 11-10 那天 workbuddy_ai 是否发过请求（upstreamTries） =====");
const conv = db.prepare("select count(*) n from op_logs where ts>=? and detail like '%workbuddy_ai/%'").get(dayStart);
console.log(`含 workbuddy_ai/<账号> 尝试记录的日志条数: ${conv.n}`);