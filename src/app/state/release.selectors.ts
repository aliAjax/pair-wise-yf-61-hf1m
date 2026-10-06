import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { Receipt, ReleaseState } from './release.models';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectDevices = createSelector(selectRelease, (state) => state.devices);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectReceipts = createSelector(selectRelease, (state) => state.receipts);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);

export const selectOnlineDeviceCount = createSelector(selectDevices, (devices) => devices.filter((device) => device.online).length);
export const selectOfflineDeviceCount = createSelector(selectDevices, (devices) => devices.filter((device) => !device.online).length);

/**
 * 逐台进度账：指定批次的每台设备只留最新一条回执（按设备编号去重），
 * 含已作废回执，便于在台账中展示回滚/补报痕迹。
 */
export function selectBatchLedger(batchId: string) {
  return createSelector(selectReceipts, (receipts): Receipt[] => {
    const ledger = new Map<string, Receipt>();
    for (const receipt of receipts) {
      if (receipt.batchId !== batchId) continue;
      const prev = ledger.get(receipt.deviceId);
      if (!prev || receipt.at > prev.at) ledger.set(receipt.deviceId, receipt);
    }
    return Array.from(ledger.values()).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  });
}
