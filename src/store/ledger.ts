import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  BASE_PRICES,
  FUELS,
  type Draft,
  type FuelName,
  type HandoverLog,
  type LedgerState,
  type LogType,
  type PriceBatch,
} from "../types";

const STORAGE_KEY = "dfwlfront-9-handover-ledger-v1";
const SCHEMA_VERSION = 1;

export function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 初始示例：92# 已挂出未结 + 后到的同油品确认项排队；95# 上次交接失败待重试 */
function seed(): LedgerState {
  const t = nowIso();
  const batches: PriceBatch[] = [
    {
      id: "seed-b1",
      fuel: "92号汽油",
      newPrice: 7.62,
      frozenPrice: 7.45,
      operator: "甲班·王磊",
      submittedAt: t,
      effectiveDate: "2026-10-02",
      status: "pending",
      needsConfirmation: false,
      attempts: 0,
      note: "早班调价批次",
    },
    {
      id: "seed-b2",
      fuel: "92号汽油",
      newPrice: 7.58,
      frozenPrice: 7.45,
      operator: "乙班·李娜",
      submittedAt: t,
      effectiveDate: "2026-10-03",
      status: "pending",
      needsConfirmation: true,
      predecessorId: "seed-b1",
      attempts: 0,
      note: "交接班后晚到，转接班员确认项",
    },
    {
      id: "seed-b3",
      fuel: "95号汽油",
      newPrice: 8.12,
      frozenPrice: 7.95,
      operator: "甲班·王磊",
      submittedAt: t,
      effectiveDate: "2026-10-02",
      status: "failed",
      needsConfirmation: false,
      attempts: 1,
      lastError: "接班员网络中断，交接未应答",
      note: "等待重开页面后重试",
    },
  ];
  const logs: HandoverLog[] = [
    { id: uid("log"), batchId: "seed-b1", fuel: "92号汽油", type: "submit", from: "甲班·王磊", detail: "批次送出，冻结现行价 7.45 元/升", at: t },
    { id: uid("log"), batchId: "seed-b2", fuel: "92号汽油", type: "queue", from: "乙班·李娜", detail: "同油品先到批次未结，挂牌价不覆盖，转接班员确认项排队", at: t },
    { id: uid("log"), batchId: "seed-b3", fuel: "95号汽油", type: "confirm-fail", from: "甲班·王磊", detail: "接班员网络中断，交接未应答", at: t },
  ];
  return {
    version: SCHEMA_VERSION,
    batches,
    logs,
    successor: "丙班·赵强",
    failSimulation: false,
    draft: { fuel: FUELS[0], newPrice: null, operator: "", effectiveDate: todayStr(), note: "" },
  };
}

function load(): { state: LedgerState; restored: boolean } {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { state: seed(), restored: false };
  try {
    const parsed = JSON.parse(raw) as LedgerState;
    if (!Array.isArray(parsed.batches) || parsed.version !== SCHEMA_VERSION) {
      return { state: seed(), restored: false };
    }
    return { state: parsed, restored: true };
  } catch {
    return { state: seed(), restored: false };
  }
}

