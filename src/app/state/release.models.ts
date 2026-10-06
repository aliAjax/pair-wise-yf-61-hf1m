export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

/** 设备在一次发布中的阶段；failed 为终态，online 为成功终态 */
export type DeviceStage =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'rebooting'
  | 'online'
  | 'failed';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
}

export interface Gateway {
  id: string;
  name: string;
  groupId: string;
  online: boolean;
}

export interface Device {
  /** 设备编号，回执去重键 */
  id: string;
  name: string;
  groupId: string;
  gatewayId: string;
}

/**
 * 设备回执：网关把单台设备某一时刻的结果上报到控制台。
 * 离线期间产生的回执先压在网关侧，回网后补报（late=true）。
 */
export interface DeviceReceipt {
  id: string;
  batchId: string;
  /** 设备编号 */
  deviceId: string;
  gatewayId: string;
  stage: DeviceStage;
  /** 设备现场产生结果的时间（用于判断谁更新） */
  reportedAt: number;
  /** 控制台收到回执的时间 */
  receivedAt: number;
  /** 离线期间积压、回网后补报 */
  late: boolean;
  /** 同设备编号已有更新结果，此张为重复回传，不计账 */
  duplicate: boolean;
  /** 批次已结束或已回滚，此张旧回执作废 */
  voided: boolean;
}

/**
 * 逐台进度账：batchId -> (设备编号 -> 该设备最新一张有效回执)。
 * 每台设备只留最新结果，所有台数统计都是这本账的投影，不另存聚合计数。
 */
export type DeviceLedger = Record<string, DeviceReceipt>;

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  /** 本批灰度选中的设备编号（发布范围在创建时冻结） */
  deviceIds: string[];
  /** 模拟器用：已进入发布波次的设备数 */
  wave: number;
  /** 阈值改动失效重算 / 回滚的版本号，逐台台账不随之清零 */
  tallyVersion: number;
  startedAt: number | null;
  updatedAt: string;
}

export interface BatchStats {
  /** 本批应发布台数 */
  target: number;
  /** 去重后有回执的台数（每台只算一次） */
  reported: number;
  /** 最新结果已完成下载的台数 */
  downloaded: number;
  /** 最新结果已装好（含重启、上线）的台数，终态后不因补报重复累加 */
  installed: number;
  failed: number;
  /** 最新结果来自离线网关补报的台数 */
  lateReported: number;
  progress: number;
  failureRate: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

/** 遥测模拟器内部状态：设备当前真实阶段（控制台台账只认回执） */
export interface DeviceSimState {
  stage: DeviceStage;
  at: number;
}

export interface ReleaseState {
  version: 2;
  groups: DeviceGroup[];
  gateways: Gateway[];
  devices: Device[];
  batches: ReleaseBatch[];
  /** 逐台进度账 */
  ledgers: Record<string, DeviceLedger>;
  /** 离线网关侧积压的回执：gatewayId -> receipts，回网时按序补报 */
  offlineBuffers: Record<string, DeviceReceipt[]>;
  /** 最近回执流水（含重复/作废痕迹，供审计与排查） */
  receiptLog: DeviceReceipt[];
  sim: Record<string, DeviceSimState>;
  audits: AuditEntry[];
}
