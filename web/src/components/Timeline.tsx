/**
 * 底部日时间轴：00:00–24:00 固定比例轨道 + 科目片段 + 当前信标。
 *
 * 交互模型（参考 FullCalendar nowIndicator/scrollTime 与 Toggl Track）：
 * - 信标随时间持续移动（30s 步进），不强制拖动视口（尊重用户手动浏览）；
 * - 初始加载 / 数据到位 / 点击「现在」/ 新会话开始：滚动使信标位于视口 60%；
 * - 切换到历史日：滚动到当日第一个片段（无片段则 08:00）；
 * - popover 用容器坐标（含 scrollLeft 换算），Esc/点击外部/关闭按钮均可关。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LocateFixed } from 'lucide-react';
import type { ClockStore } from '../lib/store.js';
import { formatBeijingTime, formatDurationZh } from '../lib/clock.js';

const PX_PER_MINUTE = 4; // 与旧工作台一致：24h = 5760px
const DAY_MINUTES = 1440;
const MIN_SEG_PX = 3;
const NOW_TICK_MS = 30_000;

interface RenderSeg {
  key: string;
  subjectId: string;
  colorId: string;
  displayName: string;
  leftPx: number;
  widthPx: number;
  startLabel: string;
  endLabel: string | null;
  seconds: number;
  running: boolean;
  note: string | null;
}

function dateToRangeMs(date: string): { startMs: number; endMs: number } {
  const [y, m, d] = date.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d) - 8 * 3600 * 1000;
  return { startMs, endMs: startMs + 86_400_000 };
}

function shiftDate(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export default function Timeline({ store }: { store: ClockStore }) {
  const [viewDate, setViewDate] = useState(store.todayDate);
  const [popover, setPopover] = useState<{ seg: RenderSeg; containerX: number } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const prevTodayRef = useRef(store.todayDate);
  const hasScrolledRef = useRef(false);
  const activeSessionId = store.state?.active_session?.session_id ?? null;
  const prevActiveIdRef = useRef<string | null>(null);

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
      hasScrolledRef.current = false; // 新的一天允许重新定位
    }
  }, [store.todayDate]);

  const isToday = viewDate === store.todayDate;
  const { startMs, endMs } = useMemo(() => dateToRangeMs(viewDate), [viewDate]);

  const segs: RenderSeg[] = useMemo(() => {
    const out: RenderSeg[] = [];
    const nowClamped = Math.min(nowMs, endMs);
    for (const s of store.sessions) {
      if (s.status === 'voided') continue;
      const subj = store.subjects.find((x) => x.subject_id === s.subject_id);
      for (let i = 0; i < s.segments.length; i++) {
        const seg = s.segments[i];
        const segStart = Date.parse(seg.started_at);
        const segEnd = seg.ended_at ? Date.parse(seg.ended_at) : nowClamped;
        if (segEnd <= startMs || segStart >= endMs) continue;
        const cs = Math.max(segStart, startMs);
        const ce = Math.min(segEnd, endMs);
        const leftPx = ((cs - startMs) / 60000) * PX_PER_MINUTE;
        const rawWidthPx = ((ce - cs) / 60000) * PX_PER_MINUTE;
        out.push({
          key: `${s.session_id}-${i}`,
          subjectId: s.subject_id,
          colorId: subj?.color_id ?? 'blue',
          displayName: subj?.display_name ?? s.subject_id,
          leftPx,
          widthPx: Math.max(MIN_SEG_PX, rawWidthPx),
          startLabel: formatBeijingTime(cs),
          endLabel: seg.ended_at ? formatBeijingTime(ce) : null,
          seconds: Math.floor((ce - cs) / 1000),
          running: seg.ended_at === null && isToday,
          note: s.note,
        });
      }
    }
    return out.sort((a, b) => a.leftPx - b.leftPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sessions, store.subjects, startMs, endMs, isToday, Math.floor(nowMs / NOW_TICK_MS)]);

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
      const px = ((nowClamped - startMs) / 60000) * PX_PER_MINUTE;
      scrollToPx(px, smooth);
    },
    [startMs, endMs, scrollToPx],
  );

  // 数据到位后的首次定位（修复：sessions 异步加载完成才滚动）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (hasScrolledRef.current) return;
    hasScrolledRef.current = true;
    if (isToday) {
      scrollToNow(false);
    } else if (segs.length > 0) {
      scrollToPx(segs[0].leftPx, false);
    } else {
      scrollToPx(8 * 60 * PX_PER_MINUTE, false); // 历史空日：定位 08:00
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewDate, store.sessions.length, isToday]);

  // 切换日期后重新允许定位
  useEffect(() => {
    hasScrolledRef.current = false;
    setPopover(null);
  }, [viewDate]);

  // 新会话开始：平滑滚到信标（片段正在生长）
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevActiveIdRef.current) {
      const t = window.setTimeout(() => scrollToNow(true), 150);
      prevActiveIdRef.current = activeSessionId;
      return () => window.clearTimeout(t);
    }
    prevActiveIdRef.current = activeSessionId;
  }, [activeSessionId, scrollToNow]);

  const ticks = useMemo(() => {
    const arr: Array<{ label: string; leftPx: number; major: boolean }> = [];
    for (let m = 0; m <= DAY_MINUTES; m += 30) {
      arr.push({
        label: `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
        leftPx: m * PX_PER_MINUTE,
        major: m % 60 === 0,
      });
    }
    return arr;
  }, []);

  const nowPx = ((Math.min(Math.max(nowMs, startMs), endMs) - startMs) / 60000) * PX_PER_MINUTE;

  /** 点片段：轨道坐标 → 容器坐标（trackRect 已含滚动位移，直接相减）。 */
  const openPopover = useCallback((seg: RenderSeg) => {
    const track = trackRef.current;
    const scrollEl = scrollRef.current;
    if (!track || !scrollEl) {
      setPopover({ seg, containerX: seg.leftPx });
      return;
    }
    const trackRect = track.getBoundingClientRect();
    const containerRect = scrollEl.getBoundingClientRect();
    const xInContainer = trackRect.left - containerRect.left + seg.leftPx + seg.widthPx / 2;
    setPopover({ seg, containerX: xInContainer });
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

  // 当日（viewDate）各科小计：跟随所看日期，不再永远显示今天
  const overview = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of store.sessions) {
      if (s.status === 'voided') continue;
      map.set(s.subject_id, (map.get(s.subject_id) ?? 0) + s.active_seconds);
    }
    return [...map.entries()]
      .map(([subject_id, seconds]) => ({ subject_id, seconds }))
      .sort((a, b) => b.seconds - a.seconds);
  }, [store.sessions]);

  const totalSeconds = overview.reduce((a, b) => a + b.seconds, 0);

  return (
    <section className="timeline" aria-label="时间轴">
      <div className="timeline-head">
        <h2 className="timeline-title">
          时间轴 · {viewDate}
          {totalSeconds > 0 && <span className="timeline-total"> · 共 {formatDurationZh(totalSeconds)}</span>}
        </h2>
        <div className="timeline-nav">
          <button className="icon-btn" aria-label="前一天" onClick={() => setViewDate(shiftDate(viewDate, -1))}>
            <ChevronLeft size={16} />
          </button>
          {isToday ? (
            <button className="text-btn now-btn" onClick={() => scrollToNow(true)} aria-label="滚动到当前时间" data-testid="scroll-now-btn">
              <LocateFixed size={13} aria-hidden /> 现在
            </button>
          ) : (
            <button className="text-btn" onClick={() => setViewDate(store.todayDate)}>
              回今天
            </button>
          )}
          <button className="icon-btn" aria-label="后一天" onClick={() => setViewDate(shiftDate(viewDate, 1))} disabled={isToday}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* 轨道始终渲染：空日也保留刻度与信标（时间感） */}
      <div className="timeline-scroll" ref={scrollRef} data-testid="timeline-scroll">
        <div className="timeline-track" ref={trackRef} style={{ width: DAY_MINUTES * PX_PER_MINUTE }}>
          {ticks.map((t) => (
            <div key={t.leftPx} className={`tick ${t.major ? 'major' : ''}`} style={{ left: t.leftPx }}>
              {t.major && t.leftPx < DAY_MINUTES * PX_PER_MINUTE - 40 && <span className="tick-label">{t.label}</span>}
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

      {popover && (
        <div
          className="seg-popover material"
          role="dialog"
          aria-label="片段详情"
          data-testid="seg-popover"
          style={{ left: `clamp(8px, ${popover.containerX}px, calc(100% - 200px))` }}
        >
          <div className="popover-subject" data-color={popover.seg.colorId}>
            <span className="pill-dot" aria-hidden /> {popover.seg.displayName}
          </div>
          <div className="popover-line">
            {popover.seg.startLabel} – {popover.seg.endLabel ?? '进行中'}
          </div>
          <div className="popover-line">净时长 {formatDurationZh(popover.seg.seconds)}</div>
          {popover.seg.note && <div className="popover-note">「{popover.seg.note}」</div>}
          <button className="text-btn" onClick={() => setPopover(null)}>
            关闭
          </button>
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
