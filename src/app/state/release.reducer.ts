import { createReducer, on } from '@ngrx/store';
import type {
  AuditEntry,
  BatchStatus,
  Device,
  DeviceGroup,
  DeviceLedger,
  DeviceReceipt,
  DeviceStage,
  Gateway,
  ReleaseBatch,
  ReleaseState
} from './release.models';
import {
  approveBatch,
  createBatch,
  pauseBatch,
  resumeBatch,
  rollbackBatch,
  setGatewayOnline,
  telemetryTick,
  updateThreshold
} from './release.actions';
import { isNewer, rejudge, tallyBatch } from './ledger';

const STORAGE_KEY = 'firmware-release-v2';
const LEGACY_STORAGE_KEY = 'firmware-release-v1';
const LOG_LIMIT = 300;
const OPEN_STATUSES: BatchStatus[] = ['running', 'paused'];

interface IngestResult {
  touched: Set<string>;
  merged: number;
  lateMerged: number;
  duplicates: number;
  voided: number;
}

/* ------------------------------------------------------------------ */
/* 种子数据：分组 / 网关 / 设备                                          */
/* ------------------------------------------------------------------ */

const seedGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 24, compatible: true },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 30, compatible: false },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 18, compatible: true }
];

const gatewaySpecs: Array<{ id: string; name: string; groupId: string; online: boolean }> = [
  { id: 'gw-edge-1', name: '华东边缘网关 A', groupId: 'g-edge', online: false },
  { id: 'gw-edge-2', name: '华东边缘网关 B', groupId: 'g-edge', online: true },
  { id: 'gw-edge-3', name: '华东边缘网关 C', groupId: 'g-edge', online: true },
  { id: 'gw-plant-1', name: '工业采集网关 A', groupId: 'g-plant', online: true },
  { id: 'gw-plant-2', name: '工业采集网关 B', groupId: 'g-plant', online: false },
  { id: 'gw-plant-3', name: '工业采集网关 C', groupId: 'g-plant', online: true },
  { id: 'gw-plant-4', name: '工业采集网关 D', groupId: 'g-plant', online: true },
  { id: 'gw-clinic-1', name: '诊疗终端网关 A', groupId: 'g-clinic', online: true },
  { id: 'gw-clinic-2', name: '诊疗终端网关 B', groupId: 'g-clinic', online: true }
];

function buildGateways(): Gateway[] {
  return gatewaySpecs.map((spec) => ({ id: spec.id, name: spec.name, groupId: spec.groupId, online: spec.online }));
}

function buildDevices(groups: DeviceGroup[], gateways: Gateway[]): Device[] {
  const devices: Device[] = [];
  for (const group of groups) {
    const gws = gateways.filter((gw) => gw.groupId === group.id);
    for (let i = 0; i < group.count; i++) {
      const seq = String(i + 1).padStart(2, '0');
      devices.push({
        id: `dev-${group.id}-${seq}`,
        name: `${group.name}-${seq}`,
        groupId: group.id,
        // 设备在组内网关间轮流挂载，保证每个批次都可能覆盖到离线网关
        gatewayId: gws[i % gws.length].id
      });
    }
  }
  return devices;
}

