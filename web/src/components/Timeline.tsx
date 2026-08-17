/**
 * 底部日时间轴：可学习时段的固定尺度轨道 + 科目片段 + 当前信标。
 *
 * 交互模型（参考 FullCalendar nowIndicator/scrollTime 与 Toggl Track）：
 * - 信标随时间持续移动（30s 步进），不强制拖动视口（尊重用户手动浏览）；
 * - 初始加载 / 数据到位 / 点击「现在」/ 新会话开始：滚动使信标位于视口 60%；
 * - 切换到历史日：滚动到当日第一个片段（无片段则 08:00）；
 * - popover 用容器坐标（含滚动换算），Esc/点击外部/关闭按钮均可关；
 * - 已停止片段可在 popover 内一键撤回（void，服务端保留审计）。
 *
 * 数据：store.sessions 是"今天"的数据；查看历史日时按日期拉取（带轻量缓存）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock, LocateFixed, Undo2, X, List, GanttChart, CalendarDays } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ClockStore } from '../lib/store.js';
import type { DailySummaryApi, SessionApi } from '../lib/api.js';
import { apiGet } from '../lib/api.js';
import { formatBeijingTime, formatDurationZh } from '../lib/clock.js';
import { useAnimationsEnabled } from '../lib/settings.js';
import { LEARNING_DAY, QUIET_PERIODS, shanghaiDayRangeUtc, timelineRange, type TimelineScale } from '@clock/shared';

const NOW_TICK_MS = 30_000;

interface RenderSeg {
  key: string;
  sessionId: string;
  subjectId: string;
  colorId: string;
  displayName: string;
  startMinute: number;
  endMinute: number;
  startLabel: string;
  endLabel: string | null;
  seconds: number;
  running: boolean;
  /** 已停止（可撤回） */
  stopped: boolean;
  note: string | null;
}

/** 会话级行（弹窗/流水账共用）：一个 session 的所有段合并为一行 */
interface SessionRow {
  key: string;
  sessionId: string;
  subjectId: string;
  colorId: string;
  displayName: string;
  startLabel: string;
  endLabel: string | null;
  /** 当日净时长（各段裁剪后之和） */
  seconds: number;
  /** 当日段数（含休息拆分） */
  segCount: number;
  /** 会话仍进行中（今日含未结束段） */
  running: boolean;
  stopped: boolean;
  note: string | null;
}

