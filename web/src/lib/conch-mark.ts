/**
 * 神奇海螺开工标记：由海螺推荐「开始这个科目」创建的会话，
 * 结束反馈卡弹出时展示本次开始时的计划；它不是结束备注。
 * 设备本地、一次性消费：读完即删，重复结束/继续再结束不重复预填。
 */

const KEY = 'clock-conch-started';

export interface ConchStartMark {
  sessionId: string;
  intentNote: string;
}

export function saveConchStartMark(mark: ConchStartMark): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mark));
  } catch {
    /* 隐私模式静默降级 */
  }
}

/** 会话与标记匹配则返回开始时计划；无论匹配与否都清除标记（一次性）。 */
export function consumeConchStartMark(sessionId: string): ConchStartMark | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const mark = JSON.parse(raw) as ConchStartMark;
    return mark.sessionId === sessionId && typeof mark.intentNote === 'string' ? mark : null;
  } catch {
    return null;
  }
}
