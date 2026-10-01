import { computed, reactive, watch } from "vue";
import { defineStore } from "pinia";
import type {
  BatchDraft,
  Fuel,
  HandoverRecord,
  HandoverStatus,
  LedgerState,
  PriceBatch,
} from "./types";

const STORAGE_KEY = "dfwlfront-9-ledger-v1";
const PRICE_SCALE = 10000; // 价格保留 4 位小数，避免浮点误差

function roundPrice(value: number): number {
  return Math.round(value * PRICE_SCALE) / PRICE_SCALE;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 现行挂牌价：
 * 同一油品只取最近一条已确认批次；没有已确认批次时取基准价。
 * 后到的同油品批次在接班员确认前不会覆盖现行价。
 */
function currentPriceOf(state: LedgerState, fuelCode: string): number {
  const confirmed = state.batches
    .filter((b) => b.fuelCode === fuelCode && b.confirmedAt)
    .sort((a, b) => b.confirmedAt!.localeCompare(a.confirmedAt!))[0];
  if (confirmed) return confirmed.proposedPrice;
  return state.fuels.find((f) => f.code === fuelCode)?.basePrice ?? 0;
}

/**
 * 关联挂牌价：某油品在指定生效日期当日的在册挂牌价，
 * 取 effectiveDate <= date 的最近一条已确认批次，否则取基准价。
 */
function refPriceOf(state: LedgerState, fuelCode: string, date: string): number {
  const prior = state.batches
    .filter((b) => b.fuelCode === fuelCode && b.confirmedAt && b.effectiveDate <= date)
    .sort((a, b) =>
      b.effectiveDate.localeCompare(a.effectiveDate) || b.confirmedAt!.localeCompare(a.confirmedAt!),
    )[0];
  if (prior) return prior.proposedPrice;
  return state.fuels.find((f) => f.code === fuelCode)?.basePrice ?? 0;
}

function diffOf(proposed: number, ref: number): number {
  return roundPrice(proposed - ref);
}

function seedState(): LedgerState {
  const fuels: Fuel[] = [
    { code: "92", name: "92号汽油", basePrice: 7.62 },
    { code: "95", name: "95号汽油", basePrice: 8.14 },
    { code: "98", name: "98号汽油", basePrice: 9.21 },
    { code: "0", name: "0号柴油", basePrice: 7.18 },
  ];
  return {
    fuels,
    batches: [],
    handovers: [],
    seq: 1,
    draft: {
      fuelCode: "92",
      proposedPrice: null,
      effectiveDate: today(),
      sender: "",
      receiver: "",
      note: "",
    },
  };
}

function loadState(): LedgerState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedState();
  try {
    const parsed = JSON.parse(raw) as LedgerState;
    // 简单容错：缺字段时回到初始台账
    if (!Array.isArray(parsed.fuels) || !Array.isArray(parsed.batches) || !Array.isArray(parsed.handovers)) {
      return seedState();
    }
    return parsed;
  } catch {
    return seedState();
  }
}

export interface BatchInput {
  fuelCode: string;
  proposedPrice: number;
  effectiveDate: string;
  sender: string;
  receiver: string;
  note: string;
}

