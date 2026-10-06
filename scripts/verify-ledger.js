/* 端到端行为验证：把 reducer 源码用 esbuild 打成 CJS，
 * 用假时钟/假随机驱动，逐条断言五条业务规则。 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const harness = `
global.localStorage = { getItem: () => null, setItem: () => {} };
global.crypto = { randomUUID: (() => { let n = 0; return () => 'uuid-' + (++n); })() };
let clock = 1700000000000;
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(clock); else super(...args); }
  static now() { return clock; }
};
global.structuredClone = (x) => JSON.parse(JSON.stringify(x));
global.setInterval = () => 0;
global.clearInterval = () => {};
`;

const test = `
import { releaseReducer } from '/workspace/src/app/state/release.reducer';
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, setGatewayOnline, telemetryTick, updateThreshold } from '/workspace/src/app/state/release.actions';
import { rejudge, tallyBatch } from '/workspace/src/app/state/ledger';
import type { DeviceReceipt, ReleaseBatch } from '/workspace/src/app/state/release.models';

let clock = 1700000000000;
const advance = (ms: number) => { clock += ms; };
let state: any;
const dispatch = (action: any) => { state = releaseReducer(state, action); };
const getBatch = (id = 'batch-demo'): ReleaseBatch => state.batches.find((b: any) => b.id === id);
const stats = (id = 'batch-demo') => tallyBatch(getBatch(id), state.ledgers[id] ?? {});
const ticks = (n: number) => { for (let i = 0; i < n; i++) { advance(1400); dispatch(telemetryTick()); } };

// 确定性随机：0.25 同时满足：在线(<=0.55)/离线(<=0.3)设备每 tick 推进、
// 安装阶段不失败(>=0.07)、不自发重发(>=0.14)
Math.random = () => 0.25;

/* ---------- 规则 1+2：重复回执按设备编号去重，每台只留最新结果 ---------- */
dispatch(resumeBatch({ id: 'batch-demo', actor: 't' }));
ticks(8); // 波次 6 台全部进入；4 台在线设备走到 online，2 台离线设备回执积压
const s1 = stats();
console.log('在线推进后：', JSON.stringify(s1));
if (s1.installed !== 4) throw new Error('4 台在线设备应已装好，实际 ' + s1.installed);
if (s1.reported !== 4) throw new Error('在线设备去重后有回执台数应为 4，实际 ' + s1.reported);

const bufferedOffline = state.offlineBuffers['gw-edge-1']?.length ?? 0;
console.log('离线积压回执', bufferedOffline);
if (bufferedOffline !== 12) throw new Error('2 台离线设备各 6 个阶段回执，应积压 12 张，实际 ' + bufferedOffline);
if (getBatch().status !== 'running') throw new Error('批次应仍未结束（4/6）');

// 同一台设备重复回传：复制一张与缓冲中完全相同（同 reportedAt、同阶段）的回执，换流水号
const lastBuffer = state.offlineBuffers['gw-edge-1'].filter((r: any) => r.stage === 'online')[0];
const retransmit: DeviceReceipt = { ...lastBuffer, id: 'retransmit-copy' };
state = { ...state, offlineBuffers: { ...state.offlineBuffers, ['gw-edge-1']: [...state.offlineBuffers['gw-edge-1'], retransmit] } };

/* ---------- 规则 3：离线网关回网，旧回执补报并入“没结束”的批次 ---------- */
advance(60000);
dispatch(setGatewayOnline({ gatewayId: 'gw-edge-1', online: true, actor: 't' }));
const s2 = stats();
console.log('补报后：', JSON.stringify(s2), '状态', getBatch().status);
if (s2.installed !== 6) throw new Error('补报后已装应为 6，实际 ' + s2.installed);
if (s2.reported !== 6) throw new Error('每台只算一次，reported 应为 6，实际 ' + s2.reported);
if (s2.lateReported !== 2) throw new Error('应有 2 台标记为离线补报，实际 ' + s2.lateReported);
if (getBatch().status !== 'completed') throw new Error('补报把未结束批次推到完成');

// 重复回传被标记且没有让任何一台算两次
if (!state.receiptLog.some((r: any) => r.id === 'retransmit-copy' && r.duplicate)) throw new Error('重复回传应被标记 duplicate');
// 每台设备台账里只剩一张、且为最新结果
for (const id of getBatch().deviceIds) {
  const ledgerEntry = state.ledgers['batch-demo'][id];
  if (!ledgerEntry || ledgerEntry.stage !== 'online') throw new Error(id + ' 台账应为最新 online');
}