function shiftDate(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function formatHistoryDuration(seconds: number): string {
  if (seconds <= 0) return '0';
  if (seconds < 3600) return `${Math.round(seconds / 60)}分`;
  const hours = seconds / 3600;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}小时`;
}

export default function Timeline({ store }: { store: ClockStore }) {
  const animationsEnabled = useAnimationsEnabled();
  const viewTransition = animationsEnabled ? { duration: 0.22, ease: [0.2, 0, 0, 1] as const } : { duration: 0 };
  const [viewDate, setViewDate] = useState(store.todayDate);
  const [popover, setPopover] = useState<{ row: SessionRow; containerX: number } | null>(null);
  const [hoverPreview, setHoverPreview] = useState<{ row: SessionRow; containerX: number } | null>(null);
  const [nowMs, setNowMs] = useState(() => store.state?.server_now_ms ?? Date.now());
  const [scale, setScale] = useState<TimelineScale>(() => {
    const saved = localStorage.getItem('clock-timeline-scale');
    return saved === 'full-day' ? saved : 'default';
  });
  const [mode, setMode] = useState<'track' | 'list'>('track');
  /** popover 内编辑备注 */
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [startDraft, setStartDraft] = useState('');
  const [startSaving, setStartSaving] = useState(false);
  /** 查看历史日时按日期拉取的会话数据 */
  const [historySessions, setHistorySessions] = useState<SessionApi[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySummaries, setHistorySummaries] = useState<DailySummaryApi[]>([]);
  const [historyWeekSessions, setHistoryWeekSessions] = useState<Map<string, SessionApi[]>>(new Map());
  const [historyLoading, setHistoryLoading] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const prevTodayRef = useRef(store.todayDate);
  /** 定位以 viewDateRef 为准，避免 effect 声明顺序导致的竞态 */
  const viewDateRef = useRef(viewDate);
  const activeSessionId = store.state?.active_session?.session_id ?? null;
  const prevActiveIdRef = useRef<string | null>(null);
  const historyCacheRef = useRef<Map<string, SessionApi[]>>(new Map());
  const syncedTodaySessionsRef = useRef(store.sessions);
  const historyReportRef = useRef<HTMLDivElement>(null);
  const autoScrolledHistoryRef = useRef(false);
  const hoverPreviewTimerRef = useRef<number | null>(null);

  const loadHistory = useCallback(async () => {
    if (historyLoading) return;
    setHistoryLoading(true);
    const dates = Array.from({ length: 7 }, (_, index) => shiftDate(store.todayDate, -index));
    const rows = await Promise.all(
      dates.map((date) => apiGet<DailySummaryApi>(`/api/v1/daily-summary?date=${date}&timezone=Asia%2FShanghai`).catch(() => ({
        date,
        total_active_seconds: 0,
        by_subject: [],
      }))),
    );
    const sessions = await Promise.all(
      dates.map(async (date) => {
        // 当天会话会继续变化，不可复用历史缓存。
        if (date === store.todayDate) {
          const result = await apiGet<{ sessions: SessionApi[] }>(`/api/v1/sessions?date=${date}`).catch(() => ({ sessions: [] }));
          return [date, result.sessions] as const;
        }
        const cached = historyCacheRef.current.get(date);
        if (cached) return [date, cached] as const;
        const result = await apiGet<{ sessions: SessionApi[] }>(`/api/v1/sessions?date=${date}`).catch(() => ({ sessions: [] }));
        historyCacheRef.current.set(date, result.sessions);
        return [date, result.sessions] as const;
      }),
    );
    setHistorySummaries(rows);
    setHistoryWeekSessions(new Map(sessions));
    setHistoryLoading(false);
  }, [historyLoading, store.todayDate]);

  // 回顾展开期间结束、撤回或调整会话时，立即同步当天泳道。
  useEffect(() => {
    if (syncedTodaySessionsRef.current === store.sessions) return;
    syncedTodaySessionsRef.current = store.sessions;
    if (!historyOpen) return;
    setHistoryWeekSessions((previous) => {
      const next = new Map(previous);
      next.set(store.todayDate, store.sessions);
      return next;
    });
  }, [historyOpen, store.sessions, store.todayDate]);

  const readServerNowMs = useCallback(() => {
    if (store.anchor) {
      return store.anchor.serverNowMs + Math.max(0, performance.now() - store.anchor.anchorPerfMs);
    }
    return store.state?.server_now_ms ?? Date.now();
  }, [store.anchor, store.state?.server_now_ms]);

  // 信标持续移动（30s 步进）：服务端时间外推，不触发强制滚动。
  useEffect(() => {
    setNowMs(readServerNowMs());
    const t = window.setInterval(() => setNowMs(readServerNowMs()), NOW_TICK_MS);
    return () => window.clearInterval(t);
  }, [readServerNowMs]);

  // 跨午夜：若用户停留在"旧的今天"，跟随到新的今天
  useEffect(() => {
    if (prevTodayRef.current !== store.todayDate) {
      setViewDate((prev) => (prev === prevTodayRef.current ? store.todayDate : prev));
      prevTodayRef.current = store.todayDate;
    }
  }, [store.todayDate]);

  const isToday = viewDate === store.todayDate;
  // 时间逻辑单一来源：shared/shanghai.ts（与服务端日切同一实现）
  const { startMs, endMs } = useMemo(() => shanghaiDayRangeUtc(viewDate), [viewDate]);

  // 当前视图数据源：今天用 store.sessions（实时轮询），历史日按日期拉取（缓存 5 分钟由轮询天然刷新）
  const dateSessions = useMemo(() => {
    if (isToday) return store.sessions;
    return historySessions;
  }, [isToday, store.sessions, historySessions]);

  // 历史日数据拉取
  useEffect(() => {
    if (isToday) return;
    const cached = historyCacheRef.current.get(viewDate);
    if (cached) {
      setHistorySessions(cached);
      return;
    }
    let cancelled = false;
    apiGet<{ sessions: SessionApi[] }>(`/api/v1/sessions?date=${viewDate}`)
      .then((d) => {
        if (cancelled) return;
        historyCacheRef.current.set(viewDate, d.sessions);
        setHistorySessions(d.sessions);
      })
      .catch(() => {
        if (!cancelled) setHistorySessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [viewDate, isToday]);

  // 切换日期：关闭 popover、允许重新定位（同步更新 ref，供定位 effect 读取）
  useEffect(() => {
    viewDateRef.current = viewDate;
    setPopover(null);
    setHoverPreview(null);
  }, [viewDate]);

  const segs: RenderSeg[] = useMemo(() => {
    const out: RenderSeg[] = [];
    const nowClamped = Math.min(nowMs, endMs);
    for (const s of dateSessions) {
      if (s.status === 'voided') continue;
      const subj = store.subjects.find((x) => x.subject_id === s.subject_id);
      for (let i = 0; i < s.segments.length; i++) {
        const seg = s.segments[i];
        const segStart = Date.parse(seg.started_at);
        const segEnd = seg.ended_at ? Date.parse(seg.ended_at) : nowClamped;
        if (segEnd <= startMs || segStart >= endMs) continue;
        const cs = Math.max(segStart, startMs);
        const ce = Math.min(segEnd, endMs);
        out.push({
          key: `${s.session_id}-${i}`,
          sessionId: s.session_id,
          subjectId: s.subject_id,
          colorId: subj?.color_id ?? 'blue',
          displayName: subj?.display_name ?? s.subject_id,
          startMinute: (cs - startMs) / 60_000,
          endMinute: (ce - startMs) / 60_000,
          startLabel: formatBeijingTime(cs),
          endLabel: seg.ended_at ? formatBeijingTime(ce) : null,
          seconds: Math.floor((ce - cs) / 1000),
          running: seg.ended_at === null && isToday,
          stopped: s.status === 'stopped',
          note: s.note,
        });
      }
    }
    return out.sort((a, b) => a.startMinute - b.startMinute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateSessions, store.subjects, startMs, endMs, isToday, Math.floor(nowMs / NOW_TICK_MS)]);

  const anchorMinute = isToday
    ? Math.min(LEARNING_DAY.endMinute, Math.max(LEARNING_DAY.startMinute, (nowMs - startMs) / 60_000))
    : (segs[0]?.startMinute ?? (LEARNING_DAY.startMinute + LEARNING_DAY.endMinute) / 2);
  const visibleRange = useMemo(
    () => timelineRange(scale, anchorMinute),
    [scale, anchorMinute],
  );
  const visibleMinutes = visibleRange.endMinute - visibleRange.startMinute;
  const minuteToPercent = useCallback(
    (minute: number) => ((minute - visibleRange.startMinute) / visibleMinutes) * 100,
    [visibleRange.startMinute, visibleMinutes],
  );
  const visibleSegs = useMemo(
    () => segs.filter((seg) => seg.endMinute > visibleRange.startMinute && seg.startMinute < visibleRange.endMinute),
    [segs, visibleRange],
  );
  /** 会话级分组：一个 session 的所有段合并为一行（弹窗/流水账共用数据源）。 */
  const sessionRows: SessionRow[] = useMemo(() => {
    const out: SessionRow[] = [];
    const nowClamped = Math.min(nowMs, endMs);
    for (const s of dateSessions) {
      if (s.status === 'voided') continue;
      const subj = store.subjects.find((x) => x.subject_id === s.subject_id);
      // 当日可见段（按日裁剪）
      const parts: Array<{ cs: number; ce: number; open: boolean }> = [];
      for (const seg of s.segments) {
        const segStart = Date.parse(seg.started_at);
        const segEnd = seg.ended_at ? Date.parse(seg.ended_at) : nowClamped;
        if (segEnd <= startMs || segStart >= endMs) continue;
        parts.push({
          cs: Math.max(segStart, startMs),
          ce: Math.min(segEnd, endMs),
          open: seg.ended_at === null && isToday,
        });
      }
      if (parts.length === 0) continue;
      parts.sort((a, b) => a.cs - b.cs);
      const seconds = parts.reduce((acc, p) => acc + Math.max(0, p.ce - p.cs), 0) / 1000;
      const running = parts[parts.length - 1].open;
      out.push({
        key: s.session_id,
        sessionId: s.session_id,
        subjectId: s.subject_id,
        colorId: subj?.color_id ?? 'blue',
        displayName: subj?.display_name ?? s.subject_id,
        startLabel: formatBeijingTime(parts[0].cs),
        endLabel: running ? null : formatBeijingTime(parts[parts.length - 1].ce),
        seconds: Math.floor(seconds),
        segCount: parts.length,
        running,
        stopped: s.status === 'stopped',
        note: s.note,
      });
    }
    return out.sort((a, b) => a.startLabel.localeCompare(b.startLabel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateSessions, store.subjects, startMs, endMs, isToday, Math.floor(nowMs / NOW_TICK_MS)]);
  /** render 期同步，供 openPopover 等 useCallback 读取最新分组 */
  const sessionRowsRef = useRef<SessionRow[]>([]);
  sessionRowsRef.current = sessionRows;

  const scrollToNow = useCallback(() => {
    setScale('default');
    localStorage.setItem('clock-timeline-scale', 'default');
  }, []);

  // 新会话开始：平滑滚到信标（片段正在生长）
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevActiveIdRef.current) {
      const t = window.setTimeout(() => {
        if (viewDateRef.current === store.todayDate) scrollToNow();
      }, 150);
      prevActiveIdRef.current = activeSessionId;
      return () => window.clearTimeout(t);
    }
    prevActiveIdRef.current = activeSessionId;
  }, [activeSessionId, scrollToNow, store.todayDate]);

  const ticks = useMemo(() => {
    const values = [visibleRange.startMinute];
    const step = scale === 'full-day' ? 120 : 60;
    for (let minute = Math.ceil(visibleRange.startMinute / step) * step; minute < visibleRange.endMinute; minute += step) {
      if (minute > visibleRange.startMinute) values.push(minute);
    }
    values.push(visibleRange.endMinute);
    return values.map((minute) => ({
      minute,
      label: `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(Math.round(minute) % 60).padStart(2, '0')}`,
      leftPercent: minuteToPercent(minute),
      major: minute % 60 === 0,
    }));
  }, [minuteToPercent, scale, visibleRange]);

  const nowPercent = minuteToPercent(Math.min(Math.max((nowMs - startMs) / 60_000, visibleRange.startMinute), visibleRange.endMinute));

  const previewPositionForSeg = useCallback((seg: RenderSeg) => {
    const track = trackRef.current;
    const timeline = track?.closest('.timeline') as HTMLElement | null;
    if (!track || !timeline) return 0;
    const trackRect = track.getBoundingClientRect();
    const timelineRect = timeline.getBoundingClientRect();
    return trackRect.left - timelineRect.left + minuteToPercent((seg.startMinute + seg.endMinute) / 2) / 100 * trackRect.width;
  }, [minuteToPercent]);

  /** 点击固定会话详情；编辑与撤回只存在于固定态。 */
  const openPopover = useCallback((seg: RenderSeg) => {
    const row = sessionRowsRef.current.find((r) => r.sessionId === seg.sessionId);
    if (!row) return;
    if (hoverPreviewTimerRef.current !== null) window.clearTimeout(hoverPreviewTimerRef.current);
    setHoverPreview(null);
    setNoteDraft(seg.note ?? '');
    setStartDraft(row.startLabel);
    setNoteSaving(false);
    setPopover({ row, containerX: previewPositionForSeg(seg) });
  }, [previewPositionForSeg]);

  const scheduleHoverPreview = useCallback((seg: RenderSeg) => {
    if (popover) return;
    if (hoverPreviewTimerRef.current !== null) window.clearTimeout(hoverPreviewTimerRef.current);
    hoverPreviewTimerRef.current = window.setTimeout(() => {
      const row = sessionRowsRef.current.find((item) => item.sessionId === seg.sessionId);
      if (row) setHoverPreview({ row, containerX: previewPositionForSeg(seg) });
    }, 180);
  }, [popover, previewPositionForSeg]);

  const dismissHoverPreview = useCallback(() => {
    if (hoverPreviewTimerRef.current !== null) window.clearTimeout(hoverPreviewTimerRef.current);
    hoverPreviewTimerRef.current = null;
    setHoverPreview(null);
  }, []);

  useEffect(() => () => {
    if (hoverPreviewTimerRef.current !== null) window.clearTimeout(hoverPreviewTimerRef.current);
  }, []);

  /** 流水账整行点击：以行元素在 .timeline 容器中的水平中心定位弹窗。 */
  const openRowPopover = useCallback((row: SessionRow, anchor: HTMLElement) => {
    setNoteDraft(row.note ?? '');
    setStartDraft(row.startLabel);
    setNoteSaving(false);
    const container = anchor.closest('.timeline') as HTMLElement | null;
    if (!container) {
      setPopover({ row, containerX: 0 });
      return;
    }
    const cr = container.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    setPopover({ row, containerX: ar.left - cr.left + ar.width / 2 });
  }, []);

  // Esc / 点击外部关闭 popover
  useEffect(() => {
    if (!popover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopover(null);
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest('.seg-popover') && !el.closest('.seg-hit')) setPopover(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [popover]);

  // 撤回
  const handleWithdraw = useCallback(async () => {
    if (!popover) return;
    const ok = await store.withdraw(popover.row.sessionId, '误记');
    if (ok) {
      setPopover(null);
      // 历史日缓存同步失效
      historyCacheRef.current.delete(viewDateRef.current);
    }
  }, [popover, store]);

  // 保存备注
  const handleSaveNote = useCallback(async () => {
    if (!popover || noteSaving) return;
    setNoteSaving(true);
    await store.setNote(popover.row.sessionId, noteDraft.trim());
    setNoteSaving(false);
    // 关闭并失效历史缓存，让新备注显现
    setPopover(null);
    historyCacheRef.current.delete(viewDateRef.current);
  }, [popover, noteSaving, noteDraft, store]);

  const handleSaveStart = useCallback(async () => {
    if (!popover || startSaving || !/^\d{2}:\d{2}$/.test(startDraft)) return;
    setStartSaving(true);
    const ok = await store.adjustStart(popover.row.sessionId, `${viewDateRef.current}T${startDraft}:00+08:00`);
    setStartSaving(false);
    if (ok) {
      setPopover(null);
      historyCacheRef.current.delete(viewDateRef.current);
    }
  }, [popover, startDraft, startSaving, store]);

  // 当日（viewDate）各科小计：跟随所看日期
  const overview = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of dateSessions) {
      if (s.status === 'voided') continue;
      map.set(s.subject_id, (map.get(s.subject_id) ?? 0) + s.active_seconds);
    }
    return [...map.entries()]
      .map(([subject_id, seconds]) => ({ subject_id, seconds }))
      .sort((a, b) => b.seconds - a.seconds);
  }, [dateSessions]);

  const totalSeconds = overview.reduce((a, b) => a + b.seconds, 0);

  const historyModel = useMemo(() => {
    const current = [...historySummaries].sort((a, b) => a.date.localeCompare(b.date));
    const total = current.reduce((sum, day) => sum + day.total_active_seconds, 0);
    const maxDay = Math.max(0, ...current.map((day) => day.total_active_seconds));
    const subjectSeconds = new Map<string, number>();
    for (const day of current) {
      for (const item of day.by_subject) {
        subjectSeconds.set(item.subject_id, (subjectSeconds.get(item.subject_id) ?? 0) + item.active_seconds);
      }
    }
    const subjects = [...subjectSeconds.entries()]
      .filter(([, seconds]) => seconds > 0)
      .map(([subjectId, seconds]) => {
        const subject = store.subjects.find((item) => item.subject_id === subjectId);
        return {
          subjectId,
          seconds,
          label: subject?.display_name ?? subjectId,
          colorId: subject?.color_id ?? 'blue',
          share: total > 0 ? seconds / total : 0,
        };
      })
      .sort((a, b) => b.seconds - a.seconds);
    return { current, total, dailyAverage: Math.round(total / 7), maxDay, subjects };
  }, [historySummaries, store.subjects]);

  const weekdayLabel = (date: string) => {
    const [year, month, day] = date.split('-').map(Number);
    return new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
  };

  const historyLanes = useMemo(() => historyModel.current.map((day) => {
    const { startMs: dayStart, endMs: dayEnd } = shanghaiDayRangeUtc(day.date);
    const segments = (historyWeekSessions.get(day.date) ?? []).flatMap((session) => {
      if (session.status === 'voided') return [];
      const subject = store.subjects.find((item) => item.subject_id === session.subject_id);
      return session.segments.flatMap((segment, index) => {
        if (!segment.ended_at) return [];
        const start = Math.max(dayStart, Date.parse(segment.started_at));
        const end = Math.min(dayEnd, Date.parse(segment.ended_at));
        if (end <= start) return [];
        const startMinute = (start - dayStart) / 60_000;
        const endMinute = (end - dayStart) / 60_000;
        if (endMinute <= LEARNING_DAY.startMinute || startMinute >= LEARNING_DAY.endMinute) return [];
        return [{
          key: `${session.session_id}-${index}`,
          colorId: subject?.color_id ?? 'blue',
          left: ((Math.max(startMinute, LEARNING_DAY.startMinute) - LEARNING_DAY.startMinute) / (LEARNING_DAY.endMinute - LEARNING_DAY.startMinute)) * 100,
          width: Math.max(0.35, ((Math.min(endMinute, LEARNING_DAY.endMinute) - Math.max(startMinute, LEARNING_DAY.startMinute)) / (LEARNING_DAY.endMinute - LEARNING_DAY.startMinute)) * 100),
        }];
      });
    });
    return { ...day, segments };
  }), [historyModel.current, historyWeekSessions, store.subjects]);

  const visibleQuietPeriods = useMemo(() => QUIET_PERIODS.flatMap((period) => {
    const startMinute = Math.max(period.startMinute, visibleRange.startMinute);
    const endMinute = Math.min(period.endMinute, visibleRange.endMinute);
    if (endMinute <= startMinute) return [];
    return [{
      ...period,
      left: minuteToPercent(startMinute),
      width: minuteToPercent(endMinute) - minuteToPercent(startMinute),
    }];
  }), [minuteToPercent, visibleRange.endMinute, visibleRange.startMinute]);

  useEffect(() => {
    if (!historyOpen || historyLoading || autoScrolledHistoryRef.current) return;
    autoScrolledHistoryRef.current = true;
    const id = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      });
    });
    return () => window.cancelAnimationFrame(id);
  }, [historyOpen, historyLoading, historyLanes]);

  return (
    <section className="timeline" aria-label="时间轴">
      <div className="timeline-head">
        <h2 className="timeline-title">
          {historyOpen ? '近 7 天执行回顾' : `时间轴 · ${viewDate}`}
          {!historyOpen && totalSeconds > 0 && <span className="timeline-total"> · 共 {formatDurationZh(totalSeconds)}</span>}
        </h2>
        <div className="timeline-nav">
          {!historyOpen && <button
            className="icon-btn"
            aria-label={mode === 'track' ? '切换到流水账视图' : '切换到时间轴视图'}
            title={mode === 'track' ? '流水账' : '时间轴'}
            onClick={() => setMode(mode === 'track' ? 'list' : 'track')}
            data-testid="timeline-mode-btn"
          >
            {mode === 'track' ? <List size={16} /> : <GanttChart size={16} />}
          </button>}
          {!historyOpen && <button className="icon-btn" aria-label="前一天" onClick={() => setViewDate(shiftDate(viewDate, -1))}>
            <ChevronLeft size={16} />
          </button>}
          {!historyOpen && (isToday ? (
            <button className="text-btn now-btn" onClick={scrollToNow} aria-label="滚动到当前时间" data-testid="scroll-now-btn">
              <LocateFixed size={14} aria-hidden /> 现在
            </button>
          ) : (
            <button className="text-btn" onClick={() => setViewDate(store.todayDate)}>
              回今天
            </button>
          ))}
          {!historyOpen && <button className="icon-btn" aria-label="后一天" onClick={() => setViewDate(shiftDate(viewDate, 1))} disabled={isToday}>
            <ChevronRight size={16} />
          </button>}
          <button
            className={`icon-btn ${historyOpen ? 'selected' : ''}`}
            aria-label="近 7 天回顾"
            title="近 7 天回顾"
            onClick={() => {
              const next = !historyOpen;
              setHistoryOpen(next);
              if (next) {
                autoScrolledHistoryRef.current = false;
                void loadHistory();
              }
            }}
            data-testid="history-toggle"
          >
            <CalendarDays size={16} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
      {historyOpen && (
        <motion.div
          key="week"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={viewTransition}
        >
        <div className="history-strip" data-testid="history-strip" ref={historyReportRef}>
          <div className="history-strip-head">
            <strong>{historyModel.current[0]?.date.slice(5)} – {historyModel.current.at(-1)?.date.slice(5)}</strong>
          </div>
          {historyLoading ? <div className="history-empty">正在读取…</div> : (
            <div className="history-report">
              <div className="history-metrics" aria-label="近 7 天汇总">
                <div><span>总计</span><strong>{formatDurationZh(historyModel.total)}</strong></div>
                <div><span>日均</span><strong>{formatDurationZh(historyModel.dailyAverage)}</strong></div>
                <div><span>最长一天</span><strong>{formatDurationZh(historyModel.maxDay)}</strong></div>
              </div>
              <div className="history-lanes" role="list" aria-label="近 7 天固定全天泳道">
                <div className="history-axis" aria-hidden>
                  <span />
                  <div className="history-axis-track">
                    <span className="axis-start">08:00</span>
                    <span style={{ left: '27.586%' }}>12:00</span>
                    <span style={{ left: '55.172%' }}>16:00</span>
                    <span style={{ left: '82.759%' }}>20:00</span>
                    <span className="axis-end">22:30</span>
                  </div>
                </div>
                {historyLanes.map((day) => (
                  <div key={day.date} className="history-lane" role="listitem" aria-label={`${day.date}，执行 ${formatDurationZh(day.total_active_seconds)}`}>
                    <div className="history-lane-label">
                      <strong>{day.date === store.todayDate ? '今天' : weekdayLabel(day.date)}</strong>
                      <span>{day.date.slice(5)} · {formatHistoryDuration(day.total_active_seconds)}</span>
                    </div>
                    <div className="history-lane-track">
                      {QUIET_PERIODS.map((period) => (
                        <span
                          key={period.id}
                          className="history-quiet-period"
                          style={{
                            left: `${((period.startMinute - LEARNING_DAY.startMinute) / (LEARNING_DAY.endMinute - LEARNING_DAY.startMinute)) * 100}%`,
                            width: `${((period.endMinute - period.startMinute) / (LEARNING_DAY.endMinute - LEARNING_DAY.startMinute)) * 100}%`,
                          }}
                          title={`${period.label}静默时段`}
                        >{period.label}</span>
                      ))}
                      {day.segments.map((segment) => (
                        <span key={segment.key} className="history-lane-segment" data-color={segment.colorId} style={{ left: `${segment.left}%`, width: `${segment.width}%` }} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {historyModel.subjects.length > 0 && (
                <div className="history-subjects" aria-label="近 7 天科目分布">
                  <div className="history-subject-bar" aria-hidden>
                    {historyModel.subjects.map((subject) => (
                      <span key={subject.subjectId} data-color={subject.colorId} style={{ width: `${subject.share * 100}%`, background: 'var(--sc)' }} />
                    ))}
                  </div>
                  <div className="history-subject-list">
                    {historyModel.subjects.map((subject) => (
                      <span key={subject.subjectId} data-color={subject.colorId}>
                        <i className="pill-dot" aria-hidden /> {subject.label}
                        <strong>{formatDurationZh(subject.seconds)}</strong>
                        <small>{Math.round(subject.share * 100)}%</small>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      {!historyOpen && mode === 'track' && (
        <div className="timeline-scale" role="radiogroup" aria-label="时间轴尺度">
          {([
            ['default', '默认'],
            ['full-day', '全天'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={scale === value}
              className={scale === value ? 'selected' : ''}
              onClick={() => {
                setScale(value);
                localStorage.setItem('clock-timeline-scale', value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
      {!historyOpen && <motion.div
        key={mode}
        className="timeline-view-shell"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={viewTransition}
      >{mode === 'list' ? (
        /* 流水账视图：按时间排序的记录行，小屏友好 */
        <div className="timeline-list" data-testid="timeline-list">
          {segs.length === 0 ? (
            <div className="timeline-list-empty" data-testid="timeline-list-empty">
              <span className="empty-glyph" aria-hidden>
                <Clock size={20} />
              </span>
              <div className="empty-title">这一天还没有记录</div>
              <div className="empty-desc">{isToday ? '开始一段专注，时间片段会自动出现在这里' : '换个日期看看，或回到今天'}</div>
              {!isToday && (
                <button className="text-btn" onClick={() => setViewDate(store.todayDate)}>
                  回今天
                </button>
              )}
            </div>
          ) : (
            sessionRows.map((row) => (
              <button
                key={row.key}
                className="timeline-list-row"
                data-color={row.colorId}
                data-testid="timeline-list-row"
                onClick={(e) => openRowPopover(row, e.currentTarget)}
              >
                <span className="pill-dot" aria-hidden />
                <span className="list-subject">{row.displayName}</span>
                <span className="list-time">
                  {row.startLabel} – {row.endLabel ?? '进行中'}
                </span>
                <span className="list-duration">
                  {formatDurationZh(row.seconds)}
                  {row.segCount > 1 && <span className="list-badge">{row.segCount} 段</span>}
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        /* 轨道始终渲染：空日也保留刻度与信标（时间感） */
        <div className="timeline-scroll" data-testid="timeline-scroll">
          <div className="timeline-track" ref={trackRef} data-scale={scale}>
          {visibleQuietPeriods.map((period) => (
            <span
              key={period.id}
              className="quiet-period"
              style={{ left: `${period.left}%`, width: `${period.width}%` }}
              title={`${period.label}静默时段`}
            >{period.label}</span>
          ))}
          {ticks.map((t) => (
            <div key={t.minute} className={`tick ${t.major ? 'major' : ''}`} style={{ left: `${t.leftPercent}%` }}>
              <span className="tick-label">{t.label}</span>
            </div>
          ))}
          {visibleSegs.map((seg, index) => {
            const visualLeft = Math.max(0, minuteToPercent(Math.max(seg.startMinute, visibleRange.startMinute)));
            const visualRight = Math.min(100, minuteToPercent(Math.min(seg.endMinute, visibleRange.endMinute)));
            const previous = visibleSegs[index - 1];
            const next = visibleSegs[index + 1];
            const previousRight = previous
              ? Math.min(100, minuteToPercent(Math.min(previous.endMinute, visibleRange.endMinute)))
              : null;
            const nextLeft = next
              ? Math.max(0, minuteToPercent(Math.max(next.startMinute, visibleRange.startMinute)))
              : null;
            const hotLeft = previousRight === null ? Math.max(0, visualLeft - 1.25) : (previousRight + visualLeft) / 2;
            const hotRight = nextLeft === null ? Math.min(100, visualRight + 1.25) : (visualRight + nextLeft) / 2;
            const hotWidth = Math.max(0.25, hotRight - hotLeft);
            const fillLeft = ((visualLeft - hotLeft) / hotWidth) * 100;
            const fillWidth = Math.max(2, ((visualRight - visualLeft) / hotWidth) * 100);
            return (
              <span
                key={seg.key}
                className={`seg ${seg.running ? 'running' : ''}${popover?.row.sessionId === seg.sessionId ? ' active' : ''}`}
                data-color={seg.colorId}
                data-lane="0"
                style={{ left: `${hotLeft}%`, width: `${hotWidth}%` }}
                onMouseEnter={() => scheduleHoverPreview(seg)}
                onMouseLeave={dismissHoverPreview}
              >
                <button
                  className="seg-hit"
                  aria-label={`${seg.displayName} ${seg.startLabel} 到 ${seg.endLabel ?? '现在'}，${formatDurationZh(seg.seconds)}`}
                  onClick={() => openPopover(seg)}
                />
                <span className="seg-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }} aria-hidden />
              </span>
            );
          })}
          {visibleSegs.length === 0 && <div className="timeline-empty-inline">这一天还没有记录</div>}
          {isToday && (
            <div className="now-line" style={{ left: `${nowPercent}%` }} data-testid="now-line" aria-label="当前时间">
              <span className="now-flag" aria-hidden />
            </div>
          )}
          </div>
        </div>
      )}</motion.div>}
      </AnimatePresence>

      {!historyOpen && hoverPreview && !popover && (
        <div
          className="seg-preview"
          role="status"
          data-testid="seg-preview"
          style={{ left: `clamp(8px, ${hoverPreview.containerX}px, calc(100% - min(304px, calc(100vw - 24px))))` }}
        >
          <div className="seg-preview-title">
            <span className="pill-dot" data-color={hoverPreview.row.colorId} aria-hidden />
            <strong>{hoverPreview.row.displayName}</strong>
          </div>
          <div className="seg-preview-meta">
            {hoverPreview.row.startLabel} – {hoverPreview.row.endLabel ?? '进行中'} · {formatDurationZh(hoverPreview.row.seconds)}
          </div>
          <span className="seg-preview-hint">点击查看详情</span>
        </div>
      )}

      {!historyOpen && popover && (
        <div
          className="seg-popover"
          role="dialog"
          aria-label="会话详情"
          data-testid="seg-popover"
          style={{ left: `clamp(8px, ${popover.containerX}px, calc(100% - min(464px, calc(100vw - 24px))))` }}
        >
          <div className="popover-head">
            <span className="popover-subject" data-color={popover.row.colorId}>
              <span className="pill-dot" aria-hidden /> {popover.row.displayName}
            </span>
            <button className="icon-btn" aria-label="关闭" onClick={() => setPopover(null)}>
              <X size={16} />
            </button>
          </div>
          <div className="popover-body">
            <div className="popover-row">
              <span className="popover-label">时间</span>
              <span className="popover-value">
                {popover.row.startLabel} – {popover.row.endLabel ?? '进行中'}
              </span>
            </div>
            <div className="popover-row">
              <span className="popover-label">净时长</span>
              <span className="popover-value">
                <strong>{formatDurationZh(popover.row.seconds)}</strong>
                {popover.row.segCount > 1 && <span className="popover-badge">{popover.row.segCount} 段</span>}
              </span>
            </div>
          </div>
          {popover.row.stopped && (
            <div className="popover-edit-grid">
              <label className="popover-field">
                <span>开始时间</span>
                <input
                  className="popover-time-input"
                  type="time"
                  value={startDraft}
                  onChange={(event) => setStartDraft(event.target.value)}
                  aria-label="编辑开始时间"
                  data-testid="popover-start-input"
                />
              </label>
              <label className="popover-field">
                <span>备注</span>
                <input
                  className="popover-note-input"
                  placeholder="这次想记下什么？（可选）"
                  value={noteDraft}
                  maxLength={200}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveNote();
                  }}
                  aria-label="编辑备注"
                  data-testid="popover-note-input"
                />
              </label>
            </div>
          )}
          {!popover.row.stopped && popover.row.note && <div className="popover-note">「{popover.row.note}」</div>}
          {popover.row.stopped && (
            <div className="popover-actions">
              <button
                className="primary-btn popover-save"
                onClick={() => void handleSaveNote()}
                disabled={noteSaving}
                data-testid="popover-save-note"
              >
                {noteSaving ? '保存中…' : '保存备注'}
              </button>
              <button
                className="ghost-btn"
                onClick={() => void handleSaveStart()}
                disabled={startSaving}
                data-testid="popover-save-start"
              >
                {startSaving ? '更新中…' : '更新起点'}
              </button>
              <button className="ghost-btn danger-btn" onClick={() => void handleWithdraw()} data-testid="withdraw-btn">
                <Undo2 size={14} aria-hidden /> 撤回
              </button>
            </div>
          )}
        </div>
      )}

      {!historyOpen && overview.length > 0 && (
        <div className="today-overview">
          {overview.map((it) => {
            const subj = store.subjects.find((s) => s.subject_id === it.subject_id);
            return (
              <span key={it.subject_id} className="overview-item" data-color={subj?.color_id}>
                <span className="pill-dot" aria-hidden />
                {subj?.display_name ?? it.subject_id} <strong>{formatDurationZh(it.seconds)}</strong>
              </span>
            );
          })}
        </div>
      )}

      {!historyOpen && <div className="legend" aria-hidden={false}>
        {store.subjects.map((s) => (
          <span key={s.subject_id} className="legend-item" data-color={s.color_id}>
            <span className="pill-dot" aria-hidden /> {s.display_name}
          </span>
        ))}
      </div>}
    </section>
  );
}
