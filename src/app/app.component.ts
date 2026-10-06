import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  approveBatch,
  createBatch,
  pauseBatch,
  resumeBatch,
  rollbackBatch,
  setGatewayOnline,
  telemetryTick,
  updateThreshold
} from './state/release.actions';
import {
  selectAudits,
  selectBatchViews,
  selectDevices,
  selectGateways,
  selectGroups,
  selectRecentReceipts,
  selectRelease,
  selectRolloutOverview,
  type BatchView
} from './state/release.selectors';
import type { Device, DeviceStage, ReleaseBatch } from './state/release.models';

const STAGE_LABEL: Record<DeviceStage, string> = {
  pending: '待发布',
  downloading: '下载中',
  downloaded: '已下载',
  installing: '安装中',
  installed: '已装好',
  rebooting: '重启中',
  online: '已上线',
  failed: '失败'
};

const STATUS_LABEL: Record<ReleaseBatch['status'], string> = {
  draft: '草稿',
  approved: '已审批',
  running: '发布中',
  paused: '已暂停',
  completed: '已完成',
  rolled_back: '已回滚'
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>逐台台账去重</mat-chip><mat-chip>离线回网补报合并</mat-chip><mat-chip>阈值改动失效重算</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batchViews$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已装/上线（去重台数）</span><strong>{{ overview().onlineDevices }}</strong></mat-card>
        <mat-card appearance="outlined"><span>离线补报并入台数</span><strong>{{ overview().lateReported }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已拦截重复回执</span><strong>{{ overview().dedupedReceipts }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <button mat-flat-button color="primary" (click)="create()">创建兼容批次</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="228" class="viewport">
              <article class="batch" *cdkVirtualFor="let view of batchViews$ | async">
                <div class="row">
                  <div><b>{{ view.batch.name }}</b><small>{{ view.batch.firmware }} → 回滚 {{ view.batch.rollbackVersion }} · {{ view.stats.target }} 台</small></div>
                  <mat-chip [color]="view.batch.status === 'paused' || view.batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ statusLabel(view.batch.status) }}</mat-chip>
                </div>
                <mat-progress-bar [color]="view.batch.status === 'paused' ? 'warn' : 'primary'" mode="determinate" [value]="view.stats.progress"></mat-progress-bar>
                <div class="row"><span>已装 {{ view.stats.installed }} 台 · 已下载 {{ view.stats.downloaded }} · 失败 {{ view.stats.failed }} · 去重回执 {{ view.stats.reported }}/{{ view.stats.target }}</span><span>{{ view.stats.progress }}%</span></div>
                <div class="row metrics">
                  <small>失败率 {{ view.stats.failureRate | number:'1.1-1' }}% / 阈值 {{ view.batch.failureThreshold }}%<ng-container *ngIf="view.stats.lateReported"> · 离线补报 {{ view.stats.lateReported }} 台已并入</ng-container></small>
                </div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="view.batch.status === 'draft'" (click)="approve(view.batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="view.batch.status === 'approved'" (click)="resume(view.batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="view.batch.status === 'running'" (click)="pause(view.batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="view.batch.status === 'paused'" (click)="resume(view.batch.id)">继续</button>
                  <ng-container *ngIf="view.batch.status === 'running' || view.batch.status === 'paused'">
                    <mat-form-field class="threshold" appearance="outline"><mat-label>改阈值 %</mat-label><input matInput type="number" [(ngModel)]="thresholdDrafts[view.batch.id]"></mat-form-field>
                    <button mat-stroked-button color="accent" (click)="changeThreshold(view)">改动阈值并重算</button>
                  </ng-container>
                  <button mat-flat-button color="warn" [disabled]="view.batch.status === 'completed' || view.batch.status === 'rolled_back'" (click)="rollback(view.batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>网关链路（模拟离线 / 回网补报）</mat-card-title></mat-card-header>
        <mat-card-content class="gateway-grid">
          <div class="gateway" *ngFor="let item of gateways$ | async" [class.offline]="!item.gateway.online">
            <div class="row">
              <div><b>{{ item.gateway.name }}</b><small>{{ item.groupName }} · {{ item.region }} · {{ item.deviceCount }} 台</small></div>
              <mat-chip [color]="item.gateway.online ? 'primary' : 'warn'" highlighted>{{ item.gateway.online ? '在线' : '离线' }}</mat-chip>
            </div>
            <small *ngIf="!item.gateway.online" class="buffer">离线期间积压回执 {{ item.buffered }} 张，回网时补报并入未结束批次</small>
            <div class="actions">
              <button mat-stroked-button *ngIf="item.gateway.online" (click)="setOnline(item.gateway.id, false)">模拟离线</button>
              <button mat-flat-button color="primary" *ngIf="!item.gateway.online" (click)="setOnline(item.gateway.id, true)">回网并补报</button>
            </div>
          </div>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>最近回执流水</mat-card-title></mat-card-header>
        <mat-card-content class="receipt-list">
          <div class="receipt" *ngFor="let receipt of recentReceipts$ | async">
            <span>{{ receipt.receivedAt | date:'HH:mm:ss' }}</span>
            <b>{{ receipt.deviceId }}</b>
            <span class="stage">{{ stageLabel(receipt.stage) }}</span>
            <span class="tag" *ngIf="receipt.late">离线补报</span>
            <span class="tag dup" *ngIf="receipt.duplicate">重复已去重</span>
            <span class="tag void" *ngIf="receipt.voided">已作废</span>
          </div>
          <p class="empty" *ngIf="(recentReceipts$ | async)?.length === 0">暂无回执，开始发布后在此观察每台设备的最新结果。</p>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:560px; } .batch { min-height:208px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap;align-items:center }
    .threshold { width:110px } .metrics { justify-content:flex-start }
    .gateway-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px }
    .gateway { border:1px solid #dde7e8; border-radius:10px; padding:12px; display:grid; gap:8px } .gateway.offline { border-color:#e0b4b4; background:#fdf3f3 } .buffer { color:#b35454 }
    .receipt-list { display:grid; gap:6px; max-height:260px; overflow:auto } .receipt { display:flex; gap:14px; align-items:center; border-bottom:1px solid #eef3f4; padding:6px 4px; font-size:13px }
    .receipt .stage { color:#0f6f6c; font-weight:600 } .tag { font-size:11px; padding:2px 8px; border-radius:10px; background:#fff3e0; color:#b26a00 } .tag.dup { background:#eef1f5; color:#5b6b7a } .tag.void { background:#fdecea; color:#b3261e }
    .empty { color:#8aa0a7 }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:460px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly devices$ = this.store.select(selectDevices);
  readonly batchViews$ = this.store.select(selectBatchViews);
  readonly gateways$ = this.store.select(selectGateways);
  readonly recentReceipts$ = this.store.select(selectRecentReceipts);
  readonly audits$ = this.store.select(selectAudits);
  private timer?: number;

  readonly overview = signal({ paused: 0, onlineDevices: 0, lateReported: 0, dedupedReceipts: 0 });
  private devices: Device[] = [];
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 25, failureThreshold: 5 };
  /** 每个进行中批次的阈值输入草稿，改动后批次立即失效重算 */
  thresholdDrafts: Record<string, number> = {};

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.store.select(selectRolloutOverview).subscribe((value) => this.overview.set(value));
    this.store.select(selectDevices).subscribe((devices) => (this.devices = devices));
    this.store.select(selectBatchViews).subscribe((views) => {
      for (const view of views) {
        this.thresholdDrafts[view.batch.id] ??= view.batch.failureThreshold;
      }
    });
    // 整份状态（含逐台台账与离线缓冲）持久化
    this.store.select(selectRelease).subscribe((release) => localStorage.setItem('firmware-release-v2', JSON.stringify(release)));
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  statusLabel(status: ReleaseBatch['status']) { return STATUS_LABEL[status]; }
  stageLabel(stage: DeviceStage) { return STAGE_LABEL[stage]; }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const groupId = this.draft.groupId;
    // 创建时冻结发布范围（跨网关均匀抽设备）
    const pool = this.devices.filter((device) => device.groupId === groupId);
    const target = Math.round((pool.length * this.draft.rolloutPercent) / 100);
    const deviceIds: string[] = [];
    for (let k = 0; k < target; k++) deviceIds.push(pool[Math.floor((k * pool.length) / target)].id);
    const batch: ReleaseBatch = {
      ...this.draft,
      id: crypto.randomUUID(),
      status: 'draft',
      deviceIds,
      wave: 0,
      tallyVersion: 1,
      startedAt: null,
      updatedAt: new Date().toISOString()
    };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  changeThreshold(view: BatchView) {
    const value = Number(this.thresholdDrafts[view.batch.id]);
    if (!Number.isFinite(value)) return;
    this.store.dispatch(updateThreshold({ id: view.batch.id, failureThreshold: value, actor: '运维值班' }));
  }
  setOnline(gatewayId: string, online: boolean) {
    this.store.dispatch(setGatewayOnline({ gatewayId, online, actor: '运维值班' }));
  }
}