/* ---------- 规则 4：阈值改动 → 进行中批次失效重算，台账保留、已装不重算 ---------- */
// batch2 用于 rejudge 纯函数断言（9 台，含失败构造）
const batch2: ReleaseBatch = {
  id: 'batch-2', name: '阈值重算试验', firmware: '3.0.0', rollbackVersion: '2.9.0',
  groupId: 'g-clinic', rolloutPercent: 50, failureThreshold: 5, status: 'draft',
  deviceIds: [], wave: 0, tallyVersion: 1, startedAt: null, updatedAt: new Date().toISOString()
};
const clinicDevices = state.devices.filter((d: any) => d.groupId === 'g-clinic');
batch2.deviceIds = clinicDevices.slice(0, 9).map((d: any) => d.id);
dispatch(createBatch({ batch: batch2 }));
dispatch(approveBatch({ id: 'batch-2', actor: 't' }));
dispatch(resumeBatch({ id: 'batch-2', actor: 't' }));
ticks(6);
console.log('batch2 初始：', JSON.stringify(stats('batch-2')), getBatch('batch-2').status);
if (stats('batch-2').reported < 9) throw new Error('9 台都应推进');

// 纯函数级验证 rejudge：构造 2/9 失败台账
const fakeLedger: Record<string, DeviceReceipt> = {};
for (let i = 0; i < 9; i++) {
  fakeLedger[batch2.deviceIds[i]] = {
    id: 'r' + i, batchId: 'batch-2', deviceId: batch2.deviceIds[i], gatewayId: 'gw',
    stage: i < 2 ? 'failed' : 'online', reportedAt: clock + i, receivedAt: clock + i,
    late: false, duplicate: false, voided: false
  };
}
if (rejudge(getBatch('batch-2'), fakeLedger, 'running') !== 'paused') throw new Error('失败率 2/9 > 5% 应暂停');
if (rejudge(getBatch('batch-2'), fakeLedger, 'paused') !== 'paused') throw new Error('普通补报不应让暂停自动恢复');
if (rejudge(getBatch('batch-2'), fakeLedger, 'paused', { recomputePaused: true }) !== 'paused') throw new Error('阈值仍超，重算也应暂停');

// reducer 级阈值流程需要一个不会自动完成的进行中批次：另取 6 台、只推进到 installing
const batch3: ReleaseBatch = {
  id: 'batch-3', name: '阈值重算 reducer 试验', firmware: '3.0.1', rollbackVersion: '2.9.0',
  groupId: 'g-clinic', rolloutPercent: 34, failureThreshold: 5, status: 'draft',
  deviceIds: [], wave: 0, tallyVersion: 1, startedAt: null, updatedAt: new Date().toISOString()
};
batch3.deviceIds = clinicDevices.slice(9, 15).map((d: any) => d.id);
dispatch(createBatch({ batch: batch3 }));
dispatch(approveBatch({ id: 'batch-3', actor: 't' }));
dispatch(resumeBatch({ id: 'batch-3', actor: 't' }));
ticks(3); // 6 台到 installing，installed=0，批次保持 running
console.log('batch3：', JSON.stringify(stats('batch-3')), getBatch('batch-3').status);
if (getBatch('batch-3').status !== 'running') throw new Error('batch3 应保持 running');

// 手工暂停后把阈值放宽 → 旧暂停判定失效，恢复发布；台账与已装台数不变
dispatch(pauseBatch({ id: 'batch-3', actor: 't' }));
const ledgerSnapshot = JSON.stringify(state.ledgers['batch-3']);
dispatch(updateThreshold({ id: 'batch-3', failureThreshold: 90, actor: 't' }));
if (getBatch('batch-3').status !== 'running') throw new Error('阈值放宽后旧暂停应失效恢复，实际 ' + getBatch('batch-3').status);
if (getBatch('batch-3').tallyVersion !== 2) throw new Error('tallyVersion 应递增');
if (JSON.stringify(state.ledgers['batch-3']) !== ledgerSnapshot) throw new Error('失效重算不得改动逐台台账');
const installedKept = stats('batch-3').installed;

// 再收紧（当前不足暂停样本 → 继续 running，但 tallyVersion 再递增，证明每次改动都触发重算）
dispatch(updateThreshold({ id: 'batch-3', failureThreshold: 0.0001, actor: 't' }));
if (getBatch('batch-3').tallyVersion !== 3) throw new Error('每次阈值改动都应失效重算');
if (stats('batch-3').installed !== installedKept) throw new Error('已装台数不应被重算');