/** 按灰度比例从组内均匀抽设备（跨网关均匀分布），发布范围在批次创建时冻结 */
function sampleDevices(allDevices: Device[], groupId: string, percent: number): string[] {
  const pool = allDevices.filter((device) => device.groupId === groupId);
  const target = Math.round((pool.length * percent) / 100);
  const picked: string[] = [];
  for (let k = 0; k < target; k++) {
    const index = Math.floor((k * pool.length) / target);
    picked.push(pool[index].id);
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* 初始化与 v1 持久化迁移                                                */
/* ------------------------------------------------------------------ */

function seedState(): ReleaseState {
  const groups = seedGroups;
  const gateways = buildGateways();
  const devices = buildDevices(groups, gateways);
  const nowIso = new Date().toISOString();
  const demoBatch: ReleaseBatch = {
    id: 'batch-demo',
    name: '边缘网关安全补丁 2.8.1',
    firmware: '2.8.1',
    rollbackVersion: '2.7.9',
    groupId: 'g-edge',
    rolloutPercent: 25,
    failureThreshold: 5,
    status: 'approved',
    deviceIds: sampleDevices(devices, 'g-edge', 25),
    wave: 0,
    tallyVersion: 1,
    startedAt: null,
    updatedAt: nowIso
  };
  const audits: AuditEntry[] = [
    { id: crypto.randomUUID(), at: nowIso, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }
  ];
  return {
    version: 2,
    groups,
    gateways,
    devices,
    batches: [demoBatch],
    ledgers: {},
    offlineBuffers: {},
    receiptLog: [],
    sim: {},
    audits
  };
}

interface LegacyBatch {
  id?: string;
  name?: string;
  firmware?: string;
  rollbackVersion?: string;
  groupId?: string;
  rolloutPercent?: number;
  failureThreshold?: number;
  status?: BatchStatus;
  updatedAt?: string;
}

/** v1 只有聚合计数，无法逐台追溯，迁移时重建设备账：旧批次保留元数据、台账从空重新累积 */
function migrateLegacy(raw: { groups?: DeviceGroup[]; batches?: LegacyBatch[]; audits?: AuditEntry[] }): ReleaseState {
  const seed = seedState();
  const legacyGroups = raw.groups ?? [];
  const knownGroupIds = new Set(seed.groups.map((group) => group.id));
  if (legacyGroups.some((group) => group.id && !knownGroupIds.has(group.id))) {
    // 出现种子之外的分组时无法可靠重建设备拓扑，直接落回种子
    return seed;
  }
  const batches: ReleaseBatch[] = (raw.batches ?? [])
    .filter((batch): batch is LegacyBatch & { id: string; groupId: string } => Boolean(batch.id && batch.groupId))
    .filter((batch) => knownGroupIds.has(batch.groupId))
    .map((batch) => {
      const status: BatchStatus = ['draft', 'approved', 'running', 'paused', 'completed', 'rolled_back'].includes(
        batch.status ?? ''
      )
        ? (batch.status as BatchStatus)
        : 'draft';
      return {
        id: batch.id,
        name: batch.name ?? batch.id,
        firmware: batch.firmware ?? '',
        rollbackVersion: batch.rollbackVersion ?? '',
        groupId: batch.groupId,
        rolloutPercent: batch.rolloutPercent ?? 10,
        failureThreshold: batch.failureThreshold ?? 5,
        status,
        deviceIds: sampleDevices(seed.devices, batch.groupId, batch.rolloutPercent ?? 10),
        wave: 0,
        tallyVersion: 1,
        startedAt: status === 'running' ? Date.now() : null,
        updatedAt: batch.updatedAt ?? new Date().toISOString()
      };
    });
  return { ...seed, batches: batches.length ? batches : seed.batches, audits: raw.audits ?? seed.audits };
}

function hydrate(): ReleaseState {
  if (typeof localStorage === 'undefined') return seedState();
  const rawV2 = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ReleaseState | null;
  if (rawV2 && rawV2.version === 2 && Array.isArray(rawV2.devices)) {
    return {
      ...seedState(),
      ...rawV2,
      offlineBuffers: rawV2.offlineBuffers ?? {},
      receiptLog: rawV2.receiptLog ?? [],
      sim: rawV2.sim ?? {},
      ledgers: rawV2.ledgers ?? {}
    };
  }
  const rawV1 = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? 'null') as Parameters<typeof migrateLegacy>[0] | null;
  return rawV1 ? migrateLegacy(rawV1) : seedState();
}

const initialState = hydrate();

/* ------------------------------------------------------------------ */
/* 纯变更工具                                                           */
/* ------------------------------------------------------------------ */

function addAudit(draft: ReleaseState, actor: string, message: string): void {
  const entry: AuditEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), actor, message };
  draft.audits = [entry, ...draft.audits];
}

