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
  off: { enabled: false, focusMin: 50, breakMin: 10, longBreakEvery: 2, longBreakMin: 20 },
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

/* ================= 节奏阶段推导（自动，无需用户启停休息） =================
 * 用户只管启停"学习"；App 根据连续专注秒数自动推断当前应处于的阶段：
 *   focus        — 专注中，未到节奏点
 *   ready_break  — 到节奏点，可以休息了（横幅提示，不自动暂停）
 *   break_ready  — 休息时长已够，可以重新投入（横幅提示，不自动继续）
 * 绝不改变计时状态本身：暂停/继续永远是用户动作，这里只呈现建议。
 */

export type RhythmPhase = 'focus' | 'ready_break' | 'break_ready';

export interface RhythmPhaseInfo {
  phase: RhythmPhase;
  /** focus 阶段：距节奏点的剩余秒数；ready_break：0；break_ready：已超出的休息秒数 */
  seconds: number;
  /** ready_break 时建议的休息类型 */
  suggestedBreak: 'short' | 'long' | null;
}

/**
 * 由"当前开放段已过秒数"与"已离开（暂停中）秒数"推导节奏阶段。
 * @param segSecs   本轮连续专注秒数（running 中的开放段；暂停时冻结在暂停前）
 * @param awaySecs  离开中已过的秒数（paused 才有；running 传 0/null）
 * @param paused    是否处于暂停（离开）状态
 */

/**
 * Flowtime 比例制：根据已专注时长推算匹配的休息时长。
 * - 达到整轮 → 长/短休息（经典番茄）；
 * - 未达整轮 → 专注时长 × (短休/专注) 比例，至少 60 秒，至多不超过短休息时长。
 * 例：90/20 下专注 25 分 → 25×(20/90) ≈ 5.5 分休息；专注 85 分 → ≈19 分。
 */
export function proportionalBreakSecs(focusSecs: number, cfg: RhythmConfig): number {
  const focusSec = cfg.focusMin * 60;
  const shortBreakSec = cfg.breakMin * 60;
  if (focusSecs >= focusSec) {
    const roundsDone = Math.floor(focusSecs / focusSec);
    const isLong = roundsDone > 0 && roundsDone % cfg.longBreakEvery === 0;
    return isLong ? cfg.longBreakMin * 60 : shortBreakSec;
  }
  const ratio = shortBreakSec / focusSec;
  return Math.max(60, Math.min(shortBreakSec, Math.round(focusSecs * ratio)));
}
export function rhythmPhase(segSecs: number, awaySecs: number, paused: boolean, cfg: RhythmConfig): RhythmPhaseInfo {
  const status = rhythmStatus(segSecs, cfg);
  if (!paused) {
    // 专注中：到节奏点 → ready_break；否则 focus
    if (status.atCheckpoint) {
      return { phase: 'ready_break', seconds: 0, suggestedBreak: status.suggestedBreak };
    }
    return { phase: 'focus', seconds: status.roundRemainingSec, suggestedBreak: null };
  }
  // 离开中：到节奏点前暂停 → 仍属 focus 内的短暂离开；到点后暂停 → 比较休息时长
  const away = Math.max(0, Math.floor(awaySecs));
  const target = status.suggestedBreakSec;
  if (status.atCheckpoint && away >= target) {
    return { phase: 'break_ready', seconds: away - target, suggestedBreak: status.suggestedBreak };
  }
  return { phase: 'focus', seconds: Math.max(0, target - away), suggestedBreak: status.suggestedBreak };
}

/* ================= 跨科目/跨会话的当日节奏 =================
 * 节奏周期按"当日累计专注"计算，不随科目或会话重置：
 * 换科目、结束会话都不打断节奏；只有"足够长的休息"才开启新的专注块。
 * 用于空闲态给出"建议休息 X 分 · 预计 HH:MM 重新投入"的提示。
 */

export interface SessionStamp {
  startedAtMs: number;
  endedAtMs: number;
  activeSeconds: number;
}

