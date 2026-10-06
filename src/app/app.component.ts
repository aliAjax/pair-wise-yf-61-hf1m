import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { Observable, of } from 'rxjs';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { TranslocoPipe } from '@jsverse/transloco';
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, telemetryTick, updateThreshold } from './state/release.actions';
import { selectAudits, selectBatchLedger, selectBatches, selectGroups, selectOfflineDeviceCount, selectOnlineDeviceCount } from './state/release.selectors';
import type { Receipt, ReleaseBatch } from './state/release.models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>逐台进度账</mat-chip><mat-chip>回执按设备编号去重</mat-chip><mat-chip>离线补报合并</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>在线终端</span><strong>{{ onlineCount$ | async }}</strong></mat-card>
        <mat-card appearance="outlined"><span>离线终端</span><strong>{{ offlineCount$ | async }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ (audits$ | async)?.length ?? 0 }}</strong></mat-card>
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
            <cdk-virtual-scroll-viewport itemSize="176" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async">
                <div class="row"><div><b>{{ batch.name }}</b><small>{{ batch.firmware }} → 回滚 {{ batch.rollbackVersion }}</small></div><mat-chip-set><mat-chip [color]="batch.status === 'paused' || batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ batch.status }}</mat-chip><mat-chip *ngIf="batch.stale" color="accent" highlighted>阈值重算中</mat-chip></mat-chip-set></div>
                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row counts"><span>目标 {{ batch.target }} 台 · 已下载 {{ batch.downloaded }} · 已安装 {{ batch.installed }} · 失败 {{ batch.failed }}</span><span>{{ batch.progress }}%</span></div>
                <div class="threshold-row">
                  <mat-form-field appearance="outline" class="threshold-field"><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="batch.failureThreshold"></mat-form-field>
                  <button mat-stroked-button (click)="applyThreshold(batch)">应用阈值</button>
                </div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.status === 'completed' || batch.status === 'rolled_back'" (click)="rollback(batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>逐台进度账</mat-card-title><small>每台设备只留最新一条回执，按设备编号去重；离线补报合并进未结束批次，已装台数不重算</small></mat-card-header>
        <mat-card-content>
          <mat-form-field class="ledger-select"><mat-label>选择批次</mat-label><mat-select [ngModel]="ledgerBatchId" (ngModelChange)="showLedger($event)"><mat-option *ngFor="let batch of batches$ | async" [value]="batch.id">{{ batch.name }}</mat-option></mat-select></mat-form-field>
          <table class="ledger">
            <thead><tr><th>设备编号</th><th>设备分组</th><th>最新结果</th><th>上报时间</th><th>来源</th><th>状态</th></tr></thead>
            <tbody>
              <tr *ngFor="let receipt of ledger$ | async" [class.void]="!receipt.valid">
                <td>{{ receipt.deviceId }}</td>
                <td>{{ groupName(receipt) }}</td>
                <td><mat-chip [color]="receipt.result === 'failed' ? 'warn' : 'primary'" highlighted>{{ receipt.result }}</mat-chip></td>
                <td>{{ receipt.at | date:'MM-dd HH:mm:ss' }}</td>
                <td><mat-chip *ngIf="receipt.late" color="accent" highlighted>离线补报</mat-chip><span *ngIf="!receipt.late">在线回传</span></td>
                <td><mat-chip *ngIf="!receipt.valid" color="warn" highlighted>已作废</mat-chip><span *ngIf="receipt.valid && !receipt.merged">晚到未合并</span><span *ngIf="receipt.valid && receipt.merged">有效</span></td>
              </tr>
            </tbody>
          </table>
          <p *ngIf="(ledger$ | async)?.length === 0" class="empty">暂无回执</p>
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
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; flex-wrap:wrap; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .viewport { height:620px; } .batch { min-height:168px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .counts { color:#455a64; font-size:13px; } .threshold-row { display:flex;align-items:center;gap:8px } .threshold-field { width:150px }
    .ledger-select { width:280px; margin-top:8px } .ledger { width:100%; border-collapse:collapse; font-size:13px } .ledger th { text-align:left; color:#607d86; font-weight:600; padding:8px 10px; border-bottom:1px solid #dde7e8 } .ledger td { padding:8px 10px; border-bottom:1px solid #eef2f3 } .ledger tr.void { opacity:.55; text-decoration:line-through } .empty { color:#90a4ae; padding:16px 0 }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);
  readonly onlineCount$ = this.store.select(selectOnlineDeviceCount);
  readonly offlineCount$ = this.store.select(selectOfflineDeviceCount);
  ledger$: Observable<Receipt[]> = of([]);
  ledgerBatchId = '';
  private timer?: number;
  private groupNames: Record<string, string> = {};
  private batchGroupIds: Record<string, string> = {};
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.store.select(selectGroups).subscribe((groups) => {
      this.groupNames = Object.fromEntries(groups.map((group) => [group.id, group.name]));
    });
    this.store.select(selectBatches).subscribe((batches) => {
      this.batchGroupIds = Object.fromEntries(batches.map((batch) => [batch.id, batch.groupId]));
      if (!this.ledgerBatchId && batches.length > 0) {
        this.ledgerBatchId = batches[0].id;
        this.showLedger(batches[0].id);
      }
    });
    this.store.subscribe((state) => localStorage.setItem('firmware-release-v2', JSON.stringify(state)));
  }

  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  showLedger(id: string) {
    this.ledgerBatchId = id;
    this.ledger$ = this.store.select(selectBatchLedger(id));
  }

  groupName(receipt: Receipt): string {
    return this.groupNames[this.batchGroupIds[receipt.batchId]] ?? '-';
  }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const batch: ReleaseBatch = { ...this.draft, id: crypto.randomUUID(), status: 'draft', target: 0, progress: 0, downloaded: 0, installed: 0, failed: 0, stale: false, updatedAt: new Date().toISOString() };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }

  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }

  applyThreshold(batch: ReleaseBatch) {
    const value = Number(batch.failureThreshold);
    if (Number.isFinite(value) && value >= 0) this.store.dispatch(updateThreshold({ id: batch.id, failureThreshold: value, actor: '运维人员' }));
  }
}