function isOpen(status: BatchStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/**
 * 回执入账（直接修改 draft）：
 * - 批次已结束/已回滚 → 作废
 * - 同设备编号已有更新或相同结果 → 重复，只留痕不计账
 * - 否则覆盖该设备台账条目（每台设备只留最新结果）
 */
function ingestReceipts(draft: ReleaseState, receipts: DeviceReceipt[]): IngestResult {
  const result: IngestResult = { touched: new Set(), merged: 0, lateMerged: 0, duplicates: 0, voided: 0 };
  const batchById = new Map(draft.batches.map((batch) => [batch.id, batch]));

  for (const receipt of receipts) {
    const batch = batchById.get(receipt.batchId);
    if (!batch || !isOpen(batch.status)) {
      receipt.voided = true;
      draft.receiptLog.push(receipt);
      result.voided += 1;
      continue;
    }
    const ledger: DeviceLedger = draft.ledgers[batch.id] ?? {};
    const current = ledger[receipt.deviceId];
    if (current && !isNewer(receipt, current)) {
      receipt.duplicate = true;
      draft.receiptLog.push(receipt);
      result.duplicates += 1;
      continue;
    }
    ledger[receipt.deviceId] = receipt;
    draft.ledgers[batch.id] = ledger;
    result.touched.add(batch.id);
    result.merged += 1;
    if (receipt.late) result.lateMerged += 1;
    draft.receiptLog.push(receipt);
  }
  draft.receiptLog = draft.receiptLog.slice(-LOG_LIMIT);
  return result;
}

/** 入账后用逐台台账重判受影响批次（暂停/完成） */
function adjudicate(draft: ReleaseState, touched: Set<string>, actor: string): void {
  for (const batchId of touched) {
    const batch = draft.batches.find((item) => item.id === batchId);
    if (!batch || !isOpen(batch.status)) continue;
    const ledger = draft.ledgers[batchId] ?? {};
    const previous = batch.status;
    const next = rejudge(batch, ledger, previous);
    if (next === previous) continue;
    batch.status = next;
    batch.updatedAt = new Date().toISOString();
    const stats = tallyBatch(batch, ledger);
    if (next === 'paused') {
      addAudit(draft, actor, `失败率 ${stats.failureRate.toFixed(1)}% 超过阈值 ${batch.failureThreshold}%，批次 ${batch.name} 已自动暂停`);
    } else if (next === 'completed') {
      addAudit(
        draft,
        actor,
        `批次 ${batch.name} 已装 ${stats.installed}/${stats.target} 台（含离线补报 ${stats.lateReported} 台），判定完成`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 遥测模拟器                                                           */
/* ------------------------------------------------------------------ */

const STAGE_CHAIN: DeviceStage[] = [
  'pending',
  'downloading',
  'downloaded',
  'installing',
  'installed',
  'rebooting',
  'online'
];

function nextStage(stage: DeviceStage): DeviceStage {
  const index = STAGE_CHAIN.indexOf(stage);
  if (index < 0 || index >= STAGE_CHAIN.length - 1) return stage;
  return STAGE_CHAIN[index + 1];
}

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

export const releaseReducer = createReducer(
  initialState,

  on(createBatch, (state, { batch }) => {
    const group = state.groups.find((item) => item.id === batch.groupId);
    if (!group?.compatible) return state;
    const draft: ReleaseState = structuredClone(state);
    draft.batches = [batch, ...draft.batches];
    addAudit(draft, '发布负责人', `创建批次 ${batch.name}，灰度 ${batch.rolloutPercent}% 共 ${batch.deviceIds.length} 台，失败阈值 ${batch.failureThreshold}%`);
    return draft;
  }),

  on(approveBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || batch.status !== 'draft') return state;
    const draft: ReleaseState = structuredClone(state);
    const target = draft.batches.find((item) => item.id === id)!;
    target.status = 'approved';
    target.updatedAt = new Date().toISOString();
    addAudit(draft, actor, `批次 ${target.name} 审批通过`);
    return draft;
  }),

  on(pauseBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || batch.status !== 'running') return state;
    const draft: ReleaseState = structuredClone(state);
    const target = draft.batches.find((item) => item.id === id)!;
    target.status = 'paused';
    target.updatedAt = new Date().toISOString();
    addAudit(draft, actor, `批次 ${target.name} 已暂停`);
    return draft;
  }),

  on(resumeBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || (batch.status !== 'paused' && batch.status !== 'approved')) return state;
    const draft: ReleaseState = structuredClone(state);
    const target = draft.batches.find((item) => item.id === id)!;
    target.status = 'running';
    target.startedAt ??= Date.now();
    target.updatedAt = new Date().toISOString();
    addAudit(draft, actor, `批次 ${target.name} 恢复发布，逐台台账继续接收回执`);
    return draft;
  }),

  on(updateThreshold, (state, { id, failureThreshold, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || !isOpen(batch.status) || failureThreshold === batch.failureThreshold) return state;
    const draft: ReleaseState = structuredClone(state);
    const target = draft.batches.find((item) => item.id === id)!;
    target.failureThreshold = failureThreshold;
    // 阈值改动：进行中的批次失效重算（台账保留，已装台数不重算）
    target.tallyVersion += 1;
    const previous = target.status;
    target.status = rejudge(target, draft.ledgers[id] ?? {}, previous, { recomputePaused: true });
    target.updatedAt = new Date().toISOString();
    const note =
      target.status === 'paused'
        ? '按新阈值仍超限，保持暂停'
        : previous === 'paused'
          ? '旧暂停判定失效，恢复发布'
          : '继续发布';
    addAudit(draft, actor, `批次 ${target.name} 失败阈值改为 ${failureThreshold}%，进行中判定失效并按逐台台账重算：${note}`);
    return draft;
  }),

  on(rollbackBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || batch.status === 'rolled_back') return state;
    const draft: ReleaseState = structuredClone(state);
    const target = draft.batches.find((item) => item.id === id)!;
    target.status = 'rolled_back';
    target.updatedAt = new Date().toISOString();

    // 紧急回滚：离线期间压在网关侧、属于本批次的旧回执全部作废，回网后不再入账
    let voidedCount = 0;
    for (const gatewayId of Object.keys(draft.offlineBuffers)) {
      const kept: DeviceReceipt[] = [];
      for (const receipt of draft.offlineBuffers[gatewayId]) {
        if (receipt.batchId === id) {
          receipt.voided = true;
          draft.receiptLog.push(receipt);
          voidedCount += 1;
        } else {
          kept.push(receipt);
        }
      }
      draft.offlineBuffers[gatewayId] = kept;
    }
    draft.receiptLog = draft.receiptLog.slice(-LOG_LIMIT);

    // 回滚现场，设备不再继续为该批次推进
    for (const deviceId of target.deviceIds) {
      draft.sim[deviceId] = { stage: 'pending', at: Date.now() };
    }
    addAudit(
      draft,
      actor,
      `批次 ${target.name} 已紧急回滚到 ${target.rollbackVersion}，逐台台账封存${voidedCount ? `，离线期间 ${voidedCount} 张旧回执已作废` : ''}`
    );
    return draft;
  }),

  on(setGatewayOnline, (state, { gatewayId, online, actor }) => {
    const gateway = state.gateways.find((item) => item.id === gatewayId);
    if (!gateway || gateway.online === online) return state;
    const draft: ReleaseState = structuredClone(state);
    const targetGateway = draft.gateways.find((item) => item.id === gatewayId)!;
    targetGateway.online = online;
    if (!online) {
      addAudit(draft, actor, `网关 ${targetGateway.name} 离线，期间回执在网关侧积压`);
      return draft;
    }

    // 回网：把积压回执按现场时间补报，合并进尚未结束的批次；终态批次的旧回执作废
    const buffered = (draft.offlineBuffers[gatewayId] ?? [])
      .slice()
      .sort((a, b) => a.reportedAt - b.reportedAt);
    delete draft.offlineBuffers[gatewayId];
    const now = Date.now();
    for (const receipt of buffered) {
      receipt.late = true;
      receipt.receivedAt = now;
    }
    addAudit(draft, actor, `网关 ${targetGateway.name} 回网${buffered.length ? `，补报离线期间 ${buffered.length} 张回执` : ''}`);
    if (buffered.length) {
      const result = ingestReceipts(draft, buffered);
      addAudit(
        draft,
        '系统',
        `补报合并：并入未结束批次 ${result.merged} 张（其中离线补报 ${result.lateMerged} 张），重复回执 ${result.duplicates} 张已按设备编号去重，作废 ${result.voided} 张`
      );
      adjudicate(draft, result.touched, '系统');
    }
    return draft;
  }),

  on(telemetryTick, (state) => {
    const running = state.batches.filter((batch) => batch.status === 'running');
    if (running.length === 0) return state;

    const draft: ReleaseState = structuredClone(state);
    const now = Date.now();
    const deviceById = new Map(draft.devices.map((device) => [device.id, device]));
    const gatewayById = new Map(draft.gateways.map((gateway) => [gateway.id, gateway]));
    const liveReceipts: DeviceReceipt[] = [];

    for (const batch of draft.batches) {
      if (batch.status !== 'running') continue;
      // 每个 tick 多放两台设备进入发布波次
      batch.wave = Math.min(batch.deviceIds.length, batch.wave + 2);
      batch.updatedAt = new Date(now).toISOString();

      for (const deviceId of batch.deviceIds.slice(0, batch.wave)) {
        const current = draft.sim[deviceId]?.stage ?? 'pending';
        if (current === 'online' || current === 'failed') continue;
        const device = deviceById.get(deviceId);
        const gateway = device ? gatewayById.get(device.gatewayId) : undefined;
        if (!device || !gateway) continue;
        // 离线设备现场仍会推进，只是回执压在网关侧
        if (Math.random() > (gateway.online ? 0.55 : 0.3)) continue;

        const next = current === 'installing' && Math.random() < 0.07 ? 'failed' : nextStage(current);
        draft.sim[deviceId] = { stage: next, at: now };

        const makeReceipt = (): DeviceReceipt => ({
          id: crypto.randomUUID(),
          batchId: batch.id,
          deviceId,
          gatewayId: gateway.id,
          stage: next,
          reportedAt: now,
          receivedAt: now,
          late: false,
          duplicate: false,
          voided: false
        });
        const receipt = makeReceipt();
        if (gateway.online) {
          liveReceipts.push(receipt);
          // 同一台设备重复回传：在线链路上偶发重发同一张结果，入账时按设备编号去重
          if (Math.random() < 0.14) liveReceipts.push(makeReceipt());
        } else {
          const buffer = draft.offlineBuffers[gateway.id] ?? [];
          buffer.push(receipt);
          draft.offlineBuffers[gateway.id] = buffer;
        }
      }
    }

    if (liveReceipts.length > 0) {
      const result = ingestReceipts(draft, liveReceipts);
      adjudicate(draft, result.touched, '系统');
    }
    return draft;
  })
);
