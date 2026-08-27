/**
 * AI assistant start marker: sessions started from a recommendation,
 * 结束反馈卡弹出时把推荐语预填为结束备注（一键确认即可）。
 * 设备本地、一次性消费：读完即删，重复结束/继续再结束不重复预填。
 */

const KEY = 'clock-conch-started';

export interface ConchStartMark {
  sessionId: string;
  note: string;
}

export function saveConchStartMark(mark: ConchStartMark): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mark));
  } catch {
    /* 隐私模式静默降级 */
  }
}

/** 会话与标记匹配则返回预填备注；无论匹配与否都清除标记（一次性）。 */
export function consumeConchStartMark(sessionId: string): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    localStorage.removeItem(KEY);
    const mark = JSON.parse(raw) as ConchStartMark;
    return mark.sessionId === sessionId && typeof mark.note === 'string' ? mark.note : null;
  } catch {
    return null;
  }
}
