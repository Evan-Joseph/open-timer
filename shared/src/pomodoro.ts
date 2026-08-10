/**
 * 番茄节奏纯函数（可选参考，不支配用户）。
 *
 * 设计约束（11408 沉浸时钟人本原则）：
 * - 节奏只是参考：到达节奏点不自动暂停、不停止、不惩罚；
 * - "休息一下"等价于用户主动 pause（不计入学习时长），休息倒计时只是参考；
 * - 轮次计数只描述当前连续专注段（开放 segment），暂停/换科目后重新计；
 * - 没有 streak、债务、逾期概念。
 */

export interface RhythmConfig {
  /** 总开关 */
  enabled: boolean;
  /** 单轮专注分钟数 */
  focusMin: number;
  /** 短休息参考分钟数 */
  breakMin: number;
  /** 每几轮后建议长休息 */
  longBreakEvery: number;
  /** 长休息参考分钟数 */
  longBreakMin: number;
}

export const RHYTHM_PRESETS: Record<string, RhythmConfig> = {
  off: { enabled: false, focusMin: 25, breakMin: 5, longBreakEvery: 4, longBreakMin: 15 },
  classic: { enabled: true, focusMin: 25, breakMin: 5, longBreakEvery: 4, longBreakMin: 15 },
  flow: { enabled: true, focusMin: 52, breakMin: 17, longBreakEvery: 2, longBreakMin: 30 },
  deep: { enabled: true, focusMin: 90, breakMin: 20, longBreakEvery: 2, longBreakMin: 30 },
};

export function isValidRhythm(r: unknown): r is RhythmConfig {
  if (typeof r !== 'object' || r === null) return false;
  const c = r as Partial<RhythmConfig>;
  return (
    typeof c.enabled === 'boolean' &&
    typeof c.focusMin === 'number' && c.focusMin >= 5 && c.focusMin <= 120 &&
    typeof c.breakMin === 'number' && c.breakMin >= 1 && c.breakMin <= 60 &&
    typeof c.longBreakEvery === 'number' && c.longBreakEvery >= 2 && c.longBreakEvery <= 8 &&
    typeof c.longBreakMin === 'number' && c.longBreakMin >= 5 && c.longBreakMin <= 90
  );
}

export interface RhythmStatus {
  /** 当前轮次（从 1 开始） */
  round: number;
  /** 本轮已过秒数 */
  roundElapsedSec: number;
  /** 本轮剩余参考秒数（到节奏点）；到达后为 0 */
  roundRemainingSec: number;
  /** 当前轮进度 0..1（到节奏点封顶 1） */
  progress: number;
  /** 是否已到节奏点（可提示休息） */
  atCheckpoint: boolean;
  /** 已完成整轮数（本连续段内） */
  completedRounds: number;
  /** 到节奏点时建议的休息类型 */
  suggestedBreak: 'short' | 'long' | null;
  /** 建议休息秒数 */
  suggestedBreakSec: number;
}

/**
 * 由"当前连续专注段已过秒数"推导节奏状态。
 * 段 = 最近一次 resume/start 之后的连续 running 时间。暂停即断段：节奏参考重新开始，
 * 但记录不受影响（不支配用户）。
 */
export function rhythmStatus(segElapsedSec: number, cfg: RhythmConfig): RhythmStatus {
  const focusSec = cfg.focusMin * 60;
  const elapsed = Math.max(0, Math.floor(segElapsedSec));
  const completedRounds = Math.floor(elapsed / focusSec);
  const roundElapsedSec = elapsed - completedRounds * focusSec;
  const round = completedRounds + 1;
  const atCheckpoint = elapsed > 0 && roundElapsedSec === 0;
  // 到达节奏点时按"刚完成的轮数"决定短/长休息；未到点则按"下一个节奏点"预示
  const nextCompleted = atCheckpoint ? completedRounds : completedRounds + 1;
  const isLong = nextCompleted > 0 && nextCompleted % cfg.longBreakEvery === 0;
  const suggestedBreak: 'short' | 'long' | null = elapsed === 0 ? null : isLong ? 'long' : 'short';
  return {
    round,
    roundElapsedSec,
    roundRemainingSec: Math.max(0, focusSec - roundElapsedSec),
    progress: atCheckpoint ? 1 : Math.min(1, roundElapsedSec / focusSec),
    atCheckpoint,
    completedRounds,
    suggestedBreak,
    suggestedBreakSec: isLong ? cfg.longBreakMin * 60 : cfg.breakMin * 60,
  };
}

/** 轮次指示点：一个周期内的完成/当前/剩余（供 UI 渲染）。 */
export function rhythmDots(status: RhythmStatus, cfg: RhythmConfig): Array<'done' | 'current' | 'todo'> {
  const total = cfg.longBreakEvery;
  const doneInCycle = status.completedRounds % total;
  const dots: Array<'done' | 'current' | 'todo'> = [];
  for (let i = 0; i < total; i++) {
    if (i < doneInCycle) dots.push('done');
    else if (i === doneInCycle) dots.push('current');
    else dots.push('todo');
  }
  return dots;
}