export const useLedgerStore = defineStore("handover-ledger", () => {
  const initial = load();
  const batches = ref<PriceBatch[]>(initial.state.batches);
  const logs = ref<HandoverLog[]>(initial.state.logs);
  const successor = ref(initial.state.successor);
  const failSimulation = ref(initial.state.failSimulation);
  const draft = ref<Draft>({ ...initial.state.draft });
  /** 本次页面会话是否从本地台账恢复（重开页面场景） */
  const restoredAt = ref<string | null>(initial.restored ? nowIso() : null);

  // ---------- 持久化：可恢复台账 ----------
  function persist() {
    const state: LedgerState = {
      version: SCHEMA_VERSION,
      batches: batches.value,
      logs: logs.value,
      successor: successor.value,
      failSimulation: failSimulation.value,
      draft: draft.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function addLog(type: LogType, detail: string, extra?: Partial<HandoverLog>) {
    logs.value = [
      { id: uid("log"), type, detail, at: nowIso(), ...extra },
      ...logs.value,
    ];
  }

  // ---------- 现行价 ----------
  /**
   * 油品在某日期的现行挂牌价：
   * 已确认生效、且生效日期不晚于该日期的最近批次；没有则回落到基准价。
   */
  function priceAt(fuel: FuelName, date: string): number {
    const effective = batches.value
      .filter((b) => b.fuel === fuel && b.status === "confirmed" && b.effectiveDate <= date)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.confirmedAt!.localeCompare(b.confirmedAt!));
    return effective.length ? effective[effective.length - 1].newPrice : BASE_PRICES[fuel];
  }

  /** 当前现行挂牌价（按今天的日期） */
  const currentPriceMap = computed(() => {
    const today = todayStr();
    return Object.fromEntries(FUELS.map((f) => [f, priceAt(f, today)])) as Record<FuelName, number>;
  });

  // ---------- 批次派生：前档挂牌价 + 班次差额（随生效日期重算） ----------
  /**
   * 已确认批次按（生效日期, 确认时间）排序形成价格链。
   * 某批次的前档挂牌价 = 链上紧邻其前的已确认批次；链条之前取基准价。
   * 未确认批次挂在链条末端参与预览，一旦改日期，差额立即重算。
   */
  const derivedBatches = computed(() => {
    const byFuel = new Map<FuelName, PriceBatch[]>();
    for (const f of FUELS) byFuel.set(f, []);
    for (const b of batches.value) byFuel.get(b.fuel)!.push(b);

    const result = new Map<string, { tierPrice: number; shiftDiff: number; frozenDiff: number }>();
    for (const f of FUELS) {
      const list = byFuel.get(f)!;
      const confirmed = list
        .filter((b) => b.status === "confirmed")
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.confirmedAt!.localeCompare(b.confirmedAt!));
      for (const b of list) {
        let tierPrice = BASE_PRICES[f];
        // 在确认链上找生效日期 <= 本批次日期、且排在本批次之前的最近一档
        let prev: PriceBatch | undefined;
        for (const c of confirmed) {
          if (c.id === b.id) break;
          if (c.effectiveDate <= b.effectiveDate) prev = c;
          else break;
        }
        if (prev) tierPrice = prev.newPrice;
        result.set(b.id, {
          tierPrice,
          shiftDiff: round2(b.newPrice - tierPrice),
          frozenDiff: round2(b.newPrice - b.frozenPrice),
        });
      }
    }
    return result;
  });

  function round2(n: number) {
    return Math.round(n * 100) / 100;
  }

  function derived(id: string) {
    return derivedBatches.value.get(id) ?? { tierPrice: 0, shiftDiff: 0, frozenDiff: 0 };
  }

  // ---------- 未结交接项 ----------
  const openBatches = computed(() =>
    batches.value
      .filter((b) => b.status !== "confirmed")
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)),
  );

  /** 该批次的先到同油品批次是否仍未结（排队中，不能确认生效） */
  function blockedBy(b: PriceBatch): PriceBatch | undefined {
    if (!b.predecessorId) {
      // 无显式前驱时，动态查找同油品仍未结且送出更早的批次
      return batches.value.find(
        (x) => x.fuel === b.fuel && x.id !== b.id && x.status !== "confirmed" && x.submittedAt < b.submittedAt,
      );
    }
    const p = batches.value.find((x) => x.id === b.predecessorId);
    return p && p.status !== "confirmed" ? p : undefined;
  }

  // ---------- 送出批次：冻结当刻价格与经办人 ----------
  function submitBatch(payload: Omit<Draft, "newPrice"> & { newPrice: number }) {
    const fuel = payload.fuel;
    const frozenPrice = priceAt(fuel, todayStr());
    const prior = batches.value
      .filter((x) => x.fuel === fuel && x.status !== "confirmed")
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0];
    const batch: PriceBatch = {
      id: uid("b"),
      fuel,
      newPrice: payload.newPrice,
      frozenPrice,
      operator: payload.operator.trim(),
      submittedAt: nowIso(),
      effectiveDate: payload.effectiveDate,
      status: "pending",
      needsConfirmation: Boolean(prior),
      predecessorId: prior?.id,
      attempts: 0,
      note: payload.note.trim() || undefined,
    };
    batches.value = [batch, ...batches.value];
    if (prior) {
      addLog("queue", `${fuel}已有未结批次（${prior.operator} 先到），后到内容不覆盖挂牌价，转接班员确认项排队`, {
        batchId: batch.id,
        fuel,
        from: batch.operator,
      });
    } else {
      addLog("submit", `${fuel}批次送出，冻结当刻现行价 ${frozenPrice.toFixed(2)} 元/升与经办人 ${batch.operator}`, {
        batchId: batch.id,
        fuel,
        from: batch.operator,
      });
    }
    draft.value = { fuel, newPrice: null, operator: "", effectiveDate: todayStr(), note: "" };
    persist();
  }

  // ---------- 接班确认（可模拟失败） ----------
  function attemptConfirm(b: PriceBatch): { ok: boolean; reason?: string } {
    const blocker = blockedBy(b);
    if (blocker) {
      return { ok: false, reason: `先到批次（${blocker.operator}）尚未交接完成` };
    }
    b.attempts += 1;
    if (failSimulation.value) {
      b.status = "failed";
      b.lastError = "模拟交接失败：接班员未应答";
      addLog("confirm-fail", `${b.fuel}交接失败（第${b.attempts}次）：接班员未应答，批次保留在未完成项`, {
        batchId: b.id,
        fuel: b.fuel,
        from: b.operator,
        to: successor.value,
      });
      persist();
      return { ok: false, reason: b.lastError };
    }
    b.status = "confirmed";
    b.confirmedBy = successor.value;
    b.confirmedAt = nowIso();
    b.lastError = undefined;
    addLog(
      "confirm-success",
      `${b.fuel}由 ${successor.value} 确认生效，挂牌价 ${b.newPrice.toFixed(2)} 元/升（生效日 ${b.effectiveDate}）`,
      { batchId: b.id, fuel: b.fuel, from: b.operator, to: successor.value },
    );
    persist();
    return { ok: true };
  }

  /** 重试全部未完成项：失败的重试、排队解除的也一并确认；按送出先后顺序 */
  function retryAll(): { done: number; failed: number; stillBlocked: number } {
    let done = 0;
    let failed = 0;
    let stillBlocked = 0;
    for (const b of [...openBatches.value]) {
      if (b.status === "confirmed") continue;
      const blocker = blockedBy(b);
      if (blocker) {
        stillBlocked += 1;
        continue;
      }
      addLog("retry", `重试未完成项：${b.fuel}（${b.operator}）第 ${b.attempts + 1} 次交接`, {
        batchId: b.id,
        fuel: b.fuel,
        to: successor.value,
      });
      const res = attemptConfirm(b);
      if (res.ok) done += 1;
      else failed += 1;
    }
    persist();
    return { done, failed, stillBlocked };
  }

  // ---------- 生效日期调整：关联挂牌价与班次差额重算 ----------
  function changeEffectiveDate(b: PriceBatch, date: string) {
    if (b.status === "confirmed" || date === b.effectiveDate || !date) return;
    const old = b.effectiveDate;
    b.effectiveDate = date;
    addLog("date-change", `${b.fuel}生效日期由 ${old} 改为 ${date}，前档挂牌价与班次差额已重算`, {
      batchId: b.id,
      fuel: b.fuel,
    });
    persist();
  }

  function withdraw(b: PriceBatch) {
    batches.value = batches.value.filter((x) => x.id !== b.id);
    addLog("withdraw", `${b.fuel}未结批次（${b.operator}）撤回，挂牌价与差额台账保留记录`, {
      batchId: b.id,
      fuel: b.fuel,
    });
    persist();
  }

  function saveDraft(patch: Partial<Draft>) {
    draft.value = { ...draft.value, ...patch };
    persist();
  }

  function setSuccessor(name: string) {
    successor.value = name;
    persist();
  }

  function setFailSimulation(on: boolean) {
    failSimulation.value = on;
    persist();
  }

  function exportJson(): string {
    persist();
    return JSON.stringify(
      { version: SCHEMA_VERSION, batches: batches.value, logs: logs.value, successor: successor.value, exportedAt: nowIso() },
      null,
      2,
    );
  }

  function importJson(text: string): boolean {
    try {
      const parsed = JSON.parse(text) as LedgerState;
      if (!Array.isArray(parsed.batches) || !Array.isArray(parsed.logs)) return false;
      batches.value = parsed.batches;
      logs.value = parsed.logs;
      successor.value = parsed.successor || successor.value;
      addLog("import", `导入台账：${parsed.batches.length} 个批次、${parsed.logs.length} 条交接记录`);
      persist();
      return true;
    } catch {
      return false;
    }
  }

  function resetDemo() {
    const s = seed();
    batches.value = s.batches;
    logs.value = s.logs;
    successor.value = s.successor;
    failSimulation.value = s.failSimulation;
    draft.value = s.draft;
    restoredAt.value = null;
    persist();
  }

  // 重开页面从本地台账恢复时，记录一条恢复审计日志
  if (initial.restored) {
    addLog(
      "restore",
      `重开页面恢复台账：${batches.value.filter((b) => b.status !== "confirmed").length} 个未完成交接项待处理`,
    );
    persist();
  }

  return {
    // state
    batches,
    logs,
    successor,
    failSimulation,
    draft,
    restoredAt,
    // derived
    currentPriceMap,
    derivedBatches,
    openBatches,
    // actions
    persist,
    priceAt,
    derived,
    blockedBy,
    submitBatch,
    attemptConfirm,
    retryAll,
    changeEffectiveDate,
    withdraw,
    saveDraft,
    setSuccessor,
    setFailSimulation,
    exportJson,
    importJson,
    resetDemo,
  };
});