export const useLedgerStore = defineStore("ledger", () => {
  const state = reactive<LedgerState>(loadState());

  // 台账变更即落盘，重开页面后完整恢复
  watch(
    state,
    (value) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    },
    { deep: true },
  );

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // ---------- 查询 ----------

  const fuels = computed(() => state.fuels);

  const pendingHandovers = computed(() =>
    state.handovers
      .filter((h) => h.status !== "confirmed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

  const failedHandovers = computed(() =>
    state.handovers.filter((h) => h.status === "failed"),
  );

  function batchOf(handover: HandoverRecord): PriceBatch | undefined {
    return state.batches.find((b) => b.id === handover.batchId);
  }

  function handoverOf(batch: PriceBatch): HandoverRecord | undefined {
    return state.handovers.find((h) => h.id === batch.handoverId);
  }

  function fuelName(code: string): string {
    return state.fuels.find((f) => f.code === code)?.name ?? code;
  }

  function currentPrice(fuelCode: string): number {
    return currentPriceOf(state, fuelCode);
  }

  /**
   * 班次差额：拟调挂牌价 − 关联挂牌价（生效日期当日在册价）。
   * 生效日期改动、关联挂牌价重算后，差额随之更新。
   */
  function shiftDiff(batch: PriceBatch): number {
    return diffOf(batch.proposedPrice, batch.refPrice);
  }

  /**
   * 预览某油品的"拟调差额"：送出前展示新价相对现行价的班次差额。
   */
  function previewDiff(fuelCode: string, proposedPrice: number | null): number | null {
    if (proposedPrice === null || Number.isNaN(proposedPrice)) return null;
    return roundPrice(proposedPrice - currentPrice(fuelCode));
  }

  /**
   * 未结确认项队列中某油品前面还有几条未结（pending/failed）批次，
   * 用来提示"晚到不会覆盖先到"，先到先确认。
   */
  function queueIndex(batch: PriceBatch): number {
    const queue = state.batches
      .filter((b) => b.fuelCode === batch.fuelCode)
      .filter((b) => {
        const h = handoverOf(b);
        return h && h.status !== "confirmed";
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return queue.findIndex((b) => b.id === batch.id);
  }

  // ---------- 命令 ----------

  /**
   * 送出调价批次：
   * 1. 冻结当刻现行挂牌价与送出经办人；
   * 2. 同油品已有未结批次时，本次内容转为"接班员确认项"（receiver 必填语义，
   *    状态 pending，排在队列后，不覆盖任何先到批次）；
   * 3. 生成交接记录。
   */
  function submitBatch(input: BatchInput): PriceBatch {
    const fuelCode = input.fuelCode;
    const current = currentPriceOf(state, fuelCode);
    const timestamp = nowIso();
    state.seq += 1;
    const batchNo = `TJ-${timestamp.slice(0, 10).replace(/-/g, "")}-${String(state.seq).padStart(3, "0")}`;

    const handoverId = crypto.randomUUID();
    const batch: PriceBatch = {
      id: crypto.randomUUID(),
      fuelCode,
      batchNo,
      proposedPrice: roundPrice(input.proposedPrice),
      effectiveDate: input.effectiveDate,
      sender: input.sender,
      receiver: input.receiver,
      note: input.note,
      createdAt: timestamp,
      frozenPrice: roundPrice(current), // 冻结当刻价格
      frozenAt: timestamp,
      refPrice: roundPrice(refPriceOf(state, fuelCode, input.effectiveDate)),
      handoverId,
    };

    const handover: HandoverRecord = {
      id: handoverId,
      batchId: batch.id,
      fuelCode,
      sender: input.sender,
      receiver: input.receiver,
      status: "pending",
      attempts: 0,
      failReason: "",
      createdAt: timestamp,
    };

    state.batches.unshift(batch);
    state.handovers.unshift(handover);
    persist();
    return batch;
  }

  function setHandoverStatus(
    handoverId: string,
    status: HandoverStatus,
    failReason = "",
  ) {
    const handover = state.handovers.find((h) => h.id === handoverId);
    if (!handover) return;
    handover.status = status;
    handover.attempts += 1;
    handover.lastAttemptAt = nowIso();
    if (status === "failed") {
      handover.failReason = failReason || "接班员未签收";
    }
    if (status === "confirmed") {
      handover.confirmedAt = nowIso();
      const batch = state.batches.find((b) => b.id === handover.batchId);
      if (batch) {
        batch.confirmedAt = handover.confirmedAt;
        // 新批次生效后，未结批次的关联挂牌价 / 差额随之重算
        recomputeRefs(batch.fuelCode);
      }
    }
    persist();
  }

  /** 接班员确认：批次挂牌价自此成为现行价 */
  function confirm(handoverId: string) {
    setHandoverStatus(handoverId, "confirmed");
  }

  /** 交接失败：保留批次与冻结快照，置为 failed 等待重试 */
  function failHandover(handoverId: string, reason?: string) {
    setHandoverStatus(handoverId, "failed", reason);
  }

  /** 重试未完成项（重开页面后也可逐条重试） */
  function retry(handoverId: string) {
    const handover = state.handovers.find((h) => h.id === handoverId);
    if (!handover || handover.status === "confirmed") return;
    handover.status = "pending";
    handover.failReason = "";
    handover.attempts += 1;
    handover.lastAttemptAt = nowIso();
    persist();
  }

  /**
   * 修改生效日期：关联挂牌价（生效当日在册价）与班次差额立即重算。
   * 同时重算同油品其余未结批次，保持台账一致。
   */
  function updateEffectiveDate(batchId: string, effectiveDate: string) {
    const batch = state.batches.find((b) => b.id === batchId);
    if (!batch) return;
    batch.effectiveDate = effectiveDate;
    batch.refPrice = roundPrice(refPriceOf(state, batch.fuelCode, effectiveDate));
    batch.proposedPrice = roundPrice(batch.proposedPrice);
    recomputeRefs(batch.fuelCode);
    persist();
  }

  /** 重算某油品所有未结批次的关联挂牌价（确认新批次后调用） */
  function recomputeRefs(fuelCode?: string) {
    for (const b of state.batches) {
      if (fuelCode && b.fuelCode !== fuelCode) continue;
      const h = state.handovers.find((x) => x.id === b.handoverId);
      if (h && h.status !== "confirmed") {
        b.refPrice = roundPrice(refPriceOf(state, b.fuelCode, b.effectiveDate));
      }
    }
  }

  function updateDraft(patch: Partial<BatchDraft>) {
    Object.assign(state.draft, patch);
    persist();
  }

  function clearDraft() {
    state.draft = {
      fuelCode: state.draft.fuelCode || state.fuels[0]?.code || "",
      proposedPrice: null,
      effectiveDate: today(),
      sender: "",
      receiver: "",
      note: "",
    };
    persist();
  }

  function resetLedger() {
    const fresh = seedState();
    state.fuels = fresh.fuels;
    state.batches = fresh.batches;
    state.handovers = fresh.handovers;
    state.seq = fresh.seq;
    state.draft = fresh.draft;
    persist();
  }

  return {
    state,
    fuels,
    pendingHandovers,
    failedHandovers,
    batchOf,
    handoverOf,
    fuelName,
    currentPrice,
    shiftDiff,
    previewDiff,
    queueIndex,
    submitBatch,
    confirm,
    failHandover,
    retry,
    updateEffectiveDate,
    updateDraft,
    clearDraft,
    resetLedger,
  };
});
