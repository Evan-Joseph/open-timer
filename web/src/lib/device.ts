/**
 * 设备角色（2026-08-24）：主控（电脑）/ 副屏（Pad）。
 *
 * 识别顺序：手动覆盖（?role= 或 localStorage）→ UA 识别。
 * - iPad：显式 iPad UA；或 iPadOS 13+ 伪装成 Mac（触控点 >1 的 "Mac" 即 iPad）。
 * - Android 平板：显式平板标记（Tablet/Tab/常见平板型号段）；注意 Chrome 在
 *   安卓平板上的 UA 也带 "Mobile"，故不能只用「不含 Mobile」判断，兜底用
 *   粗指针 + 短边 ≥600 CSS px（手机短边普遍 <450）。
 * 副屏定位 = 桌面陪伴屏：保留时钟 + 核心计时控制 + 时间轴展示，
 * Hide heavy overlays (AI assistant and seven-day review) on secondary displays.
 */

export type DeviceRole = 'main' | 'secondary';

const ROLE_KEY = 'clock-device-role';

/** 安卓平板的显式 UA 标记（型号段覆盖联想/华为/三星/小米等常见平板；
 *  不裸匹配 Lenovo——联想手机 UA 也带 Lenovo）。 */
const ANDROID_TABLET_UA = /Tablet|\bTab\b|MediaPad|MatePad|\bPad\b|SM-T|SM-X|TB-|YT-|Redmi\s*Pad|Mi\s*Pad/i;

export function detectDeviceRole(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): DeviceRole {
  // 手动覆盖：调试与特殊需求优先（?role=secondary / localStorage）
  try {
    const param = new URLSearchParams(window.location.search).get('role');
    if (param === 'main' || param === 'secondary') return param;
    const saved = localStorage.getItem(ROLE_KEY);
    if (saved === 'main' || saved === 'secondary') return saved;
  } catch {
    /* 隐私模式等场景按 UA 走 */
  }
  if (/iPad/i.test(ua)) return 'secondary';
  if (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) {
    return 'secondary';
  }
  if (/Android/i.test(ua)) {
    if (ANDROID_TABLET_UA.test(ua)) return 'secondary';
    try {
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const shortSide = Math.min(window.screen.width, window.screen.height);
      if (coarse && shortSide >= 600) return 'secondary';
    } catch {
      /* 无 matchMedia 时仅凭 UA */
    }
    return 'main';
  }
  return 'main';
}

/* ---------- 全屏兼容层：部分安卓 WebView/旧内核需要厂商前缀 ---------- */

type FsDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  mozFullScreenEnabled?: boolean;
  msFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
};
type FsEl = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

export function isAppFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement ?? d.mozFullScreenElement ?? d.msFullscreenElement);
}

/** 发起全屏（含厂商前缀回退）。返回是否成功发起请求；失败静默，由调用方决定是否重试。 */
export function requestAppFullscreen(): boolean {
  const d = document as FsDoc;
  const enabled = d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? d.mozFullScreenEnabled ?? d.msFullscreenEnabled;
  if (enabled === false) return false;
  if (isAppFullscreen()) return true;
  const el = document.documentElement as FsEl;
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen ?? el.mozRequestFullScreen ?? el.msRequestFullscreen;
  if (typeof req !== 'function') return false;
  try {
    const p = req.call(el);
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
