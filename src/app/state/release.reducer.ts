import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, Device, DeviceGroup, Receipt, ReceiptResult, ReleaseBatch, ReleaseState } from './release.models';
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, telemetryTick, updateThreshold } from './release.actions';

const STORAGE_KEY = 'firmware-release-v2';
/** 每个分组模拟的终端台数（进度账按逐台维护，页面只渲染台账行） */
const SIM_GROUP_SIZE = 60;
/** 离线网关回网的概率（每个遥测 tick） */
const GATEWAY_RECOVERY_RATE = 0.22;

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4 },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12 },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2 }
];

function buildDevices(groups: DeviceGroup[]): Device[] {
  const devices: Device[] = [];
  for (const group of groups) {
    const offlineCount = group.offlineGateways * 3;
    for (let i = 1; i <= SIM_GROUP_SIZE; i++) {
      devices.push({
        id: `${group.id}-${String(i).padStart(3, '0')}`,
        groupId: group.id,
        online: i > offlineCount
      });
    }
  }
  return devices;
}

const now = new Date().toISOString();
const initialBatches: ReleaseBatch[] = [
  { id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge', rolloutPercent: 20, failureThreshold: 5, status: 'approved', target: 0, progress: 0, downloaded: 0, installed: 0, failed: 0, stale: false, updatedAt: now }
];
const initialAudits: AuditEntry[] = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];

const fallback: ReleaseState = { groups: initialGroups, devices: buildDevices(initialGroups), batches: initialBatches, receipts: [], audits: initialAudits };

function loadState(): ReleaseState {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ReleaseState>;
    if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.batches)) return fallback;
    return {
      groups: parsed.groups,
      devices: Array.isArray(parsed.devices) && parsed.devices.length ? parsed.devices : buildDevices(parsed.groups),
      batches: parsed.batches,
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
      audits: Array.isArray(parsed.audits) ? parsed.audits : []
    };
  } catch {
    return fallback;
  }
}

const initialState = loadState();

function auditEntry(actor: string, message: string): AuditEntry {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), actor, message };
}

/**
 * 逐台进度账：按设备编号去重，每台设备只留最新一条有效且已合并的回执。
 * 已作废（回滚）或未合并（批次结束后晚到）的回执不参与计数。
 */
function latestReceipts(receipts: Receipt[], batchId: string): Map<string, Receipt> {
  const ledger = new Map<string, Receipt>();
  for (const receipt of receipts) {
    if (receipt.batchId !== batchId || !receipt.valid || !receipt.merged) continue;
    const prev = ledger.get(receipt.deviceId);
    if (!prev || receipt.at > prev.at) ledger.set(receipt.deviceId, receipt);
  }
  return ledger;
}

