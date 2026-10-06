import { createAction, props } from '@ngrx/store';
import type { ReleaseBatch } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatch }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());
/** 阈值改动：进行中（发布中/已暂停）的批次失效并按新阈值重算 */
export const updateThreshold = createAction(
  '[Release] Update failure threshold',
  props<{ id: string; failureThreshold: number; actor: string }>()
);
/** 手动切换网关在线/离线，离线时回执积压，回网时补报并入未结束批次 */
export const setGatewayOnline = createAction(
  '[Release] Set gateway online',
  props<{ gatewayId: string; online: boolean; actor: string }>()
);
export const telemetryTick = createAction('[Release] Telemetry tick');
