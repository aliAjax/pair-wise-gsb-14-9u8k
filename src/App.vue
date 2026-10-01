<script setup lang="ts">
import { computed, reactive } from "vue";
import { storeToRefs } from "pinia";
import { useLedgerStore } from "./store";

const ledger = useLedgerStore();
const { state, fuels, pendingHandovers, failedHandovers } = storeToRefs(ledger);

const form = reactive({
  fuelCode: state.value.draft.fuelCode,
  proposedPrice: state.value.draft.proposedPrice ?? (undefined as number | undefined),
  effectiveDate: state.value.draft.effectiveDate,
  sender: state.value.draft.sender,
  receiver: state.value.draft.receiver,
  note: state.value.draft.note,
});

const today = new Date().toISOString().slice(0, 10);

function syncDraft() {
  ledger.updateDraft({
    fuelCode: form.fuelCode,
    proposedPrice: form.proposedPrice === undefined ? null : Number(form.proposedPrice),
    effectiveDate: form.effectiveDate,
    sender: form.sender,
    receiver: form.receiver,
    note: form.note,
  });
}

const previewDiff = computed(() =>
  ledger.previewDiff(form.fuelCode, form.proposedPrice === undefined ? null : Number(form.proposedPrice)),
);

/** 同油品未结队列（用于提示"晚到转接班员确认项，不覆盖先到"） */
const openForSelectedFuel = computed(() =>
  state.value.handovers
    .filter((h) => h.fuelCode === form.fuelCode && h.status !== "confirmed")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
);

const formValid = computed(
  () =>
    !!form.fuelCode &&
    form.proposedPrice !== undefined &&
    Number(form.proposedPrice) > 0 &&
    !!form.effectiveDate &&
    form.sender.trim() !== "" &&
    form.receiver.trim() !== "",
);

function submit() {
  if (!formValid.value) return;
  ledger.submitBatch({
    fuelCode: form.fuelCode,
    proposedPrice: Number(form.proposedPrice),
    effectiveDate: form.effectiveDate,
    sender: form.sender.trim(),
    receiver: form.receiver.trim(),
    note: form.note.trim(),
  });
  form.proposedPrice = undefined;
  form.note = "";
  ledger.clearDraft();
}

const confirmedBatches = computed(() =>
  state.value.batches
    .filter((b) => b.confirmedAt)
    .sort((a, b) => (b.confirmedAt || "").localeCompare(a.confirmedAt || "")),
);

