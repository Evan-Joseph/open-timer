/**
 * 节奏环（自动阶段版）：用户只管启停学习，节奏阶段自动推导。
 * - focus：环随专注秒数推进；
 * - ready_break：到节奏点，环满 + 琥珀色常驻横幅「可以休息一下了」；
 * - break_ready：休息够了，绿色常驻横幅「休息够了，回来继续吧」。
 * 横幅只是呈现建议：暂停/继续始终是用户动作，不自动改变计时。
 */

import { useEffect, useRef } from 'react';
import { Coffee, CupSoda, Sparkles } from 'lucide-react';
import type { RhythmConfig } from '@clock/shared';
import { rhythmStatus, rhythmDots, rhythmPhase } from '@clock/shared';
import { ambient } from '../lib/ambient.js';

interface Props {
  /** 本轮连续专注秒数（running 推进；paused 冻结） */
  segmentSeconds: number | null;
  /** 离开中已过秒数（paused 推进） */
  awaySeconds: number;
  config: RhythmConfig;
  paused: boolean;
  /** 是否显示阶段横幅（设置内可关） */
  showBanners?: boolean;
  /** 阶段切换时播放柔和铃声 */
  chimeEnabled?: boolean;
}

const RADIUS = 84;
const STROKE = 5;
const CIRC = 2 * Math.PI * RADIUS;

export default function RhythmRing({ segmentSeconds, awaySeconds, config, paused, showBanners = true, chimeEnabled = false }: Props) {
  const segSecs = segmentSeconds ?? 0;
  const status = rhythmStatus(segSecs, config);
  const dots = rhythmDots(status, config);
  const phase = rhythmPhase(segSecs, awaySeconds, paused, config);

  // 阶段切换铃声：仅在 ready_break / break_ready 出现的那一刻响一次
  const prevPhaseRef = useRef(phase.phase);
  useEffect(() => {
    if (phase.phase !== prevPhaseRef.current) {
      if (chimeEnabled && phase.phase !== 'focus') ambient.chime(phase.suggestedBreak === 'long');
      prevPhaseRef.current = phase.phase;
    }
  }, [phase.phase, phase.suggestedBreak, chimeEnabled]);

  const dashOffset = CIRC * (1 - status.progress);
  const ringTone = phase.phase === 'ready_break' ? 'ready' : phase.phase === 'break_ready' ? 'go' : '';

  return (
    <div className="rhythm" aria-label="专注节奏">
      <div className="rhythm-ring-wrap">
        <svg className="rhythm-svg" width={180} height={180} viewBox="0 0 180 180" role="img" aria-hidden>
          <circle cx={90} cy={90} r={RADIUS} className="rhythm-track" strokeWidth={STROKE} fill="none" />
          <circle
            cx={90}
            cy={90}
            r={RADIUS}
            className={`rhythm-progress ${ringTone}`}
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
            {phase.phase === 'ready_break'
              ? '到节奏点了'
              : phase.phase === 'break_ready'
                ? '休息够了'
                : paused
                  ? '小憩中'
                  : formatRemain(status.roundRemainingSec)}
          </div>
          <div className="rhythm-dots" aria-label={`本轮周期内已完成 ${status.completedRounds % config.longBreakEvery} 轮`}>
            {dots.map((d, i) => (
              <span key={i} className={`rhythm-dot ${d}`} />
            ))}
          </div>
        </div>
      </div>

      {showBanners && phase.phase === 'ready_break' && (
        <div className="rhythm-banner ready" role="status" data-testid="rhythm-banner">
          <span className="banner-icon" aria-hidden>
            {phase.suggestedBreak === 'long' ? <Coffee size={14} /> : <CupSoda size={14} />}
          </span>
          <span>
            已连续专注 {Math.floor(segSecs / 60)} 分钟，
            {phase.suggestedBreak === 'long' ? '适合来一次长休息' : '可以歇一小会儿'}
            （约 {config.focusMin >= 90 ? config.longBreakMin : config.breakMin} 分钟）。点「暂停」即可开始休息。
          </span>
        </div>
      )}

      {showBanners && phase.phase === 'break_ready' && (
        <div className="rhythm-banner go" role="status" data-testid="rhythm-banner">
          <span className="banner-icon" aria-hidden>
            <Sparkles size={14} />
          </span>
          <span>休息够了，随时回来继续。点「继续」即可恢复计时。</span>
        </div>
      )}

      {phase.phase === 'focus' && (
        <div className="rhythm-meta">
          专注 {config.focusMin} 分 / 小憩 {config.breakMin} 分 · 每 {config.longBreakEvery} 轮长休息 {config.longBreakMin} 分
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
