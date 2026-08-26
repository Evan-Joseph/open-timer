/** 时钟主区：空闲 / 运行 / 暂停 / 结束反馈四态。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValue, useSpring, useReducedMotion } from 'motion/react';
import { Pause, Play, Square, Flag, Undo2 } from 'lucide-react';
import type { ClockStore } from '../lib/store.js';
import type { SyncAnchor } from '../lib/clock.js';
import { useMonotonicSeconds, useDualMonotonic, useWallSeconds, useBeijingTime, formatHms, formatHmsShort, formatDurationZh, formatBeijingTime, restPlanForFocus, restStageOf, restStageLabel } from '../lib/clock.js';
import { useAnimationsEnabled, useSettings } from '../lib/settings.js';
import { PREFS_APPLIED_EVT, schedulePrefsPush } from '../lib/prefs.js';
import { consumeConchStartMark } from '../lib/conch-mark.js';
import { playFinishChime, playAwayReminder } from '../lib/sound.js';
import { isQuietMinute } from '@clock/shared';

/* 逾期（L3）不再使用阻断式全屏召回弹窗：统一由红色洗色氛围 + away-line 文案表达。
   恢复/开始下一段的入口在常规控件里（继续计时 / 空闲页开始），无需独占弹窗。 */

function M({ children, ...props }: any) {
  const animationsEnabled = useAnimationsEnabled();
  if (!animationsEnabled) return <div {...props}>{children}</div>;
  return (
    <motion.div {...props} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
      {children}
    </motion.div>
  );
}

/** 休息进度环：复刻 Pomotroid TimerDial 的 dasharray/dashoffset 结构
 *  （Splode/pomotroid 2026 Svelte 重写版；原作以 tweened 800ms 补间，
 *  此处改 CSS transition 由每秒 awaySeconds tick 驱动）。弧度随休息额度消耗增长，颜色随级别。 */
function RestRing({ seconds, recommended }: { seconds: number; recommended: number }) {
  const R = 15.5;
  const C = 2 * Math.PI * R;
  const ratio = recommended > 0 ? Math.min(1, seconds / recommended) : 0;
  return (
    <svg className="rest-ring" viewBox="0 0 36 36" aria-hidden>
      <circle className="rest-ring-track" cx="18" cy="18" r={R} fill="none" strokeWidth="3" />
      <circle
        className="rest-ring-arc"
        cx="18"
        cy="18"
        r={R}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - ratio)}
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

/** 数字滚动：复刻 Magic UI number-ticker（useMotionValue + useSpring，damping 60 / stiffness 100）。
 *  二次开发：整数秒经 formatDurationZh 输出中文时长。 */
function DurationTicker({ seconds }: { seconds: number }) {
  const reduced = useReducedMotion();
  const animationsEnabled = useAnimationsEnabled();
  const skip = reduced || !animationsEnabled;
  const [display, setDisplay] = useState(skip ? seconds : 0);
  const motionValue = useMotionValue(0);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });
  useEffect(() => {
    if (!skip) motionValue.set(seconds);
  }, [motionValue, seconds, skip]);
  useEffect(() => {
    if (skip) return;
    return springValue.on('change', (latest) => setDisplay(Math.max(0, Math.round(latest))));
  }, [springValue, skip]);
  return <>{formatDurationZh(display)}</>;
}

/** 结束卡「本端已关闭不再提示」标记：`[sessionId, 本端stop时刻]`。
 *  本端 stop 时刻与服务端 ended_at 有 RTT 级偏差，水合匹配用 ±10s 容差。 */
const FINISH_DISMISS_KEY = 'clock-finish-dismissed';
function readFinishDismissed(): Array<{ id: string; t: number }> {
  try {
    return (JSON.parse(localStorage.getItem(FINISH_DISMISS_KEY) ?? '[]') as Array<[string, number]>)
      .filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number')
      .map(([id, t]) => ({ id, t }));
  } catch {
    return [];
  }
}
function markFinishDismissed(id: string, t: number): void {
  try {
    const arr = (JSON.parse(localStorage.getItem(FINISH_DISMISS_KEY) ?? '[]') as unknown[]).slice(-19);
    arr.push([id, t]);
    localStorage.setItem(FINISH_DISMISS_KEY, JSON.stringify(arr));
  } catch {
    /* 隐私模式静默 */
  }
}
function isFinishDismissed(id: string, endedAtMs: number): boolean {
  return readFinishDismissed().some((e) => e.id === id && Math.abs(e.t - endedAtMs) <= 10_000);
}