export interface DayRhythmInfo {
  /** fresh=今天还没专注过；resting=在休息；break_ready=休息够了可重新投入 */
  phase: 'fresh' | 'resting' | 'break_ready';
  /** 当前专注块已累计专注秒数（跨科目） */
  focusAccumSec: number;
  /** 本专注块完成的完整轮数 */
  roundsDone: number;
  /** 当前建议休息秒数 */
  suggestedBreakSec: number;
  /** 已休息秒数 */
  restElapsedSec: number;
  /** 剩余建议休息秒数（resting 时 > 0） */
  restRemainingSec: number;
  /** 预计重新投入的 epoch ms（resting 时非 null） */
  projectedResumeMs: number | null;
  /** 距下一个节奏点还需要的专注秒数 */
  focusRemainingSec: number;
  isLongBreak: boolean;
}

/**
 * 由当天已结束会话序列推导空闲态节奏。
 * @param stamps  当天已结束的会话（startedAtMs/endedAtMs/activeSeconds）
 * @param nowMs   当前时刻
 */
export function dayRhythm(stamps: SessionStamp[], nowMs: number, cfg: RhythmConfig): DayRhythmInfo {
  const focusSec = cfg.focusMin * 60;
  const shortBreakSec = cfg.breakMin * 60;
  const longBreakSec = cfg.longBreakMin * 60;

  const sorted = stamps
    .filter((s) => s.endedAtMs > s.startedAtMs && s.activeSeconds > 0)
    .sort((a, b) => a.startedAtMs - b.startedAtMs);

  // 从后往前找最近一次"超长休息"的分界（gap ≥ 2×最长休息，如 90/20 下为 60 分），
  // 其后的专注为当前专注块；轮间正常休息（短/长休）不切分节奏。
  const blockGapSec = Math.max(shortBreakSec, longBreakSec) * 2;
  let blockStartIdx = 0;
  for (let i = sorted.length - 1; i >= 1; i--) {
    const gap = sorted[i].startedAtMs - sorted[i - 1].endedAtMs;
    if (gap >= blockGapSec * 1000) {
      blockStartIdx = i;
      break;
    }
  }

  let focusAccum = 0;
  for (let i = blockStartIdx; i < sorted.length; i++) focusAccum += sorted[i].activeSeconds;
  const roundsDone = Math.floor(focusAccum / focusSec);
  const isLongBreak = roundsDone > 0 && roundsDone % cfg.longBreakEvery === 0;
  const lastEndMs = sorted.length ? sorted[sorted.length - 1].endedAtMs : 0;

  const fresh: DayRhythmInfo = {
    phase: 'fresh',
    focusAccumSec: 0,
    roundsDone: 0,
    suggestedBreakSec: shortBreakSec,
    restElapsedSec: 0,
    restRemainingSec: 0,
    projectedResumeMs: null,
    focusRemainingSec: focusSec,
    isLongBreak: false,
  };
  if (focusAccum <= 0 || lastEndMs <= 0) return fresh;

  const idleSec = Math.max(0, Math.floor((nowMs - lastEndMs) / 1000));
  // 休息时长匹配最近的专注量（Flowtime 比例制）
  const suggested = proportionalBreakSecs(focusAccum, cfg);

  if (idleSec >= suggested) {
    return {
      phase: 'break_ready',
      focusAccumSec: focusAccum,
      roundsDone,
      suggestedBreakSec: suggested,
      restElapsedSec: idleSec,
      restRemainingSec: 0,
      projectedResumeMs: null,
      focusRemainingSec: Math.max(0, focusSec - focusAccum),
      isLongBreak,
    };
  }
  return {
    phase: 'resting',
    focusAccumSec: focusAccum,
    roundsDone,
    suggestedBreakSec: suggested,
    restElapsedSec: idleSec,
    restRemainingSec: suggested - idleSec,
    projectedResumeMs: lastEndMs + suggested * 1000,
    focusRemainingSec: Math.max(0, focusSec - focusAccum),
    isLongBreak,
  };
}
