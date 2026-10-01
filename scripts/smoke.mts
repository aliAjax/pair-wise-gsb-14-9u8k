// 轻量冒烟测试：打桩浏览器环境，直接驱动 Pinia store 验证业务逻辑
import { createPinia, setActivePinia } from "pinia";
import assert from "node:assert";

// --- 打桩 ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const { useLedgerStore } = await import("../src/store/ledger.ts");

setActivePinia(createPinia());

// localStorage 为空时首次加载得到种子数据
const s2 = useLedgerStore();
s2.resetDemo();
assert.equal(s2.openBatches.length, 3, "种子应含 3 个未结项 (92#两个 + 失败的95#)");
assert.equal(s2.batches.find((b) => b.id === "seed-b3").status, "failed", "种子含 1 个失败项");

// 场景1：98# 首次送出，冻结基准价 8.82
s2.submitBatch({ fuel: "98号汽油", newPrice: 8.99, operator: "甲班·测试", effectiveDate: "2026-10-10", note: "" });
const b98 = s2.batches.find((b) => b.fuel === "98号汽油");
assert.equal(b98.frozenPrice, 8.82, "送出时冻结当刻现行价(基准)");
assert.equal(b98.operator, "甲班·测试", "送出时冻结经办人");
assert.equal(b98.needsConfirmation, false, "首单不是确认项");

// 场景2：98# 晚到同油品 -> 转接班员确认项，不覆盖
s2.submitBatch({ fuel: "98号汽油", newPrice: 9.1, operator: "乙班·晚到", effectiveDate: "2026-10-11", note: "" });
const b98b = s2.batches.find((b) => b.operator === "乙班·晚到");
assert.equal(b98b.needsConfirmation, true, "后到同油品转确认项");
assert.equal(b98b.predecessorId, b98.id, "挂在先到批次后");
assert.equal(s2.currentPriceMap["98号汽油"], 8.82, "未确认前现行价不被覆盖");
assert.ok(s2.blockedBy(b98b), "后到批次被先到批次阻塞");

// 直接确认后到项应失败
let r = s2.attemptConfirm(b98b);
assert.equal(r.ok, false, "先到未结，后到不能确认");

// 场景3：先到确认生效（接班人来自全局设置）
s2.setSuccessor("丙班·接班人");
r = s2.attemptConfirm(b98);
assert.equal(r.ok, true, "先到批次确认成功");
assert.equal(s2.currentPriceMap["98号汽油"], 8.82, "生效日在未来，今日现行价仍不变");
assert.equal(s2.priceAt("98号汽油", "2026-10-10"), 8.99, "生效日后现行价为 8.99");
assert.equal(s2.priceAt("98号汽油", "2026-10-11"), 8.99, "后到未确认前仍按 8.99");

// 队列解除，后到项可确认
assert.ok(!s2.blockedBy(b98b), "先到生效后阻塞解除");
r = s2.attemptConfirm(b98b);
assert.equal(r.ok, true, "后到确认项确认成功");
assert.equal(s2.priceAt("98号汽油", "2026-10-11"), 9.1, "生效日后现行价 9.10");

// 场景4：班次差额 = 新价 - 前档挂牌价
const d98b = s2.derived(b98b.id);
assert.equal(d98b.tierPrice, 8.99, "前档为先到已确认批次价");
assert.equal(d98b.shiftDiff, 0.11, "班次差额 9.10-8.99=+0.11");
assert.equal(d98b.frozenDiff, 0.28, "冻结差额 9.10-8.82=+0.28 固定不变");

// 场景5：生效日期改动 -> 前档挂牌价/班次差额重算（新建跨档批次）
s2.submitBatch({ fuel: "0号柴油", newPrice: 7.3, operator: "甲班·柴油", effectiveDate: "2026-11-01", note: "" });
const bd1 = s2.batches.find((b) => b.operator === "甲班·柴油");
s2.attemptConfirm(bd1); // 生效 11-01: 7.30
assert.equal(s2.derived(bd1.id).tierPrice, 7.1, "柴油前档=基准 7.10");

