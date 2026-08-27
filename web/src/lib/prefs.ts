/**
 * 多端 UI 偏好同步（2026-08-21）。
 *
 * 范式（参照 Super Productivity sync/local-only-keys + Pomotroid 后端持久化）：
 * - localStorage 是即时层（零延迟渲染），服务端 user_pref 是跨设备事实层；
 * - last-write-wins，按服务端 updated_at_ms 取新；单用户无冲突对话框；
 * - 轮询搭车：独立 10s 间隔拉取（仅登录态），变更即应用到本地并广播；
 * - 本地变更防抖 500ms 推送；
 * - local-only 明确排除：ambientVolume（设备响度差异大，默认 0 不同步）、
 *   全屏态、reduced-motion 派生态、各类输入草稿、clock-last-subject（设备习惯）、
 *   浮层开合态 historyOpen/conchOpen（2026-08-24 下线：开合同步会让多端各自打开
 *   浮层重复发请求，海螺是昂贵 LLM 调用；开合态纯设备本地）。
 */

import type { AmbientKind } from './ambient.js';

export interface SyncedPrefs {
  theme: 'light' | 'dark' | 'auto';
  animations: boolean;
  finishSound: boolean;
  ambientKind: AmbientKind;
  timelineScale: 'default' | 'full-day';
  timelineMode: 'track' | 'list';
  /** 空闲页选中的科目（跨端跟随） */
  selectedSubject: string;
}
// 注意：浮层开合态（historyOpen/conchOpen）**不在**同步集合内——
// 2026-08-24 下线：开合同步会让多端各自打开浮层并重复发请求
// （海螺是昂贵 LLM 调用），开合态为设备本地（见各自 localStorage 键）。

const THEME_KEY = 'clock-theme';
const ANIM_KEY = 'clock-animations';
const SETTINGS_KEY = 'clock-settings-v2';
const SCALE_KEY = 'clock-timeline-scale';
const MODE_KEY = 'clock-timeline-mode';
const SUBJECT_KEY = 'clock-last-subject';
const HISTORY_KEY = 'clock-history-open';
const CONCH_KEY = 'clock-conch-open';
/** 远端偏好应用后广播：各组件重读本地键 */
export const PREFS_APPLIED_EVT = 'clock-prefs-applied';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等场景静默降级 */
  }
}

export function readLocalPrefs(): SyncedPrefs {
  let finishSound = false;
  let ambientKind: AmbientKind = 'none';
  try {
    const parsed = JSON.parse(safeGet(SETTINGS_KEY) ?? '{}');
    finishSound = parsed.finishSound === true;
    if (typeof parsed.ambientKind === 'string') ambientKind = parsed.ambientKind;
  } catch {
    /* 用默认值 */
  }
  const scale = safeGet(SCALE_KEY);
  const mode = safeGet(MODE_KEY);
  return {
    theme: (safeGet(THEME_KEY) as SyncedPrefs['theme']) || 'auto',
    animations: safeGet(ANIM_KEY) !== 'off',
    finishSound,
    ambientKind,
    timelineScale: scale === 'full-day' ? 'full-day' : 'default',
    timelineMode: mode === 'list' ? 'list' : 'track',
    selectedSubject: safeGet(SUBJECT_KEY) || '',
  };
}

function writeLocalTheme(theme: SyncedPrefs['theme']): void {
  safeSet(THEME_KEY, theme);
}

function writeLocalAnimations(on: boolean): void {
  safeSet(ANIM_KEY, on ? 'on' : 'off');
}

function writeLocalSettings(patch: { finishSound?: boolean; ambientKind?: AmbientKind }): void {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(safeGet(SETTINGS_KEY) ?? '{}');
  } catch {
    current = {};
  }
  if (patch.finishSound !== undefined) current.finishSound = patch.finishSound;
  if (patch.ambientKind !== undefined) current.ambientKind = patch.ambientKind;
  safeSet(SETTINGS_KEY, JSON.stringify(current));
}

