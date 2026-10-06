import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { BatchStats, DeviceReceipt, Gateway, ReleaseBatch, ReleaseState } from './release.models';
import { tallyBatch } from './ledger';

export interface BatchView {
  batch: ReleaseBatch;
  stats: BatchStats;
}

export interface GatewayView {
  gateway: Gateway;
  groupName: string;
  region: string;
  deviceCount: number;
  buffered: number;
}

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectDevices = createSelector(selectRelease, (state) => state.devices);

/** 批次视图：台数全部由逐台台账实时投影，组件侧不再持有聚合计数 */
export const selectBatchViews = createSelector(selectRelease, (state): BatchView[] =>
  state.batches.map((batch) => ({ batch, stats: tallyBatch(batch, state.ledgers[batch.id] ?? {}) }))
);

export const selectGateways = createSelector(
  selectRelease,
  (state): GatewayView[] =>
    state.gateways.map((gateway) => {
      const group = state.groups.find((item) => item.id === gateway.groupId);
      return {
        gateway,
        groupName: group?.name ?? gateway.groupId,
        region: group?.region ?? '',
        deviceCount: state.devices.filter((device) => device.gatewayId === gateway.id).length,
        buffered: state.offlineBuffers[gateway.id]?.length ?? 0
      };
    })
);

export const selectRecentReceipts = createSelector(selectRelease, (state): DeviceReceipt[] =>
  state.receiptLog.slice(-12).reverse()
);

export interface RolloutOverview {
  paused: number;
  onlineDevices: number;
  lateReported: number;
  dedupedReceipts: number;
}

export const selectRolloutOverview = createSelector(selectBatchViews, selectRelease, (views, state): RolloutOverview => {
  let onlineDevices = 0;
  let lateReported = 0;
  for (const view of views) {
    onlineDevices += view.stats.installed;
    lateReported += view.stats.lateReported;
  }
  return {
    paused: views.filter((view) => view.batch.status === 'paused').length,
    onlineDevices,
    lateReported,
    dedupedReceipts: state.receiptLog.filter((receipt) => receipt.duplicate).length
  };
});
