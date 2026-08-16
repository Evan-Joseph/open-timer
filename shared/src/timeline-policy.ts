export type TimelineScale = 'default' | 'full-day' | 'effective-day';

export interface MinuteRange {
  startMinute: number;
  endMinute: number;
}

export const LEARNING_DAY: MinuteRange = {
  startMinute: 8 * 60,
  endMinute: 22 * 60 + 30,
};

const DEFAULT_WINDOW_MINUTES = 4 * 60;
const DEFAULT_ANCHOR_POSITION = 0.6;
const EFFECTIVE_PADDING_MINUTES = 30;

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
  intervals: MinuteRange[],
  anchorMinute: number,
): MinuteRange {
  if (scale === 'full-day' || (scale === 'effective-day' && intervals.length === 0)) {
    return { ...LEARNING_DAY };
  }

  if (scale === 'effective-day') {
    const first = Math.min(...intervals.map((interval) => interval.startMinute));
    const last = Math.max(...intervals.map((interval) => interval.endMinute));
    return {
      startMinute: Math.max(LEARNING_DAY.startMinute, first - EFFECTIVE_PADDING_MINUTES),
      endMinute: Math.min(LEARNING_DAY.endMinute, last + EFFECTIVE_PADDING_MINUTES),
    };
  }

  const desiredStart = Math.round(anchorMinute - DEFAULT_WINDOW_MINUTES * DEFAULT_ANCHOR_POSITION);
  const startMinute = Math.max(
    LEARNING_DAY.startMinute,
    Math.min(desiredStart, LEARNING_DAY.endMinute - DEFAULT_WINDOW_MINUTES),
  );
  return { startMinute, endMinute: startMinute + DEFAULT_WINDOW_MINUTES };
}
