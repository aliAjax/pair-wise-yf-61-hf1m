import type { BatchStats, BatchStatus, DeviceLedger, DeviceReceipt, DeviceStage, ReleaseBatch } from './release.models';

/** 阶段新旧次序：同一台设备，stage 靠后且 reportedAt 更新的结果才为“最新” */
const STAGE_ORDER: DeviceStage[] = [
  'pending',
  'downloading',
  'downloaded',
  'installing',
  'installed',
  'rebooting',
  'online',
  'failed'
];

/** 装成：已经装好，无论之后是重启中还是已上线 */
const INSTALLED_STAGES: DeviceStage[] = ['installed', 'rebooting', 'online'];
/** 下载完成：安装链路都算已下载 */
const DOWNLOADED_STAGES: DeviceStage[] = ['downloaded', 'installing', 'installed', 'rebooting', 'online'];

/** 达到多少台有结果后，失败率才参与自动暂停判定，避免前几台噪声触发 */
export const PAUSE_FLOOR = 5;

/** 一张回执是否比台账中现有结果更新（现场时间优先，同时允许同时间下阶段推进） */
export function isNewer(receipt: DeviceReceipt, current: DeviceReceipt | undefined): boolean {
  if (!current) return true;
  if (receipt.reportedAt !== current.reportedAt) return receipt.reportedAt > current.reportedAt;
  return STAGE_ORDER.indexOf(receipt.stage) > STAGE_ORDER.indexOf(current.stage);
}

export function tallyBatch(batch: ReleaseBatch, ledger: DeviceLedger): BatchStats {
  const receipts = batch.deviceIds.map((id) => ledger[id]).filter((r): r is DeviceReceipt => Boolean(r));
  const reported = receipts.length;
  const downloaded = receipts.filter((r) => DOWNLOADED_STAGES.includes(r.stage)).length;
  const installed = receipts.filter((r) => INSTALLED_STAGES.includes(r.stage)).length;
  const failed = receipts.filter((r) => r.stage === 'failed').length;
  const lateReported = receipts.filter((r) => r.late).length;
  return {
    target: batch.deviceIds.length,
    reported,
    downloaded,
    installed,
    failed,
    lateReported,
    progress: batch.deviceIds.length ? Math.round((installed / batch.deviceIds.length) * 100) : 0,
    failureRate: reported ? (failed / reported) * 100 : 0
  };
}

/**
 * 用逐台台账重判批次状态：
 * - 已装台数达标 → 完成（离线补报也能把“没结束”的批次推到完成）
 * - 失败率超阈值且样本足够 → 暂停（仅对发布中的批次自动暂停）
 * - 已暂停的批次不自动恢复，需要人工继续
 */
export function rejudge(
  batch: ReleaseBatch,
  ledger: DeviceLedger,
  previousStatus: BatchStatus,
  opts: { recomputePaused?: boolean } = {}
): BatchStatus {
  if (previousStatus === 'draft' || previousStatus === 'approved') return previousStatus;
  if (previousStatus === 'completed' || previousStatus === 'rolled_back') return previousStatus;

  const stats = tallyBatch(batch, ledger);
  if (stats.target > 0 && stats.installed >= stats.target) return 'completed';
  const overThreshold = stats.reported >= PAUSE_FLOOR && stats.failureRate > batch.failureThreshold;
  if (overThreshold) return 'paused';
  // 阈值改动触发的重算：旧暂停判定失效，不超阈就恢复发布；普通补报不自动恢复暂停批次
  if (opts.recomputePaused && previousStatus === 'paused') return 'running';
  return previousStatus;
}
