// 可恢复台账领域模型：油品、调价批次、值班交接记录
// 全部数据持久化在 localStorage，刷新 / 重开页面后可恢复未完成项。

export interface Fuel {
  code: string;
  name: string;
  /** 基准挂牌价（无任何已确认批次时使用） */
  basePrice: number;
}

export interface PriceBatch {
  id: string;
  fuelCode: string;
  /** 调价批次号，送出时生成 */
  batchNo: string;
  /** 申报（新）挂牌价 */
  proposedPrice: number;
  effectiveDate: string;
  /** 送出经办人（交班员） */
  sender: string;
  /** 接班确认人；后到同油品批次转为接班员确认项时预填 */
  receiver: string;
  note: string;
  createdAt: string;
  /** 冻结快照：批次送出当刻该油品现行挂牌价 */
  frozenPrice: number;
  /** 冻结快照时间 */
  frozenAt: string;
  /**
   * 关联挂牌价：生效日期当日的在册挂牌价（取该日期之前最近一条已确认批次，
   * 无则取基准价）。生效日期一改动即重算；班次差额 = proposedPrice - refPrice。
   */
  refPrice: number;
  /** 交接记录 id */
  handoverId: string;
  /** 确认时间，存在即视为已生效 */
  confirmedAt?: string;
}

export type HandoverStatus = "pending" | "failed" | "confirmed";

export interface HandoverRecord {
  id: string;
  batchId: string;
  fuelCode: string;
  sender: string;
  receiver: string;
  /** pending = 未结（接班待确认 / 排队），failed = 交接失败待重试，confirmed = 已确认 */
  status: HandoverStatus;
  attempts: number;
  failReason: string;
  createdAt: string;
  lastAttemptAt?: string;
  confirmedAt?: string;
}

export interface LedgerState {
  fuels: Fuel[];
  batches: PriceBatch[];
  handovers: HandoverRecord[];
  /** 送出表单草稿，防止交接失败 / 误关页面后重复录入 */
  draft: BatchDraft;
  seq: number;
}

export interface BatchDraft {
  fuelCode: string;
  proposedPrice: number | null;
  effectiveDate: string;
  sender: string;
  receiver: string;
  note: string;
}
