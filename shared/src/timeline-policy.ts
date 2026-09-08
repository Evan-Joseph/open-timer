export type TimelineScale = 'default' | 'full-day';

/** 全天泳道：00:00–24:00 完整暴露一天的所有时段。 */
export const FULL_DAY: { startMinute: number; endMinute: number } = {
  startMinute: 0,
  endMinute: 24 * 60,
};

export const LEARNING_DAY: { startMinute: number; endMinute: number } = {
  startMinute: 8 * 60,
  endMinute: 22 * 60 + 30,
};

export const QUIET_PERIODS = [
  { id: 'lunch', label: '午饭', startMinute: 11 * 60 + 20, endMinute: 12 * 60 + 25 },
  { id: 'nap', label: '午睡', startMinute: 12 * 60 + 25, endMinute: 13 * 60 + 40 },
  { id: 'dinner', label: '晚饭', startMinute: 17 * 60 + 15, endMinute: 18 * 60 + 25 },
  { id: 'evening', label: '晚间收尾', startMinute: 21 * 60 + 45, endMinute: 22 * 60 + 30 },
  { id: 'night', label: '夜间', startMinute: 22 * 60 + 30, endMinute: 8 * 60 },
] as const;

const DEFAULT_WINDOW_MINUTES = 4 * 60;
const DEFAULT_ANCHOR_POSITION = 0.6;

/** 跨午夜的静默段按渲染窗口拆成不跨界的片段（00:00–08:00 与 22:30–24:00）。 */
export function quietPeriodSegments(
  range: { startMinute: number; endMinute: number },
): Array<{ id: string; label: string; startMinute: number; endMinute: number }> {
  const pieces: Array<{ id: string; label: string; startMinute: number; endMinute: number }> = [];
  for (const period of QUIET_PERIODS) {
    if (period.startMinute >= period.endMinute) {
      pieces.push(
        { id: period.id, label: period.label, startMinute: period.startMinute, endMinute: 24 * 60 },
        { id: period.id, label: period.label, startMinute: 0, endMinute: period.endMinute },
      );
    } else {
      pieces.push({ id: period.id, label: period.label, startMinute: period.startMinute, endMinute: period.endMinute });
    }
  }
  return pieces.flatMap((period) => {
    const startMinute = Math.max(period.startMinute, range.startMinute);
    const endMinute = Math.min(period.endMinute, range.endMinute);
    return endMinute > startMinute
      ? [{ id: period.id, label: period.label, startMinute, endMinute }]
      : [];
  });
}

export function isQuietMinute(minuteOfDay: number): boolean {
  const minute = ((Math.floor(minuteOfDay) % 1440) + 1440) % 1440;
  return QUIET_PERIODS.some((period) => {
    if (period.startMinute >= period.endMinute) {
      return minute >= period.startMinute || minute < period.endMinute;
    }
    return minute >= period.startMinute && minute < period.endMinute;
  });
}

export function timelineRange(
  scale: TimelineScale,
  anchorMinute: number,
): { startMinute: number; endMinute: number } {
  if (scale === 'full-day') {
    return { ...FULL_DAY };
  }

  const desiredStart = Math.round(anchorMinute - DEFAULT_WINDOW_MINUTES * DEFAULT_ANCHOR_POSITION);
  const startMinute = Math.max(
    LEARNING_DAY.startMinute,
    Math.min(desiredStart, LEARNING_DAY.endMinute - DEFAULT_WINDOW_MINUTES),
  );
  return { startMinute, endMinute: startMinute + DEFAULT_WINDOW_MINUTES };
}
