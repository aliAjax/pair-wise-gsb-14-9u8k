<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { BASE_PRICES, FUELS, type BatchStatus, type FuelName, type HandoverLog, type PriceBatch } from "./types";
import { todayStr, useLedgerStore } from "./store/ledger";

const store = useLedgerStore();
const { batches, logs, successor, failSimulation, draft, restoredAt, openBatches, currentPriceMap } =
  storeToRefs(store);

const confirmMsg = ref<{ kind: "ok" | "err"; text: string } | null>(null);

// ---------- 指标 ----------
const pendingConfirm = computed(() => openBatches.value.filter((b) => b.needsConfirmation).length);
const failedCount = computed(() => openBatches.value.filter((b) => b.status === "failed").length);
const avgCurrent = computed(
  () => FUELS.reduce((s, f) => s + currentPriceMap.value[f], 0) / FUELS.length,
);

// ---------- 表单 ----------
const formFuel = computed({
  get: () => draft.value.fuel,
  set: (v: FuelName) => store.saveDraft({ fuel: v }),
});
const formPrice = computed({
  get: () => (draft.value.newPrice ?? ""),
  set: (v: number | string) => store.saveDraft({ newPrice: v === "" ? null : Number(v) }),
});
const formOperator = computed({
  get: () => draft.value.operator,
  set: (v: string) => store.saveDraft({ operator: v }),
});
const formDate = computed({
  get: () => draft.value.effectiveDate,
  set: (v: string) => store.saveDraft({ effectiveDate: v }),
});
const formNote = computed({
  get: () => draft.value.note,
  set: (v: string) => store.saveDraft({ note: v }),
});

/** 送出当刻将冻结的现行价（表单实时预览） */
const previewCurrent = computed(() => currentPriceMap.value[formFuel.value]);
const previewDiff = computed(() =>
  draft.value.newPrice == null ? null : Math.round((draft.value.newPrice - previewCurrent.value) * 100) / 100,
);

const existingOpen = computed(() =>
  batches.value.find((b) => b.fuel === formFuel.value && b.status !== "confirmed"),
);

function submit() {
  if (draft.value.newPrice == null || !draft.value.operator.trim() || !draft.value.effectiveDate) return;
  store.submitBatch({
    fuel: draft.value.fuel,
    newPrice: draft.value.newPrice,
    operator: draft.value.operator,
    effectiveDate: draft.value.effectiveDate,
    note: draft.value.note,
  });
}

// ---------- 交接动作 ----------
function doConfirm(b: PriceBatch) {
  const res = store.attemptConfirm(b);
  confirmMsg.value = res.ok
    ? { kind: "ok", text: `${b.fuel} 已由 ${successor.value} 确认生效` }
    : { kind: "err", text: `${b.fuel} 交接失败：${res.reason}` };
}

const retryResult = ref<ReturnType<typeof store.retryAll> | null>(null);
function retry() {
  retryResult.value = store.retryAll();
  const { done, failed, stillBlocked } = retryResult.value;
  confirmMsg.value = failed
    ? { kind: "err", text: `重试完成：生效 ${done} 项，失败 ${failed} 项${stillBlocked ? `，排队 ${stillBlocked} 项` : ""}` }
    : { kind: "ok", text: `重试完成：生效 ${done} 项${stillBlocked ? `，仍有 ${stillBlocked} 项排队` : ""}` };
}

function onDateInput(b: PriceBatch, ev: Event) {
  store.changeEffectiveDate(b, (ev.target as HTMLInputElement).value);
}

