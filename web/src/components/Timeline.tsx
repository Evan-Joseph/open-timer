/**
 * 底部日时间轴：00:00–24:00 固定比例轨道 + 科目片段 + 当前信标。
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
import { ChevronLeft, ChevronRight, Clock, LocateFixed, Undo2, X, ZoomIn, ZoomOut, List, GanttChart, CalendarDays } from 'lucide-react';
import type { ClockStore } from '../lib/store.js';
import type { DailySummaryApi, SessionApi } from '../lib/api.js';
import { apiGet } from '../lib/api.js';
import { formatBeijingTime, formatDurationZh } from '../lib/clock.js';
import { shanghaiDayRangeUtc } from '@clock/shared';

const BASE_PX_PER_MINUTE = 4; // 1x 缩放：24h = 5760px
const ZOOM_LEVELS = [0.5, 1, 2, 4];
const DAY_MINUTES = 1440;
const MIN_SEG_PX = 3;
const NOW_TICK_MS = 30_000;

interface RenderSeg {
  key: string;
  sessionId: string;
  subjectId: string;
  colorId: string;
  displayName: string;
  leftPx: number;
  widthPx: number;
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

export default function Timeline({ store }: { store: ClockStore }) {
  const [viewDate, setViewDate] = useState(store.todayDate);
  const [popover, setPopover] = useState<{ row: SessionRow; containerX: number } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** 缩放级别索引与轨道/流水账视图 */
  const [zoomIdx, setZoomIdx] = useState(() => {
    const saved = Number(localStorage.getItem('clock-timeline-zoom'));
    const i = ZOOM_LEVELS.indexOf(saved);
    return i >= 0 ? i : 1;
  });
  const [mode, setMode] = useState<'track' | 'list'>('track');
  const pxPerMinute = BASE_PX_PER_MINUTE * ZOOM_LEVELS[zoomIdx];
  /** popover 内编辑备注 */
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [startDraft, setStartDraft] = useState('');
  const [startSaving, setStartSaving] = useState(false);
  /** 查看历史日时按日期拉取的会话数据 */
  const [historySessions, setHistorySessions] = useState<SessionApi[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySummaries, setHistorySummaries] = useState<DailySummaryApi[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const prevTodayRef = useRef(store.todayDate);
  /** 定位以 viewDateRef 为准，避免 effect 声明顺序导致的竞态 */
  const viewDateRef = useRef(viewDate);
  const locatedDateRef = useRef<string | null>(null);
  const activeSessionId = store.state?.active_session?.session_id ?? null;
  const prevActiveIdRef = useRef<string | null>(null);
  const historyCacheRef = useRef<Map<string, SessionApi[]>>(new Map());

  const loadHistory = useCallback(async () => {
    if (historyLoading) return;
    setHistoryLoading(true);
    const dates = Array.from({ length: 7 }, (_, index) => shiftDate(store.todayDate, -index));
    const rows = await Promise.all(
      dates.map((date) => apiGet<DailySummaryApi>(`/api/v1/daily-summary?date=${date}&timezone=Asia%2FShanghai`).catch(() => null)),
    );
    setHistorySummaries(rows.filter((row): row is DailySummaryApi => row !== null));
    setHistoryLoading(false);
  }, [historyLoading, store.todayDate]);

  // 信标持续移动（30s 步进）：不触发强制滚动
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  // 跨午夜：若用户停留在"旧的今天"，跟随到新的今天
  useEffect(() => {
    if (prevTodayRef.current !== store.todayDate) {
      setViewDate((prev) => (prev === prevTodayRef.current ? store.todayDate : prev));
      prevTodayRef.current = store.todayDate;
      locatedDateRef.current = null; // 新的一天允许重新定位
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
        const leftPx = ((cs - startMs) / 60000) * pxPerMinute;
        const rawWidthPx = ((ce - cs) / 60000) * pxPerMinute;
        out.push({
          key: `${s.session_id}-${i}`,
          sessionId: s.session_id,
          subjectId: s.subject_id,
          colorId: subj?.color_id ?? 'blue',
          displayName: subj?.display_name ?? s.subject_id,
          leftPx,
          widthPx: Math.max(MIN_SEG_PX, rawWidthPx),
          startLabel: formatBeijingTime(cs),
          endLabel: seg.ended_at ? formatBeijingTime(ce) : null,
          seconds: Math.floor((ce - cs) / 1000),
          running: seg.ended_at === null && isToday,
          stopped: s.status === 'stopped',
          note: s.note,
        });
      }
    }
    return out.sort((a, b) => a.leftPx - b.leftPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateSessions, store.subjects, startMs, endMs, isToday, pxPerMinute, Math.floor(nowMs / NOW_TICK_MS)]);

  /** 会话级分组：一个 session 的所有段合并为一行（弹窗/流水账共用数据源）。 */
  const sessionRows: SessionRow[] = useMemo(() => {
    const out: SessionRow[] = [];
    const nowClamped = Math.min(Date.now(), endMs);
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

  /** 滚动到指定轨道 px（自动钳制），behavior 可选平滑。 */
  const scrollToPx = useCallback((px: number, smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = Math.max(0, Math.min(px - el.clientWidth * 0.6, el.scrollWidth - el.clientWidth));
    el.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const scrollToNow = useCallback(
    (smooth: boolean) => {
      const nowClamped = Math.min(Math.max(Date.now(), startMs), endMs);
      const px = ((nowClamped - startMs) / 60000) * pxPerMinute;
      scrollToPx(px, smooth);
    },
    [startMs, endMs, pxPerMinute, scrollToPx],
  );

  // 定位：每个日期只自动定位一次；以 viewDateRef 为准判断目标日（修复 effect 顺序竞态）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const targetDate = viewDateRef.current;
    if (locatedDateRef.current === targetDate) return;
    locatedDateRef.current = targetDate;
    if (targetDate === store.todayDate) {
      scrollToNow(false);
    } else if (segs.length > 0) {
      scrollToPx(segs[0].leftPx, false);
    } else {
      scrollToPx(8 * 60 * pxPerMinute, false); // 历史空日：定位 08:00
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewDate, segs, store.todayDate]);

  // 新会话开始：平滑滚到信标（片段正在生长）
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevActiveIdRef.current) {
      const t = window.setTimeout(() => {
        if (viewDateRef.current === store.todayDate) scrollToNow(true);
      }, 150);
      prevActiveIdRef.current = activeSessionId;
      return () => window.clearTimeout(t);
    }
    prevActiveIdRef.current = activeSessionId;
  }, [activeSessionId, scrollToNow, store.todayDate]);

  const ticks = useMemo(() => {
    const arr: Array<{ label: string; leftPx: number; major: boolean }> = [];
    // 缩放越深刻度越稀（避免标签重叠）：2x 起 60 分钟，4x 起 120 分钟
    const step = pxPerMinute >= 16 ? 120 : pxPerMinute >= 8 ? 60 : 30;
    for (let m = 0; m <= DAY_MINUTES; m += step) {
      arr.push({
        label: `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
        leftPx: m * pxPerMinute,
        major: m % 60 === 0,
      });
    }
    return arr;
  }, [pxPerMinute]);

  const nowPx = ((Math.min(Math.max(nowMs, startMs), endMs) - startMs) / 60000) * pxPerMinute;

  /** 点片段：轨道坐标 → 容器坐标（trackRect 已含滚动位移，直接相减）；数据提升到会话级。 */
  const openPopover = useCallback((seg: RenderSeg) => {
    const row = sessionRowsRef.current.find((r) => r.sessionId === seg.sessionId);
    if (!row) return;
    setNoteDraft(seg.note ?? '');
    setStartDraft(row.startLabel);
    setNoteSaving(false);
    const track = trackRef.current;
    const scrollEl = scrollRef.current;
    if (!track || !scrollEl) {
      setPopover({ row, containerX: seg.leftPx });
      return;
    }
    const trackRect = track.getBoundingClientRect();
    const containerRect = scrollEl.getBoundingClientRect();
    const xInContainer = trackRect.left - containerRect.left + seg.leftPx + seg.widthPx / 2;
    setPopover({ row, containerX: xInContainer });
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

  return (
    <section className="timeline" aria-label="时间轴">
      <div className="timeline-head">
        <h2 className="timeline-title">
          时间轴 · {viewDate}
          {totalSeconds > 0 && <span className="timeline-total"> · 共 {formatDurationZh(totalSeconds)}</span>}
        </h2>
        <div className="timeline-nav">
          {mode === 'track' && (
            <>
              <button
                className="icon-btn"
                aria-label="缩小时间轴"
                title="缩小"
                disabled={zoomIdx <= 0}
                onClick={() => {
                  const next = zoomIdx - 1;
                  setZoomIdx(next);
                  localStorage.setItem('clock-timeline-zoom', String(ZOOM_LEVELS[next]));
                }}
              >
                <ZoomOut size={16} />
              </button>
              <button
                className="icon-btn"
                aria-label="放大时间轴"
                title="放大"
                disabled={zoomIdx >= ZOOM_LEVELS.length - 1}
                onClick={() => {
                  const next = zoomIdx + 1;
                  setZoomIdx(next);
                  localStorage.setItem('clock-timeline-zoom', String(ZOOM_LEVELS[next]));
                }}
              >
                <ZoomIn size={16} />
              </button>
            </>
          )}
          <button
            className="icon-btn"
            aria-label={mode === 'track' ? '切换到流水账视图' : '切换到时间轴视图'}
            title={mode === 'track' ? '流水账' : '时间轴'}
            onClick={() => setMode(mode === 'track' ? 'list' : 'track')}
            data-testid="timeline-mode-btn"
          >
            {mode === 'track' ? <List size={16} /> : <GanttChart size={16} />}
          </button>
          <button className="icon-btn" aria-label="前一天" onClick={() => setViewDate(shiftDate(viewDate, -1))}>
            <ChevronLeft size={16} />
          </button>
          {isToday ? (
            <button className="text-btn now-btn" onClick={() => scrollToNow(true)} aria-label="滚动到当前时间" data-testid="scroll-now-btn">
              <LocateFixed size={14} aria-hidden /> 现在
            </button>
          ) : (
            <button className="text-btn" onClick={() => setViewDate(store.todayDate)}>
              回今天
            </button>
          )}
          <button className="icon-btn" aria-label="后一天" onClick={() => setViewDate(shiftDate(viewDate, 1))} disabled={isToday}>
            <ChevronRight size={16} />
          </button>
          <button
            className={`icon-btn ${historyOpen ? 'selected' : ''}`}
            aria-label="近 7 天回顾"
            title="近 7 天回顾"
            onClick={() => {
              const next = !historyOpen;
              setHistoryOpen(next);
              if (next) void loadHistory();
            }}
            data-testid="history-toggle"
          >
            <CalendarDays size={16} />
          </button>
        </div>
      </div>

      {historyOpen && (
        <div className="history-strip" data-testid="history-strip">
          <div className="history-strip-head">
            <strong>近 7 天执行回顾</strong>
            <span>只展示计时事实，不代表掌握程度</span>
          </div>
          {historyLoading ? <div className="history-empty">正在读取…</div> : (
            <div className="history-days">
              {historySummaries.map((day) => (
                <button key={day.date} className="history-day" onClick={() => setViewDate(day.date)}>
                  <span>{day.date.slice(5)}</span>
                  <strong>{formatDurationZh(day.total_active_seconds)}</strong>
                  <small>{day.by_subject.filter((item) => item.active_seconds > 0).length} 科</small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === 'list' ? (
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
        <div className="timeline-scroll" ref={scrollRef} data-testid="timeline-scroll">
          <div className="timeline-track" ref={trackRef} style={{ width: DAY_MINUTES * pxPerMinute }}>
          {ticks.map((t) => (
            <div key={t.leftPx} className={`tick ${t.major ? 'major' : ''}`} style={{ left: t.leftPx }}>
              {t.major && t.leftPx < DAY_MINUTES * pxPerMinute - 40 && <span className="tick-label">{t.label}</span>}
            </div>
          ))}
          {segs.map((seg, i) => {
            // 热区按相邻片段中点分割：不重叠、不留缝；稀疏时向两侧扩展 12px（窄片段总热区 ≥24px）
            const prev = segs[i - 1];
            const next = segs[i + 1];
            const visualEnd = seg.leftPx + seg.widthPx;
            let hotLeft = seg.leftPx - 12;
            let hotRight = visualEnd + 12;
            if (prev) {
              const prevEnd = prev.leftPx + prev.widthPx;
              hotLeft = Math.max(hotLeft, (prevEnd + seg.leftPx) / 2);
            }
            if (next) {
              hotRight = Math.min(hotRight, (visualEnd + next.leftPx) / 2);
            }
            return (
              <span
                key={seg.key}
                className={`seg ${seg.running ? 'running' : ''}`}
                data-color={seg.colorId}
                style={{ left: hotLeft, width: Math.max(4, hotRight - hotLeft) }}
              >
                <button
                  className="seg-hit"
                  aria-label={`${seg.displayName} ${seg.startLabel} 到 ${seg.endLabel ?? '现在'}，${formatDurationZh(seg.seconds)}`}
                  onClick={() => openPopover(seg)}
                />
                <span className="seg-fill" style={{ left: seg.leftPx - hotLeft, width: seg.widthPx }} aria-hidden />
              </span>
            );
          })}
          {segs.length === 0 && <div className="timeline-empty-inline">这一天还没有记录</div>}
          {isToday && (
            <div className="now-line" style={{ left: nowPx }} data-testid="now-line" aria-label="当前时间">
              <span className="now-flag" aria-hidden />
            </div>
          )}
          </div>
        </div>
      )}

      {popover && (
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

      {overview.length > 0 && (
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

      <div className="legend" aria-hidden={false}>
        {store.subjects.map((s) => (
          <span key={s.subject_id} className="legend-item" data-color={s.color_id}>
            <span className="pill-dot" aria-hidden /> {s.display_name}
          </span>
        ))}
      </div>
    </section>
  );
}
