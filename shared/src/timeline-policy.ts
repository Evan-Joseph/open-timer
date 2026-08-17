export type TimelineScale = 'default' | 'full-day';

export const LEARNING_DAY: { startMinute: number; endMinute: number } = {
  startMinute: 8 * 60,
  endMinute: 22 * 60 + 30,
};

export const QUIET_PERIODS = [
  { id: 'lunch', label: '午饭', startMinute: 11 * 60, endMinute: 12 * 60 },
  { id: 'nap', label: '午睡', startMinute: 12 * 60, endMinute: 13 * 60 + 30 },
  { id: 'dinner', label: '晚饭', startMinute: 17 * 60, endMinute: 18 * 60 },
] as const;

const DEFAULT_WINDOW_MINUTES = 4 * 60;
const DEFAULT_ANCHOR_POSITION = 0.6;

export function isQuietMinute(minuteOfDay: number): boolean {
  const minute = ((Math.floor(minuteOfDay) % 1440) + 1440) % 1440;
  return (
    minute < LEARNING_DAY.startMinute
    || QUIET_PERIODS.some((period) => minute >= period.startMinute && minute < period.endMinute)
    || minute >= LEARNING_DAY.endMinute
  );
}

export function timelineRange(
  scale: TimelineScale,
  anchorMinute: number,
): { startMinute: number; endMinute: number } {
  if (scale === 'full-day') {
    return { ...LEARNING_DAY };
  }

  const desiredStart = Math.round(anchorMinute - DEFAULT_WINDOW_MINUTES * DEFAULT_ANCHOR_POSITION);
  const startMinute = Math.max(
    LEARNING_DAY.startMinute,
    Math.min(desiredStart, LEARNING_DAY.endMinute - DEFAULT_WINDOW_MINUTES),
  );
  return { startMinute, endMinute: startMinute + DEFAULT_WINDOW_MINUTES };
}