function makeReceipt(batch: ReleaseBatch, device: Device, result: ReceiptResult, late: boolean): Receipt {
  return {
    id: crypto.randomUUID(),
    deviceId: device.id,
    batchId: batch.id,
    firmware: batch.firmware,
    result,
    at: new Date().toISOString(),
    late,
    merged: true,
    valid: true
  };
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch }) => ({ ...state, batches: [batch, ...state.batches], audits: [auditEntry('发布负责人', `创建批次 ${batch.name}`), ...state.audits] })),
  on(approveBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'approved', updatedAt: new Date().toISOString() } : batch), audits: [auditEntry(actor, `批次 ${id} 审批通过`), ...state.audits] })),
  on(pauseBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'paused', updatedAt: new Date().toISOString() } : batch), audits: [auditEntry(actor, `批次 ${id} 已暂停`), ...state.audits] })),
  on(resumeBatch, (state, { id, actor }) => ({ ...state, batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'running', updatedAt: new Date().toISOString() } : batch), audits: [auditEntry(actor, `批次 ${id} 恢复发布`), ...state.audits] })),
  on(rollbackBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id
      ? { ...batch, status: 'rolled_back', stale: false, target: 0, progress: 0, downloaded: 0, installed: 0, failed: 0, updatedAt: new Date().toISOString() }
      : batch),
    // 紧急回滚：该批次全部回执作废，离线期间补报的旧回执同样作废
    receipts: state.receipts.map((receipt) => receipt.batchId === id ? { ...receipt, valid: false, merged: false } : receipt),
    audits: [auditEntry(actor, `批次 ${id} 已紧急回滚，离线期间补报的旧回执全部作废`), ...state.audits]
  })),
  on(updateThreshold, (state, { id, failureThreshold, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    const active = batch.status === 'running' || batch.status === 'paused';
    const next: ReleaseBatch = { ...batch, failureThreshold, stale: active, status: active ? 'running' : batch.status, updatedAt: new Date().toISOString() };
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? next : item),
      // 阈值改动：进行中批次进度账失效重算，已装台数保留、不重新计数
      audits: active
        ? [auditEntry(actor, `批次 ${batch.name} 失败阈值调整为 ${failureThreshold}%，进行中批次进度账失效重算，已装台数保留不重算`), ...state.audits]
        : state.audits
    };
  }),
  on(telemetryTick, (state) => {
    const newAudits: AuditEntry[] = [];
    let devices = state.devices;
    let receipts = [...state.receipts];
    let batches = state.batches;

    for (const batch of state.batches) {
      if (batch.status !== 'running') continue;
      const group = state.groups.find((item) => item.id === batch.groupId);
      if (!group) continue;

      // 灰度目标台数：按分组台数 × 比例，且不超过模拟终端规模
      const target = Math.min(Math.round(group.count * batch.rolloutPercent / 100), SIM_GROUP_SIZE);
      const population = devices.filter((device) => device.groupId === group.id).slice(0, target);
      const ledger = latestReceipts(receipts, batch.id);

      // 在线设备逐台回传回执（每台只推进自己的进度，已装好的不重算）
      for (const device of population) {
        if (!device.online) continue;
        const current = ledger.get(device.id);
        if (current?.result === 'installed') continue;
        if (!current || current.result === 'failed') {
          if (Math.random() < 0.5) receipts.push(makeReceipt(batch, device, 'downloaded', false));
        } else if (current.result === 'downloaded') {
          const roll = Math.random();
          if (roll < 0.1) receipts.push(makeReceipt(batch, device, 'failed', false));
          else if (roll < 0.55) receipts.push(makeReceipt(batch, device, 'installed', false));
        }
      }

      // 离线网关回网：补报回执合并进仍在运行的批次（已结束的批次不再合并）
      const offline = population.filter((device) => !device.online);
      if (offline.length && Math.random() < GATEWAY_RECOVERY_RATE) {
        devices = devices.map((device) => offline.some((item) => item.id === device.id) ? { ...device, online: true } : device);
        for (const device of offline) {
          const current = ledger.get(device.id);
          if (current?.result === 'installed') continue;
          const roll = Math.random();
          const result: ReceiptResult = roll < 0.45 ? 'installed' : roll < 0.85 ? 'downloaded' : 'failed';
          receipts.push(makeReceipt(batch, device, result, true));
        }
        newAudits.push(auditEntry('系统', `${offline.length} 台离线网关回网，补报回执已合并进批次 ${batch.name}`));
      }

      // 依据逐台进度账重算计数：回执按设备编号去重，每台只留最新结果
      const latest = latestReceipts(receipts, batch.id);
      let downloaded = 0;
      let installed = 0;
      let failed = 0;
      for (const receipt of latest.values()) {
        if (receipt.result === 'downloaded') downloaded++;
        else if (receipt.result === 'installed') installed++;
        else failed++;
      }
      const done = downloaded + installed;
      const failureRate = done + failed ? failed / (done + failed) * 100 : 0;
      let status: ReleaseBatch['status'] = batch.status;
      if (failureRate > batch.failureThreshold) {
        status = 'paused';
        newAudits.push(auditEntry('系统', `批次 ${batch.name} 失败率 ${failureRate.toFixed(1)}% 超过阈值 ${batch.failureThreshold}%，已自动暂停`));
      } else if (done >= target) {
        status = 'completed';
      }

      batches = batches.map((item) => item.id === batch.id
        ? { ...item, target, downloaded, installed, failed, progress: target ? Math.round(done / target * 100) : 0, status, stale: false, updatedAt: new Date().toISOString() }
        : item);
    }

    return { ...state, devices, batches, receipts, audits: [...newAudits, ...state.audits] };
  })
);