export default function ClockFace({ store }: { store: ClockStore }) {
  const { state, subjects, anchor, busy } = store;
  const active = state?.active_session ?? null;
  const settings = useSettings();
  /** 只读监督态：所有计时操作封死，仅展示（写端点本就要求 owner，这里是 UI 对齐） */
  const readOnly = store.phase === 'readonly';

  const seconds = useMonotonicSeconds(anchor);
  // 本段活跃秒（running 增长 / paused 冻结）：与总累计用同一 tick 同源计算，杜绝抢秒抖动
  const { total: totalSecs, seg: segmentSecs, prev: prevSecs } = useDualMonotonic(anchor, store.segmentAnchor, 1000);
  const beijing = useBeijingTime(anchor ? { serverNowMs: anchor.serverNowMs, anchorPerfMs: anchor.anchorPerfMs } : null);
  const readServerNowMs = useCallback(() => {
    if (anchor) return anchor.serverNowMs + Math.max(0, performance.now() - anchor.anchorPerfMs);
    return state?.server_now_ms ?? Date.now();
  }, [anchor, state?.server_now_ms]);

  /* ---------- 结束反馈 state（需先于离开提醒定义，两者耦合） ---------- */
  const [lastStopped, setLastStopped] = useState<{
    sessionId: string;
    subjectId: string;
    seconds: number;
    longestContinuousSeconds: number;
    focusSeconds: number;
    focusEndedAtMs: number;
  } | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  // 最近一次结束会话是空闲页休息状态的可恢复来源，刷新或关闭结束卡后仍保留提示。
  const recentStopped = useMemo(() => {
    return store.sessions
      .filter((session) => session.status === 'stopped' && session.ended_at)
      .sort((a, b) => Date.parse(b.ended_at!) - Date.parse(a.ended_at!))[0] ?? null;
  }, [store.sessions]);
  const recentFocusSeconds = useMemo(() => {
    if (typeof recentStopped?.last_continuous_seconds === 'number') {
      return recentStopped.last_continuous_seconds;
    }
    const segment = recentStopped?.segments.at(-1);
    if (!segment?.ended_at) return 0;
    return Math.max(0, Math.floor((Date.parse(segment.ended_at) - Date.parse(segment.started_at)) / 1000));
  }, [recentStopped]);
  const recentFocusEndMs = useMemo(() => {
    const segmentEnd = recentStopped?.last_continuous_ended_at ?? recentStopped?.segments.at(-1)?.ended_at;
    const endedMs = Date.parse(segmentEnd ?? recentStopped?.ended_at ?? '');
    return Number.isFinite(endedMs) ? endedMs : null;
  }, [recentStopped]);
  const recentRestAnchor = useMemo<SyncAnchor | null>(() => {
    if (recentFocusEndMs === null) return null;
    const endedMs = recentFocusEndMs;
    if (!Number.isFinite(endedMs)) return null;
    const serverNowMs = readServerNowMs();
    return {
      confirmedSeconds: Math.max(0, Math.floor((serverNowMs - endedMs) / 1000)),
      running: true,
      anchorPerfMs: performance.now(),
      serverNowMs,
    };
  }, [recentFocusEndMs, readServerNowMs]);

  /* ---------- 离开（暂停 / 科目结束后）渐进提醒 ---------- */
  const awayChimePlayedRef = useRef(false);                   // L2 提示音只播一次
  const overdueChimePlayedRef = useRef(false);                // L3 逾期升级音只播一次
  const [awayAnchorOverride, setAwayAnchorOverride] = useState<SyncAnchor | null>(null); // 结束态离开锚点
  const paused = active?.status === 'paused';
  /** 离开中 = 暂停中断 或 科目结束后（本质都是"人不在学习"） */
  const awayActive = paused || (!active && (lastStopped !== null || recentRestAnchor !== null));
  /** 离开计时锚点：暂停用服务端 paused_at；结束态用本组件在 stop 时记录的墙钟锚点 */
  const awayAnchor = awayActive ? (store.awayAnchor ?? awayAnchorOverride ?? recentRestAnchor) : null;
  const awaySeconds = useWallSeconds(awayAnchor, 1000);
  // 暂停和结束都只按刚结束的单段专注计算休息预算。
  const focusForRest = paused
    ? (active?.current_segment_active_seconds ?? 0)
    : (lastStopped?.focusSeconds ?? recentFocusSeconds);
  const restPlan = restPlanForFocus(focusForRest);
  const restStage = awayActive ? restStageOf(awaySeconds, restPlan) : 'resting';
  const awayLevel = awayActive ? (restStage === 'overdue' ? 3 : restStage === 'due' ? 2 : restStage === 'due-soon' ? 1 : 0) : 0;
  const beijingNow = new Date(readServerNowMs() + 8 * 60 * 60 * 1000);
  const quietPeriod = awayActive && isQuietMinute(beijingNow.getUTCHours() * 60 + beijingNow.getUTCMinutes());
  const reminderLevel = quietPeriod ? 0 : awayLevel;
  const restLabel = quietPeriod ? '静默中' : restStageLabel(restStage);
  // 离开状态复位：回到学习/开始新段后，下一轮离开重新开始提醒
  useEffect(() => {
    if (!awayActive) {
      awayChimePlayedRef.current = false;
      overdueChimePlayedRef.current = false;
      setAwayAnchorOverride(null);
    }
  }, [awayActive]);
  // 达到建议休息时长后单次轻音；浏览器需已交互，计时本身已满足 autoplay 前提。
  useEffect(() => {
    if (quietPeriod) {
      if (awayLevel >= 2) awayChimePlayedRef.current = true;
      return;
    }
    if (awayLevel >= 2 && !awayChimePlayedRef.current) {
      awayChimePlayedRef.current = true;
      playAwayReminder();
    }
  }, [awayLevel, quietPeriod]);
  // 进入逾期后再播放一次更明确的升级提示，避免持续循环声音造成惊扰。
  useEffect(() => {
    if (quietPeriod) {
      if (awayLevel >= 3) overdueChimePlayedRef.current = true;
      return;
    }
    if (awayLevel >= 3 && !overdueChimePlayedRef.current) {
      overdueChimePlayedRef.current = true;
      playAwayReminder(0.2);
    }
  }, [awayLevel, quietPeriod]);
  /* ---------- 动效升级（2026-08-24）：提醒级别跳变事件感 + 状态转换一次性 fx ---------- */

  const prevLevelRef = useRef(reminderLevel);
  const [levelPulseKey, setLevelPulseKey] = useState(0);
  useEffect(() => {
    if (reminderLevel > prevLevelRef.current) setLevelPulseKey((k) => k + 1);
    prevLevelRef.current = reminderLevel;
  }, [reminderLevel]);

  const phaseNow = active ? (paused ? 'paused' : 'running') : lastStopped ? 'finish' : 'idle';
  const prevPhaseRef = useRef(phaseNow);
  const [fx, setFx] = useState<{ kind: 'ignite' | 'settle' | 'recover'; key: number } | null>(null);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phaseNow;
    if (prev === phaseNow) return;
    const kind =
      prev === 'idle' && phaseNow === 'running'
        ? 'ignite'
        : prev === 'running' && phaseNow === 'paused'
          ? 'settle'
          : (prev === 'paused' || prev === 'finish') && phaseNow === 'running'
            ? 'recover'
            : null;
    if (kind) setFx((f) => ({ kind, key: (f?.key ?? 0) + 1 }));
  }, [phaseNow]);

  // 级别上升一次性注意力动效：away-line 敲击 + 全视口内缘闪光（降级时 CSS 隐藏）
  const awayLineCls = `away-line${reminderLevel >= 2 ? ' strong' : reminderLevel >= 1 ? ' urgent' : ''}${reminderLevel > 0 && levelPulseKey > 0 ? ' knock' : ''}`;
  const edgeFlash =
    reminderLevel >= 2 && levelPulseKey > 0 ? (
      <div
        key={`ef-${levelPulseKey}`}
        className={`edge-flash ${reminderLevel >= 3 ? 'edge-flash-l3' : 'edge-flash-l2'}`}
        aria-hidden
      />
    ) : null;

  /* 跨端结束卡：任一端结束会话未填结束备注时，其他端在 5 分钟窗口内
     也呈现同一张结束卡可补备注（确认后 end_note 落库，各端卡片随之消失）。
     seen 集合保证：本端已展示/已关闭的不重复弹出。 */
  const remoteStopSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (lastStopped) {
      remoteStopSeenRef.current.add(lastStopped.sessionId);
      return;
    }
    if (!store.isOwner) return; // 只读监督端只看时钟/休息，不伪装成可编辑的结束卡
    if (store.state?.active_session) return; // 运行/暂停中不水合旧结束卡，避免污染休息锚点
    const nowMs = store.state?.server_now_ms ?? Date.now();
    const cand = store.sessions
      .filter(
        (s) =>
          s.status === 'stopped' &&
          s.ended_at !== null &&
          !s.end_note &&
          nowMs - Date.parse(s.ended_at) <= 5 * 60_000 &&
          !remoteStopSeenRef.current.has(s.session_id) &&
          !isFinishDismissed(s.session_id, Date.parse(s.ended_at)),
      )
      .sort((a, b) => Date.parse(b.ended_at!) - Date.parse(a.ended_at!))[0];
    if (!cand) return;
    remoteStopSeenRef.current.add(cand.session_id);
    const endedMs = Date.parse(cand.last_continuous_ended_at ?? cand.ended_at!);
    setLastStopped({
      sessionId: cand.session_id,
      subjectId: cand.subject_id,
      // active_seconds 是按“当前北京日”裁剪的时间轴秒数；结束卡须用会话全量指标。
      seconds: cand.session_active_seconds,
      longestContinuousSeconds: cand.longest_continuous_seconds,
      focusSeconds: cand.last_continuous_seconds,
      focusEndedAtMs: endedMs,
    });
    setAwayAnchorOverride({
      confirmedSeconds: Math.max(0, (nowMs - endedMs) / 1000),
      running: true,
      anchorPerfMs: performance.now(),
      serverNowMs: nowMs,
    });
  }, [store.sessions, store.state?.server_now_ms, store.isOwner, lastStopped]);

  // 跨端收回：本端正在展示结束卡时，另一端可能已经补完备注或撤回。
  // 一旦最新 sessions 快照确认 end_note / voided，立即收卡回主页。
  useEffect(() => {
    if (!lastStopped) return;
    const latest = store.sessions.find((s) => s.session_id === lastStopped.sessionId);
    if (!latest || (latest.status !== 'voided' && !latest.end_note)) return;
    remoteStopSeenRef.current.add(lastStopped.sessionId);
    setLastStopped(null);
    setNoteDraft('');
    setAwayAnchorOverride(null);
  }, [lastStopped, store.sessions]);

  // 空闲态的全局轮询是 120s，但「等待补备注」是短暂协作状态。
  // 分段退避：前 30s 每 2s（跨端刚填完的及时收回），5min 内每 10s，之后每 30s；
  // 避免忘记关闭结束卡时持续烧 Workers 请求。
  useEffect(() => {
    if (!lastStopped) return;
    let cancelled = false;
    let timer: number | null = null;
    const openedAt = performance.now();
    const tick = async () => {
      await store.refresh();
      if (cancelled) return;
      const elapsed = performance.now() - openedAt;
      const delay = elapsed < 30_000 ? 2_000 : elapsed < 5 * 60_000 ? 10_000 : 30_000;
      timer = window.setTimeout(() => void tick(), delay);
    };
    timer = window.setTimeout(() => void tick(), 2_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [lastStopped, store.refresh]);

  const handleWithdrawLastStopped = async () => {
    if (!lastStopped) return;
    const ok = await store.withdraw(lastStopped.sessionId, '误记');
    if (!ok) return;
    setLastStopped(null);
    setAwayAnchorOverride(null);
    setNoteDraft('');
  };

  // 空闲态北京时间与"距上次专注"间隔（5s 步进，共用一个 interval）
  const [idleNowMs, setIdleNowMs] = useState(readServerNowMs);
  useEffect(() => {
    setIdleNowMs(readServerNowMs());
    const t = window.setInterval(() => setIdleNowMs(readServerNowMs()), 5000);
    return () => window.clearInterval(t);
  }, [readServerNowMs]);
  const idleTime = formatBeijingTime(idleNowMs);

  /* ---------- 结束反馈 ---------- */
  const [selectedSubject, setSelectedSubject] = useState<string>(
    () => localStorage.getItem('clock-last-subject') || 'math',
  );
  const [intentDraft, setIntentDraft] = useState('');
  /** 用户手动选过后，任何轮询/异步更新都不得再改变选择 */
  const userPickedRef = useRef(false);

  const pickSubject = useCallback((id: string) => {
    userPickedRef.current = true;
    setSelectedSubject(id);
    localStorage.setItem('clock-last-subject', id);
    schedulePrefsPush({ selectedSubject: id }); // 多端同步选中科目
  }, []);

  // 记住最近使用科目（下次进入直接默认）
  useEffect(() => {
    localStorage.setItem('clock-last-subject', selectedSubject);
  }, [selectedSubject]);

  // 多端同步：其他端选了科目（远端偏好到达）时跟随更新。
  // 这是显式同步语义，优先级高于本地轮询守卫（userPickedRef 只挡会话数据推断）。
  useEffect(() => {
    const reload = () => {
      const s = localStorage.getItem('clock-last-subject');
      if (s) setSelectedSubject(s);
    };
    window.addEventListener(PREFS_APPLIED_EVT, reload);
    return () => window.removeEventListener(PREFS_APPLIED_EVT, reload);
  }, []);

  // 仅当"从未手动选过且无本地记录"时，才用当天最后一个会话的科目作默认值（只发生一次）
  useEffect(() => {
    if (userPickedRef.current) return;
    if (localStorage.getItem('clock-last-subject')) return;
    if (store.sessions.length > 0) {
      userPickedRef.current = true; // 防止后续轮询再次改动
      setSelectedSubject(store.sessions[store.sessions.length - 1].subject_id);
    }
  }, [store.sessions]);

  const subjectOf = (id: string | null | undefined) => subjects.find((s) => s.subject_id === id);

  const handleStop = async () => {
    const pausedAtMs = active?.paused_at ? Date.parse(active.paused_at) : Number.NaN;
    const focusEndedAtMs = paused && Number.isFinite(pausedAtMs) ? pausedAtMs : readServerNowMs();
    const snapshot = active ? {
      sessionId: active.session_id,
      subjectId: active.subject_id,
      seconds,
      longestContinuousSeconds: segmentSecs,
      focusSeconds: segmentSecs,
      focusEndedAtMs,
    } : null;
    if (snapshot) {
      if (settings.finishSound) playFinishChime();
      setLastStopped(snapshot); // 立即呈现结束反馈（store.stop 内部乐观清空活动会话）
      // 海螺推荐开工的会话：结束备注预填推荐语（一次性标记）；其余清空草稿
      setNoteDraft(consumeConchStartMark(snapshot.sessionId) ?? '');
      // 从运行态结束时休息从 0 开始；从暂停态结束时沿用已经发生的休息。
      // 锚点用服务端校准时钟（与暂停态口径一致），不用本机 Date.now()——
      // 设备时钟偏移不得导致两种空闲态的休息计时快慢不同。
      setAwayAnchorOverride({
        confirmedSeconds: paused ? awaySeconds : 0,
        running: true,
        anchorPerfMs: performance.now(),
        serverNowMs: readServerNowMs(),
      });
    }
    const metrics = await store.stop(null);
    if (snapshot && metrics) {
      setLastStopped((current) => {
        if (!current || current.sessionId !== snapshot.sessionId) return current;
        const serverEndedAtMs = Date.parse(metrics.last_continuous_ended_at ?? metrics.ended_at ?? '');
        return {
          ...current,
          seconds: metrics.session_active_seconds,
          longestContinuousSeconds: metrics.longest_continuous_seconds,
          focusSeconds: metrics.last_continuous_seconds,
          // 从暂停结束时仍沿用已开始的休息锚点；运行态则以服务端最后连续段为准。
          focusEndedAtMs: paused || !Number.isFinite(serverEndedAtMs) ? current.focusEndedAtMs : serverEndedAtMs,
        };
      });
    }
  };

  /* ---------- 空格键主控（FocusTide/Pomotroid 共识：沉浸应用第一快捷键） ----------
     Space = 开始（空闲）/ 暂停（运行）/ 继续（暂停）；结束反馈卡上 = 确认关闭。
     输入框、弹层打开、修饰键组合时让位。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readOnly) return; // 只读监督态：空格主控整体让位
      if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (document.querySelector('[role="dialog"]')) return; // 设置/回顾弹层打开时让位
      e.preventDefault();
      if (lastStopped && !active) {
        // 结束反馈卡：确认关闭（等同「好，继续」）
        if (noteDraft.trim()) void store.setNote(lastStopped.sessionId, noteDraft.trim());
        markFinishDismissed(lastStopped.sessionId, lastStopped.focusEndedAtMs);
        setLastStopped(null);
        setNoteDraft('');
        return;
      }
      if (active?.status === 'running') void store.pause();
      else if (active?.status === 'paused') void store.resume();
      else if (!active) void store.start(selectedSubject, intentDraft || null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, lastStopped, noteDraft, selectedSubject, intentDraft, store, readOnly]);

  /* ---------- 结束反馈态 ---------- */
  if (lastStopped && !active) {
    const subj = subjectOf(lastStopped.subjectId);
    // 误触感知（参照 Clockify 阈值思路）：短于 10 秒的会话提示「是误触吗？」，
    // 并把「继续这段」提为唯一 primary——这是它唯一配得上强调的场景。
    const isMisfire = lastStopped.seconds < 10;
    return (
      <section className="clockface" data-away-level={reminderLevel} aria-live="polite">
        {edgeFlash}
        <M className="finish-card">
          <div className="finish-glow" aria-hidden />
          <div className="subject-pill" data-color={subj?.color_id}>
            <span className="pill-dot" aria-hidden />
            {subj?.display_name ?? lastStopped.subjectId}
          </div>
          {isMisfire ? (
            <>
              <div className="finish-big" data-testid="finish-duration">
                <DurationTicker seconds={lastStopped.seconds} />
              </div>
              <p className="finish-line">这段只有 {lastStopped.seconds} 秒，是误触吗？</p>
            </>
          ) : (
            <>
              <p className="finish-line">已记录本次投入。</p>
              <div className="finish-metrics" aria-label="本次专注指标">
                <div>
                  <span>本次总专注</span>
                  <strong className="finish-big" data-testid="finish-duration">
                    <DurationTicker seconds={lastStopped.seconds} />
                  </strong>
                </div>
                <div>
                  <span>最长连续专注</span>
                  <strong data-testid="finish-longest-continuous">{formatDurationZh(lastStopped.longestContinuousSeconds)}</strong>
                </div>
              </div>
              <p className="finish-context">今天累计 {formatDurationZh(state?.today_active_seconds ?? lastStopped.seconds)}</p>
            </>
          )}
          {/* 离开时长：科目结束后同样进入"已离开"渐进提醒（L1 琥珀 / L2 洗色 / L3 红色氛围） */}
          <div className="away-slot" aria-live="off">
            <div
              key={`al-${levelPulseKey}`}
              className={awayLineCls}
              data-testid="away-line"
            >
              <RestRing seconds={awaySeconds} recommended={restPlan.recommendedSeconds} />
              {restLabel} · 已休息 {formatHms(awaySeconds)}
              <span className="away-note"> · 建议 {formatDurationZh(restPlan.recommendedSeconds)}</span>
            </div>
          </div>
          <input
            className="finish-note"
            placeholder="补一句备注（可选）"
            value={noteDraft}
            maxLength={200}
            onChange={(e) => setNoteDraft(e.target.value)}
            aria-label="结束备注"
          />
          <div className="finish-actions action-row">
            <button
              className="ghost-btn"
              data-testid="finish-withdraw-btn"
              disabled={store.busy}
              onClick={() => void handleWithdrawLastStopped()}
            >
              <Undo2 size={14} aria-hidden /> 撤回这条
            </button>
            {/* 误触恢复：常规场景 ghost；<10s 短会话时提为 primary（唯一配得上强调的场景） */}
            <button
              className={isMisfire ? 'primary-btn' : 'ghost-btn'}
              data-testid="finish-resume-btn"
              disabled={store.busy}
              onClick={() => {
                if (noteDraft.trim()) void store.setNote(lastStopped.sessionId, noteDraft.trim());
                const sid = lastStopped.sessionId;
                setLastStopped(null);
                setNoteDraft('');
                void store.resumeSession(sid);
              }}
            >
              <Play size={isMisfire ? 18 : 14} aria-hidden /> 继续这段
            </button>
            <button
              className={isMisfire ? 'ghost-btn' : 'primary-btn'}
              onClick={() => {
                if (noteDraft.trim()) void store.setNote(lastStopped.sessionId, noteDraft.trim());
                markFinishDismissed(lastStopped.sessionId, lastStopped.focusEndedAtMs);
                setLastStopped(null);
                setNoteDraft('');
              }}
            >
              好，继续
            </button>
          </div>
        </M>
      </section>
    );
  }

  /* ---------- 运行 / 暂停态 ---------- */
  if (active) {
    const subj = subjectOf(active.subject_id);
    return (
      <section className={`clockface ${paused ? 'is-paused' : 'is-running'}`} data-away-level={reminderLevel}>
      {edgeFlash}
      {/* 状态转换一次性 fx：点火（开始）/帷幕（暂停）/回升（继续），key 重触发 */}
      {fx && ((fx.kind === 'settle' && paused) || (fx.kind !== 'settle' && !paused)) && (
        <span key={fx.key} className={`clock-fx fx-${fx.kind}`} aria-hidden />
      )}
        <div className="subject-pill large" data-color={subj?.color_id}>
          <span className="pill-dot" aria-hidden />
          {subj?.display_name ?? active.subject_id}
          <span className="pill-status">{paused ? '· 离开中' : '· 进行中'}</span>
        </div>

        <div className="big-timer" data-testid="timer-seconds" aria-live="off" aria-label={`累计 ${formatHms(totalSecs)}，本段 ${formatHmsShort(segmentSecs)}`}>
          {/* 首段（无已关闭段时 prev=0）不显示「前段 + 」前缀，避免 00:00:00 + 00:00 噪音 */}
          {prevSecs > 0 && (
            <>
              <span className="timer-prev" aria-hidden>{formatHms(prevSecs)}</span>
              <span className="timer-plus" aria-hidden>+</span>
            </>
          )}
          <span className="timer-seg">{formatHmsShort(segmentSecs)}</span>
        </div>

        <div className="sub-line">
          北京时间 {beijing} · 今天累计 {formatDurationZh(state?.today_active_seconds ?? 0)}
        </div>
        {active.intent_note && <div className="intent-line">「{active.intent_note}」</div>}

        {/* 离开时长：常驻占位（running 时空行），暂停/恢复瞬间不引起布局位移。
            渐进提醒：L1 琥珀描边 / L2 洗色 / L3 红色氛围（统一氛围表达，无阻断弹窗）。 */}
        <div className="away-slot" aria-live="off">
          {paused && (
            <div
              key={`al-${levelPulseKey}`}
              className={awayLineCls}
              data-testid="away-line"
            >
              <RestRing seconds={awaySeconds} recommended={restPlan.recommendedSeconds} />
              {restLabel} · 已休息 {formatHms(awaySeconds)}
              <span className="away-note"> · 建议 {formatDurationZh(restPlan.recommendedSeconds)}</span>
            </div>
          )}
        </div>

        {!readOnly && <div className="control-row">
          {paused ? (
            <button className="control-btn resume" onClick={store.resume} disabled={busy} aria-label="继续计时" title="继续">
              <Play size={24} />
            </button>
          ) : (
            <button className="control-btn pause" onClick={store.pause} disabled={busy} aria-label="暂停计时" title="暂停">
              <Pause size={24} />
            </button>
          )}
          <button className="control-btn stop" onClick={handleStop} disabled={busy} aria-label="结束并保存" title="结束并保存">
            <Square size={24} />
          </button>
        </div>}

        {/* 换科目：结束当前段并开启新段（只读监督态隐藏） */}
        {!readOnly && <details className="switch-subject">
          <summary>切换到其他科目</summary>
          <div className="switch-grid">
            {subjects
              .filter((s) => s.subject_id !== active.subject_id)
              .map((s) => (
                <button
                  key={s.subject_id}
                  className="switch-btn"
                  data-color={s.color_id}
                  onClick={() => store.switchSubject(s.subject_id)}
                  disabled={busy}
                >
                  <span className="pill-dot" aria-hidden />
                  {s.display_name}
                </button>
              ))}
          </div>
        </details>}
      </section>
  );
}

  /* ---------- 空闲态 ---------- */
  const recent = store.sessions.map((s) => s.subject_id);
  const ordered = [...subjects].sort((a, b) => {
    const ai = recent.indexOf(a.subject_id);
    const bi = recent.indexOf(b.subject_id);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.sort_order - b.sort_order;
  });

  return (
    <section className="clockface idle" data-away-level={reminderLevel}>
      {edgeFlash}
      <div className="idle-clock" data-testid="idle-clock" key={idleTime}>
        {idleTime}
      </div>
      <div className="idle-date">
        {new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full' }).format(new Date(idleNowMs))}
      </div>

      {recentRestAnchor && (
        <div className="away-slot idle-rest" aria-live="polite">
          <div
            key={`al-${levelPulseKey}`}
            className={awayLineCls}
            data-testid="idle-rest-line"
          >
            <RestRing seconds={awaySeconds} recommended={restPlan.recommendedSeconds} />
            {restLabel} · 已休息 {formatHms(awaySeconds)}
            <span className="away-note">· 建议 {formatDurationZh(restPlan.recommendedSeconds)}</span>
          </div>
        </div>
      )}

      {readOnly ? (
        <div className="readonly-block" data-testid="readonly-block">
          <div className="readonly-line">今天累计 {formatDurationZh(state?.today_active_seconds ?? 0)}</div>
          {recentStopped && (
            <div className="readonly-line readonly-sub">
              最近：{subjectOf(recentStopped.subject_id)?.display_name ?? recentStopped.subject_id}
              {recentStopped.note ? ` · 「${recentStopped.note}」` : ''}
            </div>
          )}
          <div className="readonly-hint">只读监督模式 · 点右上角锁图标解锁后可操作</div>
        </div>
      ) : (
        <>
      <div className="subject-picker" role="radiogroup" aria-label="选择科目">
        {ordered.map((s) => (
          <button
            key={s.subject_id}
            role="radio"
            aria-checked={selectedSubject === s.subject_id}
            className={`subject-chip ${selectedSubject === s.subject_id ? 'selected' : ''}`}
            data-color={s.color_id}
            onClick={() => pickSubject(s.subject_id)}
          >
            <span className="pill-dot" aria-hidden />
            {s.display_name}
          </button>
        ))}
      </div>

      <input
        className="intent-input"
        placeholder="本次想做什么？（可选）"
        value={intentDraft}
        maxLength={200}
        onChange={(e) => setIntentDraft(e.target.value)}
        aria-label="本次目标（可选）"
      />

      <button className="start-btn" data-testid="start-btn" disabled={busy} onClick={() => store.start(selectedSubject, intentDraft || null)}>
        <Flag size={20} aria-hidden /> 开始
      </button>

      <div className="today-hint">今天已记录 {formatDurationZh(state?.today_active_seconds ?? 0)}</div>
        </>
      )}
    </section>
  );
}
