export const FUELS = ["92号汽油", "95号汽油", "98号汽油", "0号柴油"] as const;
export type FuelName = (typeof FUELS)[number];

/** 各油品基准挂牌价（无已确认批次时使用） */
export const BASE_PRICES: Record<FuelName, number> = {
  "92号汽油": 7.45,
  "95号汽油": 7.95,
  "98号汽油": 8.82,
  "0号柴油": 7.1,
};

/** 批次状态：待接班确认 / 已确认生效 / 上次交接失败（仍属未完成项，可重试） */
export type BatchStatus = "pending" | "confirmed" | "failed";

export interface PriceBatch {
  id: string;
  fuel: FuelName;
  /** 本次申报的新挂牌价 */
  newPrice: number;
  /** 送出当刻冻结的现行挂牌价（快照，不随后续修改变化） */
  frozenPrice: number;
  /** 送出当刻冻结的经办人（快照） */
  operator: string;
  /** 送出时间（快照） */
  submittedAt: string;
  /** 生效日期：可调整，改动后关联挂牌价与班次差额实时重算 */
  effectiveDate: string;
  status: BatchStatus;
  /** 后到同油品 → 转为接班员确认项 */
  needsConfirmation: boolean;
  /** 关联的先到同油品批次（排队依据） */
  predecessorId?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  /** 交接尝试次数（失败后重试累加） */
  attempts: number;
  lastError?: string;
  note?: string;
}

export type LogType =
  | "submit"
  | "queue"
  | "confirm-success"
  | "confirm-fail"
  | "retry"
  | "date-change"
  | "withdraw"
  | "restore"
  | "reset"
  | "import";

export interface HandoverLog {
  id: string;
  batchId?: string;
  fuel?: FuelName;
  type: LogType;
  /** 交班侧经办人 */
  from?: string;
  /** 接班侧确认人 */
  to?: string;
  detail: string;
  at: string;
}

export interface Draft {
  fuel: FuelName;
  newPrice: number | null;
  operator: string;
  effectiveDate: string;
  note: string;
}

export interface LedgerState {
  version: number;
  batches: PriceBatch[];
  logs: HandoverLog[];
  successor: string;
  failSimulation: boolean;
  draft: Draft;
}
