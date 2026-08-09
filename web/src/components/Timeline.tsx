/** 底部日时间轴：00:00–24:00 固定比例轨道 + 科目片段 + 当前指示线。 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ClockStore } from '../lib/store.js';
import { formatBeijingTime, formatDurationZh } from '../lib/clock.js';

const PX_PER_MINUTE = 4; // 与旧工作台一致：24h = 5760px
const DAY_MINUTES = 1440;
const MIN_SEG_PX = 3;
const HOT_MIN_PX = 24; // WCAG 2.5.8 目标尺寸

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
  const [popover, setPopover] = useState<{ seg: RenderSeg; x: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 跟随"今天"：轮询更新 todayDate 时，若用户停留在今天则同步
  useEffect(() => {
    setViewDate((prev) => {
      // 若 prev 是旧的 today，则跟随
      return prev === store.todayDate || isTodayLike(prev, store.todayDate) ? store.todayDate : prev;
    });
  }, [store.todayDate]);

  function isTodayLike(a: string, b: string) {
    return a === b;
  }

  const isToday = viewDate === store.todayDate;
  const nowMs = Date.now();
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
  }, [store.sessions, store.subjects, startMs, endMs, nowMs, isToday]);

  // 初次渲染与切换日期时：滚动使当前时间位于 60% 视口
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isToday) {
      const nowPx = ((Math.min(nowMs, endMs) - startMs) / 60000) * PX_PER_MINUTE;
      el.scrollLeft = Math.max(0, nowPx - el.clientWidth * 0.6);
    } else {
      el.scrollLeft = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewDate]);

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

  return (
    <section className="timeline" aria-label="今日时间轴">
      <div className="timeline-head">
        <h2 className="timeline-title">时间轴 · {viewDate}</h2>
        <div className="timeline-nav">
          <button className="icon-btn" aria-label="前一天" onClick={() => setViewDate(shiftDate(viewDate, -1))}>
            <ChevronLeft size={16} />
          </button>
          <button className="text-btn" onClick={() => setViewDate(store.todayDate)} disabled={isToday}>
            今天
          </button>
          <button className="icon-btn" aria-label="后一天" onClick={() => setViewDate(shiftDate(viewDate, 1))} disabled={isToday}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {segs.length === 0 ? (
        <div className="timeline-empty">这一天还没有记录。选一个科目，开始第一段。</div>
      ) : (
        <div className="timeline-scroll" ref={scrollRef}>
          <div className="timeline-track" style={{ width: DAY_MINUTES * PX_PER_MINUTE }}>
            {ticks.map((t) => (
              <div key={t.leftPx} className={`tick ${t.major ? 'major' : ''}`} style={{ left: t.leftPx }}>
                {t.major && <span className="tick-label">{t.label}</span>}
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
                    onClick={() => setPopover({ seg, x: seg.leftPx })}
                  />
                  <span className="seg-fill" style={{ left: seg.leftPx - hotLeft, width: seg.widthPx }} aria-hidden />
                </span>
              );
            })}
            {isToday && (
              <div className="now-line" style={{ left: nowPx }} aria-hidden>
                <span className="now-flag" />
              </div>
            )}
          </div>
        </div>
      )}

      {popover && (
        <div
          className="seg-popover material"
          role="dialog"
          aria-label="片段详情"
          style={{ left: `clamp(8px, ${popover.x}px, calc(100% - 190px))` }}
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