function fmt(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function diffText(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(4)}`.replace(/0+$/, "").replace(/\.$/, "");
}

function onConfirm(handoverId: string) {
  ledger.confirm(handoverId);
}

function onFail(handoverId: string) {
  const reason = window.prompt("交接失败原因（可留空）", "接班员未签收");
  if (reason === null) return;
  ledger.failHandover(handoverId, reason);
}

function onDateChange(batchId: string, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (value) ledger.updateEffectiveDate(batchId, value);
}

const metrics = computed(() => [
  { label: "油品种类", value: fuels.value.length },
  { label: "未结交接项", value: pendingHandovers.value.length },
  { label: "失败待重试", value: failedHandovers.value.length },
  { label: "已生效批次", value: confirmedBatches.value.length },
]);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 调价批次值班交接台账</p>
          <h1>油品调价交接可恢复台账</h1>
          <p class="subtitle">
            批次送出时冻结当刻挂牌价与经办人；同油品晚到批次转为接班员确认项排队，不覆盖先到价格。
            台账自动保存在本机，交接失败后重开页面仍可重试未完成项；生效日期改动后，关联挂牌价与班次差额立即重算。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3 + Pinia</span>
          <span class="tag">localStorage 可恢复</span>
          <span class="tag">先到先确认</span>
        </div>
      </header>

      <section class="metrics metrics-4">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <!-- 送出调价批次 -->
        <form class="panel" @submit.prevent="submit">
          <h2>送出调价批次</h2>

          <div v-if="openForSelectedFuel.length" class="note note-warn">
            该油品已有 <strong>{{ openForSelectedFuel.length }}</strong> 条未结交接项，
            本次送出将转为<strong>接班员确认项</strong>排队，不会覆盖先到批次的挂牌价与差额。
          </div>

          <div class="form-grid">
            <label>
              油品
              <select v-model="form.fuelCode" required @change="syncDraft">
                <option v-for="f in fuels" :key="f.code" :value="f.code">{{ f.name }}</option>
              </select>
            </label>

            <div class="price-readout">
              <span>当刻现行挂牌价</span>
              <strong>{{ ledger.currentPrice(form.fuelCode).toFixed(2) }} 元/升</strong>
            </div>

            <label>
              拟挂牌价（元/升）
              <input
                v-model.number="form.proposedPrice"
                type="number"
                step="0.01"
                min="0"
                placeholder="请输入新的挂牌价"
                required
                @input="syncDraft"
              />
            </label>

            <div
              class="price-readout"
              :class="{ up: (previewDiff ?? 0) > 0, down: (previewDiff ?? 0) < 0 }"
            >
              <span>相对现行价班次差额（预览）</span>
              <strong>{{ previewDiff === null ? "—" : `${diffText(previewDiff)} 元/升` }}</strong>
            </div>

            <label>
              生效日期
              <input v-model="form.effectiveDate" type="date" required @change="syncDraft" />
            </label>

            <label>
              交班经办人
              <input v-model="form.sender" placeholder="送出批次的值班员" required @input="syncDraft" />
            </label>

            <label>
              接班确认人
              <input v-model="form.receiver" placeholder="负责确认的接班员" required @input="syncDraft" />
            </label>

            <label>
              备注
              <textarea v-model="form.note" placeholder="交接说明（可选）" @input="syncDraft" />
            </label>

            <div class="actions">
              <button type="submit" :disabled="!formValid">冻结价格并送出</button>
              <button type="button" class="secondary" @click="ledger.resetLedger()">重置台账</button>
            </div>
            <p class="hint">表单内容自动暂存，误关页面后可继续填写。</p>
          </div>
        </form>

        <section class="list-panel">
          <!-- 现行价 -->
          <h2>现行挂牌价</h2>
          <div class="price-cards">
            <article v-for="f in fuels" :key="f.code" class="price-card">
              <span>{{ f.name }}</span>
              <strong>{{ ledger.currentPrice(f.code).toFixed(2) }}</strong>
              <em>元/升</em>
            </article>
          </div>

          <!-- 未结交接项 -->
          <div class="section-head">
            <h2>未结交接项 <small>（接班员确认项 · 失败待重试）</small></h2>
          </div>

          <div v-if="pendingHandovers.length === 0" class="empty">
            没有未结交接项，所有调价批次均已完成交接。
          </div>

          <div v-else class="record-grid">
            <article
              v-for="h in pendingHandovers"
              :key="h.id"
              class="record"
              :class="{ 'record-failed': h.status === 'failed' }"
            >
              <template v-if="ledger.batchOf(h)">
                <div class="record-head">
                  <p class="record-title">
                    {{ ledger.fuelName(h.fuelCode) }}
                    <span class="batch-no">{{ ledger.batchOf(h)!.batchNo }}</span>
                  </p>
                  <span
                    class="status"
                    :class="h.status === 'failed' ? 'status-failed' : 'status-pending'"
                  >
                    {{ h.status === "failed" ? "交接失败 · 待重试" : "待接班确认" }}
                  </span>
                </div>

                <div class="details details-3">
                  <span>交班员：<b>{{ h.sender }}</b></span>
                  <span>接班员：<b>{{ h.receiver }}</b></span>
                  <span>送出时间：{{ fmt(ledger.batchOf(h)!.createdAt) }}</span>
                  <span>拟挂牌价：<b>{{ ledger.batchOf(h)!.proposedPrice.toFixed(2) }}</b></span>
                  <span>关联挂牌价：<b>{{ ledger.batchOf(h)!.refPrice.toFixed(2) }}</b></span>
                  <span
                    class="diff"
                    :class="{
                      up: ledger.shiftDiff(ledger.batchOf(h)!) > 0,
                      down: ledger.shiftDiff(ledger.batchOf(h)!) < 0,
                    }"
                  >
                    班次差额：{{ diffText(ledger.shiftDiff(ledger.batchOf(h)!)) }}
                  </span>
                </div>

                <div class="freeze-line">
                  送出时冻结现行价 {{ ledger.batchOf(h)!.frozenPrice.toFixed(2) }} 元/升
                  （{{ fmt(ledger.batchOf(h)!.frozenAt) }}）
                </div>

                <label class="date-inline">
                  生效日期（改动即重算关联价与差额）：
                  <input
                    type="date"
                    :value="ledger.batchOf(h)!.effectiveDate"
                    @change="onDateChange(ledger.batchOf(h)!.id, $event)"
                  />
                </label>

                <div v-if="h.status === 'failed'" class="note note-warn">
                  失败原因：{{ h.failReason }} ｜ 已尝试 {{ h.attempts }} 次 ｜ 最近操作
                  {{ fmt(h.lastAttemptAt) }}
                </div>

                <div v-if="ledger.queueIndex(ledger.batchOf(h)!) > 0" class="note note-queue">
                  同油品队列第 {{ ledger.queueIndex(ledger.batchOf(h)!) + 1 }} 条：
                  晚到批次，需先确认前序批次后才可接班生效。
                </div>

                <p v-if="ledger.batchOf(h)!.note" class="note">{{ ledger.batchOf(h)!.note }}</p>

                <div class="actions">
                  <button
                    type="button"
                    :disabled="ledger.queueIndex(ledger.batchOf(h)!) > 0 || h.status === 'failed'"
                    @click="onConfirm(h.id)"
                  >
                    接班确认并生效
                  </button>
                  <button
                    v-if="h.status === 'failed'"
                    type="button"
                    class="secondary"
                    @click="ledger.retry(h.id)"
                  >
                    重试交接
                  </button>
                  <button
                    v-if="h.status === 'pending'"
                    type="button"
                    class="danger"
                    @click="onFail(h.id)"
                  >
                    标记交接失败
                  </button>
                </div>
              </template>
            </article>
          </div>

          <!-- 已生效台账 -->
          <div class="section-head">
            <h2>已生效批次台账</h2>
          </div>
          <div v-if="confirmedBatches.length === 0" class="empty">暂无已生效批次。</div>
          <table v-else class="ledger-table">
            <thead>
              <tr>
                <th>批次号</th>
                <th>油品</th>
                <th>挂牌价</th>
                <th>差额</th>
                <th>生效日期</th>
                <th>交班 / 接班</th>
                <th>确认时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in confirmedBatches" :key="b.id">
                <td>{{ b.batchNo }}</td>
                <td>{{ ledger.fuelName(b.fuelCode) }}</td>
                <td>{{ b.proposedPrice.toFixed(2) }}</td>
                <td
                  :class="{
                    up: ledger.shiftDiff(b) > 0,
                    down: ledger.shiftDiff(b) < 0,
                  }"
                >
                  {{ diffText(ledger.shiftDiff(b)) }}
                </td>
                <td>{{ b.effectiveDate }}</td>
                <td>{{ b.sender }} / {{ b.receiver }}</td>
                <td>{{ fmt(b.confirmedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>
    </div>
  </main>
</template>
