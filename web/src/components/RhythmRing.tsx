/**
 * 番茄节奏环：当前轮的参考进度。
 * - SVG 圆环 + tabular 数字，随秒数平滑推进；
 * - 到达节奏点：环满 + 温和内联提示（不弹窗、不发声、不自动暂停）；
 * - 全程 prefers-reduced-motion 可用（环本身只是静态快照）。
 */

import { useEffect, useRef, useState } from 'react';
import { Coffee, CupSoda } from 'lucide-react';
import type { RhythmConfig } from '@clock/shared';
import { rhythmStatus, rhythmDots } from '@clock/shared';

interface Props {
  /** 当前开放段已过秒数（running 中）；paused/无段时传 null */
  segmentSeconds: number | null;
  /** 会话总净秒数（含历史轮），用于累计展示 */
  totalSeconds: number;
  config: RhythmConfig;
  paused: boolean;
  /** 用户点击"休息一下"（= 主动暂停） */
  onTakeBreak: () => void;
  /** 用户忽略提示继续 */
  onDismissNudge: () => void;
  /** 是否允许显示节奏点提示 */
  nudgeEnabled: boolean;
}

const RADIUS = 84;
const STROKE = 5;
const CIRC = 2 * Math.PI * RADIUS;

export default function RhythmRing({ segmentSeconds, totalSeconds, config, paused, onTakeBreak, onDismissNudge, nudgeEnabled }: Props) {
  const [nudgeDismissedAt, setNudgeDismissedAt] = useState<number | null>(null);
  const lastNudgeRoundRef = useRef<number>(0);

  const segSecs = segmentSeconds ?? 0;
  const status = rhythmStatus(segSecs, config);
  const dots = rhythmDots(status, config);

  // 新轮次开始（或段重新开始）时清除 dismissed，允许下一个节奏点再提示
  useEffect(() => {
    if (status.completedRounds !== lastNudgeRoundRef.current) {
      lastNudgeRoundRef.current = status.completedRounds;
      setNudgeDismissedAt(null);
    }
  }, [status.completedRounds]);

  const showNudge = nudgeEnabled && status.atCheckpoint && !paused && segmentSeconds !== null && nudgeDismissedAt === null;

  const dashOffset = CIRC * (1 - status.progress);

  return (
    <div className="rhythm" aria-label="专注节奏参考">
      <div className="rhythm-ring-wrap">
        <svg className="rhythm-svg" width={180} height={180} viewBox="0 0 180 180" role="img" aria-hidden>
          <circle cx={90} cy={90} r={RADIUS} className="rhythm-track" strokeWidth={STROKE} fill="none" />
          <circle
            cx={90}
            cy={90}
            r={RADIUS}
            className={`rhythm-progress ${status.atCheckpoint ? 'complete' : ''}`}
            strokeWidth={STROKE}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 90 90)"
          />
        </svg>
        <div className="rhythm-center">
          <div className="rhythm-round">第 {status.round} 轮</div>
          <div className="rhythm-remain" data-testid="rhythm-remain">
            {paused || segmentSeconds === null
              ? '已暂停'
              : status.atCheckpoint
                ? '到节奏点了'
                : formatRemain(status.roundRemainingSec)}
          </div>
          <div className="rhythm-dots" aria-label={`本轮周期内已完成 ${status.completedRounds % config.longBreakEvery} 轮`}>
            {dots.map((d, i) => (
              <span key={i} className={`rhythm-dot ${d}`} />
            ))}
          </div>
        </div>
      </div>

      {showNudge ? (
        <div className="rhythm-nudge" role="status" data-testid="rhythm-nudge">
          <span className="nudge-icon" aria-hidden>
            {status.suggestedBreak === 'long' ? <Coffee size={15} /> : <CupSoda size={15} />}
          </span>
          <span>
            已连续专注 {formatRemain(Math.floor(segSecs))}，{status.suggestedBreak === 'long' ? '建议来个长休息' : '可以歇一会儿'}。
          </span>
          <button className="nudge-btn primary" onClick={onTakeBreak}>
            休息一下
          </button>
          <button className="nudge-btn" onClick={() => { setNudgeDismissedAt(Date.now()); onDismissNudge(); }}>
            继续专注
          </button>
        </div>
      ) : (
        <div className="rhythm-meta">
          节奏参考 · 专注 {config.focusMin} 分 / 休息 {config.breakMin} 分 · 每 {config.longBreakEvery} 轮长休息
        </div>
      )}
    </div>
  );
}

function formatRemain(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `${m} 分 ${String(s).padStart(2, '0')} 秒`;
  return `${s} 秒`;
}
