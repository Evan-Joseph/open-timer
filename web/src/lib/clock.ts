/** 单调时钟显示：以服务端确认秒数为锚，performance.now() 平滑推进。 */

import { useEffect, useRef, useState } from 'react';

export interface SyncAnchor {
  /** 服务端确认的净秒数 */
  confirmedSeconds: number;
  /** 当前是否 running（running 时才推进） */
  running: boolean;
  /** 锚定时刻的 performance.now() */
  anchorPerfMs: number;
  /** 锚定时刻的服务端墙钟（用于北京时间显示校准） */
  serverNowMs: number;
}

/** 返回当前显示秒数（整数）。 */
export function useMonotonicSeconds(anchor: SyncAnchor | null, tickMs = 1000): number {
  const [seconds, setSeconds] = useState(0);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useEffect(() => {
    if (!anchor) {
      setSeconds(0);
      return;
    }
    const compute = () => {
      const a = anchorRef.current;
      if (!a) return 0;
      const elapsed = a.running ? Math.max(0, (performance.now() - a.anchorPerfMs) / 1000) : 0;
      return Math.max(0, Math.floor(a.confirmedSeconds + elapsed));
    };
    setSeconds(compute());
    const t = window.setInterval(() => setSeconds(compute()), tickMs);
    return () => window.clearInterval(t);
  }, [anchor, tickMs]);

  return seconds;
}

/** 离开时长：服务端确认值加单调增量，客户端墙钟变化不能制造休息时长。 */
export function useWallSeconds(anchor: SyncAnchor | null, tickMs = 1000): number {
  const [seconds, setSeconds] = useState(0);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useEffect(() => {
    if (!anchor) {
      setSeconds(0);
      return;
    }
    const compute = () => {
      const a = anchorRef.current;
      if (!a) return 0;
      const elapsed = a.running ? Math.max(0, (performance.now() - a.anchorPerfMs) / 1000) : 0;
      return Math.max(0, Math.floor(a.confirmedSeconds + elapsed));
    };
    setSeconds(compute());
    const t = window.setInterval(() => setSeconds(compute()), tickMs);
    return () => window.clearInterval(t);
  }, [anchor, tickMs]);

  return seconds;
}

/**
 * 双锚点同源推进：总累计 + 本段 用【同一个 interval / 同一次 performance.now()】
 * 计算，避免两个独立 interval 各自 Math.floor 的"抢秒"竞态（恢复瞬间加号两侧
 * 抖动的主因）。前段 = floor(总浮点 - 本段浮点)，保证 prev + seg === total 恒成立。
 */
export function useDualMonotonic(
  totalAnchor: SyncAnchor | null,
  segAnchor: SyncAnchor | null,
  tickMs = 1000,
): { total: number; seg: number; prev: number } {
  const [val, setVal] = useState({ total: 0, seg: 0, prev: 0 });
  const refs = useRef({ totalAnchor, segAnchor });
  refs.current = { totalAnchor, segAnchor };

  useEffect(() => {
    const compute = () => {
      const { totalAnchor: t, segAnchor: s } = refs.current;
      const now = performance.now();
      const elapse = (a: SyncAnchor | null) =>
        a && a.running ? Math.max(0, (now - a.anchorPerfMs) / 1000) : 0;
      const totalF = t ? Math.max(0, t.confirmedSeconds + elapse(t)) : 0;
      const segF = s ? Math.max(0, s.confirmedSeconds + elapse(s)) : 0;
      const total = Math.floor(totalF);
      const seg = Math.max(0, Math.floor(segF));
      // 浮点差再取整：杜绝"两个 floor 相减"导致的 ±1 抢秒
      const prev = Math.max(0, Math.floor(totalF - segF));
      return { total, seg, prev };
    };
    setVal(compute());
    const t = window.setInterval(() => setVal(compute()), tickMs);
    return () => window.clearInterval(t);
  }, [totalAnchor, segAnchor, tickMs]);

  return val;
}

/** 北京时间 HH:MM 显示，锚定服务端时间。 */
export function useBeijingTime(anchor: { serverNowMs: number; anchorPerfMs: number } | null): string {
  const [text, setText] = useState('--:--');
  useEffect(() => {
    let timer: number | null = null;
    const update = () => {
      if (!anchor) return '--:--';
      const wall = anchor.serverNowMs + (performance.now() - anchor.anchorPerfMs);
      const next = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(wall));
      setText(next);
      // 分钟数字只在边界变化：以服务端墙钟计算下一次更新，避免最多 5s 的跨分钟滞后。
      const nextMinuteIn = 60_000 - (Math.floor(wall) % 60_000);
      timer = window.setTimeout(update, Math.max(50, nextMinuteIn + 20));
      return next;
    };
    if (!anchor) {
      setText('--:--');
      return;
    }
    update();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [anchor]);
  return text;
}

export function formatHms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 短格式：不足 1 小时省略小时（本段时长用，如 06:01）；≥1 小时回退 HH:MM:SS。 */
export function formatHmsShort(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? formatHms(totalSeconds) : `${pad(m)}:${pad(s)}`;
}

export function formatDurationZh(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分钟`;
  return `${totalSeconds} 秒`;
}

export function formatBeijingTime(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'string' ? new Date(isoOrMs) : new Date(isoOrMs);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export { restPlanForFocus, restStageOf, restStageLabel } from '@clock/shared';
export type { RestPlan, RestStage } from '@clock/shared';

export function shanghaiTodayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