s2.submitBatch({ fuel: "0号柴油", newPrice: 7.42, operator: "乙班·柴油", effectiveDate: "2026-12-01", note: "" });
const bd2 = s2.batches.find((b) => b.operator === "乙班·柴油");
assert.equal(s2.derived(bd2.id).tierPrice, 7.3, "12-01 批次前档 7.30，差额 +0.12");
assert.equal(s2.derived(bd2.id).shiftDiff, 0.12);
// 把日期改到 11-01 之前 -> 前档回落基准 7.10，差额变 +0.32
s2.changeEffectiveDate(bd2, "2026-10-15");
assert.equal(s2.derived(bd2.id).tierPrice, 7.1, "改日期后前档重算为基准 7.10");
assert.equal(s2.derived(bd2.id).shiftDiff, 0.32, "班次差额重算 +0.32");
assert.equal(s2.derived(bd2.id).frozenDiff, 0.32, "冻结差额保持冻结口径");

// 场景6：失败模拟 + 重开页面恢复 + 一键重试
// 先让种子里失败的 95# 批次正常交接（它是队列头部，不被阻塞）
const seedB3 = s2.batches.find((b) => b.id === "seed-b3");
r = s2.attemptConfirm(seedB3);
assert.equal(r.ok, true, "种子失败项可直接重试交接");

s2.submitBatch({ fuel: "95号汽油", newPrice: 8.2, operator: "夜班·失败演练", effectiveDate: "2026-10-20", note: "" });
const b95 = s2.batches.find((b) => b.operator === "夜班·失败演练");
s2.setFailSimulation(true); // 先开启故障注入，再交接
r = s2.attemptConfirm(b95);
assert.equal(r.ok, false, "模拟失败");
assert.equal(b95.status, "failed");
assert.equal(b95.attempts, 1);

// 模拟重开页面：直接校验 localStorage 中的台账可恢复
const persisted = JSON.parse(localStorage.getItem("dfwlfront-9-handover-ledger-v1"));
assert.ok(persisted.batches.some((b) => b.id === b95.id && b.status === "failed"), "失败项已持久化，可恢复");
assert.equal(persisted.draft.effectiveDate.length, 10, "草稿同样持久化");

// 关闭模拟故障，一键重试全部未完成项（种子里的 92# 两单 + 失败项都会被处理）
s2.setFailSimulation(false);
const res = s2.retryAll();
assert.equal(res.failed, 0, "重试无失败");
assert.equal(s2.batches.find((b) => b.id === b95.id).status, "confirmed", "失败项重试后生效");
assert.equal(s2.batches.find((b) => b.id === b95.id).attempts, 2, "尝试次数累加为 2");
// 种子 92# 排队的两单也应在重试中顺序生效
assert.equal(s2.batches.find((b) => b.id === "seed-b2").status, "confirmed", "排队项在先到生效后重试成功");
// 10-15 已改日期的柴油 bd2 之前未确认，也会在重试中生效
assert.equal(s2.batches.find((b) => b.id === bd2.id).status, "confirmed", "改日期批次生效，按新日期纳入价格链");

// 场景7：现行价一致性（今天=2026-10-01，10-15 与 11-01 档均未到生效日）
assert.equal(s2.priceAt("0号柴油", "2026-10-14"), 7.1, "生效日前维持基准 7.10");
assert.equal(s2.priceAt("0号柴油", "2026-10-15"), 7.42, "改期批次 10-15 生效 7.42");
assert.equal(s2.priceAt("0号柴油", "2026-11-01"), 7.3, "11-01 档生效 7.30（后档价格不覆盖先档）");
assert.equal(s2.priceAt("0号柴油", "2026-12-31"), 7.3, "无更新档则沿用 7.30");
assert.equal(s2.priceAt("98号汽油", "2026-10-11"), 9.1, "98# 价格链正确 9.10");

// 场景8：导入/导出
const json = s2.exportJson();
const fresh = JSON.parse(json);
assert.equal(fresh.batches.length, s2.batches.length);
assert.ok(s2.importJson(json), "导出 JSON 可重新导入");
assert.ok(!s2.importJson("{not json"), "非法 JSON 被拒绝");

console.log("✅ 全部冒烟断言通过");