/* ---------- 规则 5：紧急回滚 → 离线期间旧回执作废，已入台账封存 ---------- */
const gw2 = 'gw-clinic-2';
const gw2Devices = batch3.deviceIds.filter((id) => state.devices.find((d: any) => d.id === id).gatewayId === gw2);
console.log('gw-clinic-2 覆盖 batch3 设备', gw2Devices.length);
if (gw2Devices.length === 0) throw new Error('前置条件：该网关应覆盖 batch-3 设备');
dispatch(setGatewayOnline({ gatewayId: gw2, online: false, actor: 't' }));
// 手工塞缓冲模拟“离线期间旧回执”
const stale: DeviceReceipt = {
  id: 'stale-1', batchId: 'batch-3', deviceId: gw2Devices[0], gatewayId: gw2,
  stage: 'downloading', reportedAt: clock, receivedAt: clock, late: false, duplicate: false, voided: false
};
state = { ...state, offlineBuffers: { ...state.offlineBuffers, [gw2]: [stale] } };
const frozenLedger = JSON.stringify(state.ledgers['batch-3']);

dispatch(rollbackBatch({ id: 'batch-3', actor: 't' }));
if (getBatch('batch-3').status !== 'rolled_back') throw new Error('应为已回滚');
if ((state.offlineBuffers[gw2] ?? []).length !== 0) throw new Error('回滚后离线缓冲中的旧回执应作废清空');
if (!state.receiptLog.some((r: any) => r.id === 'stale-1' && r.voided)) throw new Error('旧回执应标记 voided');
if (JSON.stringify(state.ledgers['batch-3']) !== frozenLedger) throw new Error('回滚后已入台账应封存');

// 回网后即便有残余补报，终态批次也不再接收
dispatch(setGatewayOnline({ gatewayId: gw2, online: true, actor: 't' }));
ticks(3);
console.log('batch-3 作废回执', state.receiptLog.filter((r: any) => r.voided && r.batchId === 'batch-3').length);
if (JSON.stringify(state.ledgers['batch-3']) !== frozenLedger) throw new Error('回滚后任何回执都不得再改台账');

// 已完成批次（batch-demo）的迟到补报同样作废
const lateToDone: DeviceReceipt = {
  id: 'late-done', batchId: 'batch-demo', deviceId: getBatch().deviceIds[0], gatewayId: 'gw-edge-2',
  stage: 'downloading', reportedAt: clock - 1000, receivedAt: clock, late: true, duplicate: false, voided: false
};
state = { ...state, offlineBuffers: { ...state.offlineBuffers, ['gw-edge-2']: [lateToDone] } };
dispatch(setGatewayOnline({ gatewayId: 'gw-edge-2', online: false, actor: 't' }));
dispatch(setGatewayOnline({ gatewayId: 'gw-edge-2', online: true, actor: 't' }));
if (!state.receiptLog.some((r: any) => r.id === 'late-done' && r.voided)) throw new Error('已结束批次的迟到回执应作废');

console.log('ALL ASSERTIONS PASSED');
`;

const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'release-test-'));
fs.writeFileSync(path.join(dir, 'harness.js'), harness);
fs.writeFileSync(path.join(dir, 'test.ts'), test);

const shim = `
export function createReducer(initial, ...ons) {
  return (state = initial, action) => {
    for (const entry of ons) {
      if (entry.types.includes(action.type)) return entry.reducer(state, action);
    }
    return state;
  };
}
export function on(type, ...rest) {
  const reducer = rest[rest.length - 1];
  return { types: [type.type], reducer };
}
export function createAction(type, propsFactory) {
  const creator = (payload) => ({ type, ...payload });
  creator.type = type;
  return creator;
}
export function props() {
  return null;
}
`;
fs.writeFileSync(path.join(dir, 'ngrx-shim.mjs'), shim);

const esbuildPath = path.join(process.cwd(), 'node_modules', 'esbuild', 'bin', 'esbuild');
const bundle = path.join(dir, 'bundle.cjs');
const alias = '--alias:@ngrx/store=' + path.join(dir, 'ngrx-shim.mjs');
const built = spawnSync(esbuildPath, [path.join(dir, 'test.ts'), '--bundle', '--platform=node', '--format=cjs', '--outfile=' + bundle, '--log-level=warning', alias], { encoding: 'utf8' });
if (built.status !== 0) { console.error(built.stdout, built.stderr); process.exit(1); }
const run = spawnSync(process.execPath, ['-e', harness + "\nrequire('" + bundle + "');"], { encoding: 'utf8', cwd: process.cwd() });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
