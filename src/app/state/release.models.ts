export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

export type ReceiptResult = 'downloaded' | 'installed' | 'failed';

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
}

export interface Device {
  id: string;
  groupId: string;
  /** 网关在线状态；离线期间设备不回传回执 */
  online: boolean;
}

export interface Receipt {
  id: string;
  deviceId: string;
  batchId: string;
  firmware: string;
  result: ReceiptResult;
  at: string;
  /** 离线网关回网后的补报回执 */
  late: boolean;
  /** 已合并进未结束批次；批次结束后晚到的回执不合并 */
  merged: boolean;
  /** 紧急回滚后作废 */
  valid: boolean;
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  /** 本批参与进度账的终端台数（灰度目标） */
  target: number;
  progress: number;
  downloaded: number;
  installed: number;
  failed: number;
  /** 阈值变更后进行中批次失效，等待按进度账重算 */
  stale: boolean;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  groups: DeviceGroup[];
  devices: Device[];
  batches: ReleaseBatch[];
  receipts: Receipt[];
  audits: AuditEntry[];
}
