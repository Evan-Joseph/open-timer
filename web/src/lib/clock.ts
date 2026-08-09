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

/** 北京时间 HH:MM 显示，锚定服务端时间。 */
export function useBeijingTime(anchor: { serverNowMs: number; anchorPerfMs: number } | null): string {
  const [text, setText] = useState('--:--');
  useEffect(() => {
    const compute = () => {
      if (!anchor) return '--:--';
      const wall = anchor.serverNowMs + (performance.now() - anchor.anchorPerfMs);
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(wall));
    };
    setText(compute());
    const t = window.setInterval(() => setText(compute()), 5000);
    return () => window.clearInterval(t);
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

export function shanghaiTodayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