// ---------- 台账导入导出 ----------
function doExport() {
  const blob = new Blob([store.exportJson()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `调价批次交接台账-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const importText = ref("");
const importErr = ref("");
function doImport() {
  if (store.importJson(importText.value)) {
    importText.value = "";
    importErr.value = "";
  } else {
    importErr.value = "台账文件格式不正确，未覆盖当前数据";
  }
}

// ---------- 展示辅助 ----------
const STATUS_META: Record<BatchStatus, { text: string; cls: string }> = {
  pending: { text: "待接班确认", cls: "st-pending" },
  confirmed: { text: "已确认生效", cls: "st-confirmed" },
  failed: { text: "交接失败·待重试", cls: "st-failed" },
};

const LOG_META: Record<HandoverLog["type"], string> = {
  submit: "送出批次",
  queue: "转确认项",
  "confirm-success": "确认生效",
  "confirm-fail": "交接失败",
  retry: "重试",
  "date-change": "日期重算",
  withdraw: "撤回",
  restore: "页面恢复",
  reset: "重置",
  import: "导入台账",
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { hour12: false });
}
function money(n: number) {
  return n.toFixed(2);
}
function diffText(n: number) {
  return `${n >= 0 ? "+" : ""}${money(n)}`;
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 调价批次交接班台账</p>
          <h1>油品调价批次与值班交接</h1>
          <p class="subtitle">
            批次送出时冻结当刻挂牌价与经办人；同油品后到内容不覆盖先到价，转为接班员确认项排队。
            交接失败可在重开页面后恢复台账并一键重试；生效日期改动，前档挂牌价与班次差额实时重算。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">localStorage 可恢复台账</span>
        </div>
      </header>

      <div v-if="restoredAt" class="restore-banner">
        台账已从本地恢复（重开页面于 {{ fmtTime(restoredAt) }}），未完成交接项可继续重试。
      </div>

      <!-- 同屏总览：现行价 / 未结交接项 / 差额 -->
      <section class="metrics">
        <article class="metric">
          <span>油品现行挂牌均价（元/升）</span>
          <strong>{{ money(avgCurrent) }}</strong>
          <small>4 个油品当日现行价平均</small>
        </article>
        <article class="metric">
          <span>未结交接项</span>
          <strong>{{ openBatches.length }}</strong>
          <small>待确认 {{ pendingConfirm }} 项 · 失败待重试 {{ failedCount }} 项</small>
        </article>
        <article class="metric">
          <span>待确认批次合计差额（元/升）</span>
          <strong :class="openBatches.reduce((s, b) => s + store.derived(b.id).shiftDiff, 0) >= 0 ? 'up' : 'down'">
            {{ diffText(openBatches.reduce((s, b) => s + store.derived(b.id).shiftDiff, 0)) }}
          </strong>
          <small>班次差额按生效日期重算口径</small>
        </article>
      </section>

      <div class="workspace">
        <!-- 左：送出批次 -->
        <form class="panel" @submit.prevent="submit">
          <h2>送出调价批次</h2>
          <div class="form-grid">
            <label>
              油品
              <select v-model="formFuel" required>
                <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>

            <div class="frozen-hint">
              <span>当刻现行价（将冻结）</span>
              <strong>{{ money(previewCurrent) }}</strong>
            </div>

            <label>
              新挂牌价（元/升）
              <input v-model="formPrice" type="number" step="0.01" min="0" required placeholder="如 7.62" />
            </label>

            <div v-if="previewDiff !== null" class="frozen-hint" :class="previewDiff >= 0 ? 'up-bg' : 'down-bg'">
              <span>对当刻现行价差额</span>
              <strong :class="previewDiff >= 0 ? 'up' : 'down'">{{ diffText(previewDiff) }}</strong>
            </div>

            <label>
              经办人（交班侧，送出即冻结）
              <input v-model="formOperator" required placeholder="如 甲班·王磊" />
            </label>
            <label>
              生效日期（可后改并触发重算）
              <input v-model="formDate" type="date" required />
            </label>
            <label>
              备注
              <textarea v-model="formNote" placeholder="调价说明 / 交接备注（草稿自动保存）" />
            </label>

            <div v-if="existingOpen" class="queue-warn">
              {{ formFuel }} 已有 {{ existingOpen.operator }} 的未结批次在先，
              本次送出<strong>不会覆盖</strong>其挂牌价，将转为接班员确认项排在其后。
            </div>

            <button type="submit">送出批次（冻结价格与经办人）</button>
          </div>

          <hr class="divider" />

          <h3 class="side-title">值班交接设置</h3>
          <div class="form-grid">
            <label>
              接班员
              <input :value="successor" @input="store.setSuccessor(($event.target as HTMLInputElement).value)"
                placeholder="如 丙班·赵强" />
            </label>
            <label class="switch-row">
              <input type="checkbox" :checked="failSimulation"
                @change="store.setFailSimulation(($event.target as HTMLInputElement).checked)" />
              <span>模拟交接失败（演练：失败后重开页面再重试）</span>
            </label>
          </div>
        </form>

        <!-- 右：未结交接项 -->
        <section class="list-panel">
          <div class="toolbar">
            <h2>未结交接项 <em class="count">{{ openBatches.length }}</em></h2>
            <div class="actions-inline">
              <button type="button" @click="retry">重试全部未完成项</button>
            </div>
          </div>

          <p v-if="confirmMsg" class="toast" :class="confirmMsg.kind">{{ confirmMsg.text }}</p>

          <div class="record-grid">
            <div v-if="openBatches.length === 0" class="empty">全部批次已交接完成</div>

            <article v-for="b in openBatches" :key="b.id" class="record"
              :class="{ failed: b.status === 'failed' }">
              <div class="record-head">
                <p class="record-title">
                  {{ b.fuel }}
                  <span v-if="b.needsConfirmation" class="chip chip-confirm">接班员确认项</span>
                </p>
                <span class="status" :class="STATUS_META[b.status].cls">{{ STATUS_META[b.status].text }}</span>
              </div>

              <div class="details">
                <span>申报挂牌价：<b>{{ money(b.newPrice) }}</b></span>
                <span>现行价（冻结）：{{ money(b.frozenPrice) }}</span>
                <span>前档挂牌价：{{ money(store.derived(b.id).tierPrice) }}</span>
                <span>
                  班次差额：<b :class="store.derived(b.id).shiftDiff >= 0 ? 'up' : 'down'">
                    {{ diffText(store.derived(b.id).shiftDiff) }}
                  </b>
                </span>
                <span>冻结差额：{{ diffText(store.derived(b.id).frozenDiff) }}</span>
                <span>交班经办人：{{ b.operator }}</span>
                <span>送出时间：{{ fmtTime(b.submittedAt) }}</span>
                <span>尝试次数：{{ b.attempts }}</span>
              </div>

              <label class="date-row">
                生效日期：
                <input type="date" :value="b.effectiveDate" @change="onDateInput(b, $event)" />
                <small class="recalc-hint">改动后挂牌价、差额自动重算</small>
              </label>

              <p v-if="store.blockedBy(b)" class="blocked">
                排队中：先到批次（{{ store.blockedBy(b)!.operator }}）未交接完成，本项暂不能确认生效
              </p>
              <p v-else-if="b.status === 'failed'" class="blocked err">上次失败原因：{{ b.lastError }}</p>
              <p v-if="b.note" class="note">{{ b.note }}</p>

              <div class="actions">
                <button type="button" :disabled="Boolean(store.blockedBy(b))" @click="doConfirm(b)">
                  {{ successor || "接班员" }} 确认交接
                </button>
                <button class="secondary" type="button" @click="store.withdraw(b)">撤回归档</button>
              </div>
            </article>
          </div>

          <!-- 现行价总览 -->
          <div class="price-board">
            <h3>各油品现行挂牌价</h3>
            <div class="price-grid">
              <div v-for="f in FUELS" :key="f" class="price-cell">
                <span>{{ f }}</span>
                <strong>{{ money(currentPriceMap[f]) }}</strong>
                <small>基准 {{ money(BASE_PRICES[f]) }}</small>
              </div>
            </div>
          </div>
        </section>
      </div>

      <!-- 完整批次台账 -->
      <section class="panel ledger-panel">
        <div class="toolbar">
          <h2>调价批次台账 <em class="count">{{ batches.length }}</em></h2>
          <div class="actions-inline">
            <button class="secondary" type="button" @click="doExport">导出台账 JSON</button>
            <button class="secondary" type="button" @click="store.resetDemo()">恢复示例数据</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>油品</th>
                <th>状态</th>
                <th>申报价</th>
                <th>冻结现行价</th>
                <th>前档挂牌价</th>
                <th>班次差额</th>
                <th>生效日期</th>
                <th>经办人(冻结)</th>
                <th>接班人</th>
                <th>送出时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in batches" :key="b.id">
                <td>
                  {{ b.fuel }}
                  <span v-if="b.needsConfirmation" class="chip chip-confirm">确认项</span>
                </td>
                <td><span class="status" :class="STATUS_META[b.status].cls">{{ STATUS_META[b.status].text }}</span></td>
                <td>{{ money(b.newPrice) }}</td>
                <td>{{ money(b.frozenPrice) }}</td>
                <td>{{ money(store.derived(b.id).tierPrice) }}</td>
                <td :class="store.derived(b.id).shiftDiff >= 0 ? 'up' : 'down'">
                  {{ diffText(store.derived(b.id).shiftDiff) }}
                </td>
                <td>{{ b.effectiveDate }}</td>
                <td>{{ b.operator }}</td>
                <td>{{ b.confirmedBy || "—" }}</td>
                <td>{{ fmtTime(b.submittedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <details class="import-box">
          <summary>导入备份台账（粘贴 JSON，用于故障换机恢复）</summary>
          <textarea v-model="importText" rows="4" placeholder="粘贴此前导出的台账 JSON" />
          <p v-if="importErr" class="blocked err">{{ importErr }}</p>
          <button class="secondary" type="button" @click="doImport">导入并恢复</button>
        </details>
      </section>

      <!-- 值班交接记录 -->
      <section class="panel log-panel">
        <h2>值班交接记录 <em class="count">{{ logs.length }}</em></h2>
        <ul class="log-list">
          <li v-for="l in logs" :key="l.id">
            <span class="log-time">{{ fmtTime(l.at) }}</span>
            <span class="log-type" :class="`log-${l.type}`">{{ LOG_META[l.type] }}</span>
            <span class="log-detail">{{ l.detail }}</span>
          </li>
        </ul>
      </section>
    </div>
  </main>
</template>
