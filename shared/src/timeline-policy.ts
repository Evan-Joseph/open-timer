export type TimelineScale = 'default' | 'full-day';

export const LEARNING_DAY: { startMinute: number; endMinute: number } = {
  startMinute: 8 * 60,
  endMinute: 22 * 60 + 30,
};

const DEFAULT_WINDOW_MINUTES = 4 * 60;
const DEFAULT_ANCHOR_POSITION = 0.6;

export function isQuietMinute(minuteOfDay: number): boolean {
  const minute = ((Math.floor(minuteOfDay) % 1440) + 1440) % 1440;
  return (
    minute < LEARNING_DAY.startMinute
    || minute >= 11 * 60 && minute < 13 * 60 + 30
    || minute >= 17 * 60 && minute < 18 * 60
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