/** 应用远端偏好到本地键；返回是否有实际变化（供广播/重渲染决策）。 */
export function applyRemotePrefs(remote: Partial<SyncedPrefs>): boolean {
  const local = readLocalPrefs();
  let changed = false;
  if (remote.theme && remote.theme !== local.theme) {
    writeLocalTheme(remote.theme);
    changed = true;
  }
  if (typeof remote.animations === 'boolean' && remote.animations !== local.animations) {
    writeLocalAnimations(remote.animations);
    changed = true;
  }
  if (typeof remote.finishSound === 'boolean' && remote.finishSound !== local.finishSound) {
    writeLocalSettings({ finishSound: remote.finishSound });
    changed = true;
  }
  if (remote.ambientKind && remote.ambientKind !== local.ambientKind) {
    writeLocalSettings({ ambientKind: remote.ambientKind });
    changed = true;
  }
  if (remote.timelineScale && remote.timelineScale !== local.timelineScale) {
    safeSet(SCALE_KEY, remote.timelineScale);
    changed = true;
  }
  if (remote.timelineMode && remote.timelineMode !== local.timelineMode) {
    safeSet(MODE_KEY, remote.timelineMode);
    changed = true;
  }
  if (remote.selectedSubject && remote.selectedSubject !== local.selectedSubject) {
    safeSet(SUBJECT_KEY, remote.selectedSubject);
    changed = true;
  }
  if (changed) window.dispatchEvent(new CustomEvent(PREFS_APPLIED_EVT));
  return changed;
}

/* ---------- 远端读写 ---------- */

let pushTimer: number | null = null;
/** 本地变更在途窗口：此期间拉取到的远端旧值不得覆盖本地新值（防回滚竞态） */
let dirtyUntilMs = 0;
/** 最近一次成功推送的服务端 updated_at_ms：拉取到的更早/同值不重复应用 */
let lastPushedUpdatedAt = 0;

async function fetchRemote(): Promise<{ prefs: Partial<SyncedPrefs> | null; updated_at_ms: number } | null> {
  try {
    const res = await fetch('/api/v1/prefs', { credentials: 'same-origin' });
    if (!res.ok) return null;
    return (await res.json()) as { prefs: Partial<SyncedPrefs> | null; updated_at_ms: number };
  } catch {
    return null;
  }
}

async function pushRemote(prefs: SyncedPrefs): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/prefs', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { updated_at_ms?: number };
    if (body.updated_at_ms) lastPushedUpdatedAt = body.updated_at_ms;
    dirtyUntilMs = 0;
    return true;
  } catch {
    return false;
  }
}

/** 本地偏好变更后调用：防抖 500ms 推送远端。overrides 覆盖瞬时态（如 historyOpen）。 */
export function schedulePrefsPush(overrides?: Partial<SyncedPrefs>): void {
  // 3s 在途窗口：覆盖防抖 + RTT；期间远端拉取不得回滚本地变更
  dirtyUntilMs = Date.now() + 3000;
  if (pushTimer !== null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    void pushRemote({ ...readLocalPrefs(), ...overrides });
  }, 500);
}

/** 7 天面板开合的本地持久化（同浏览器新标签页挂载时继承）。 */
export function setHistoryOpenLocal(open: boolean): void {
  safeSet(HISTORY_KEY, open ? '1' : '0');
}

/** AI assistant overlay open state is local to this browser. */
export function setConchOpenLocal(open: boolean): void {
  safeSet(CONCH_KEY, open ? '1' : '0');
}

/** 拉取并应用远端偏好；返回是否应用了变化。 */
export async function pullRemotePrefs(sinceUpdatedAt: number): Promise<number> {
  // 本地变更在途：跳过本轮拉取，防止旧远端值覆盖未推送的本地新值
  if (Date.now() < dirtyUntilMs) return sinceUpdatedAt;
  const remote = await fetchRemote();
  if (!remote || !remote.prefs) return sinceUpdatedAt;
  if (remote.updated_at_ms <= Math.max(sinceUpdatedAt, lastPushedUpdatedAt)) return sinceUpdatedAt;
  applyRemotePrefs(remote.prefs);
  return remote.updated_at_ms;
}
