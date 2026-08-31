/**
 * 被动设备角色信号：Pad 与 Desktop 共用完整布局，但需要可见、可测试的识别结果。
 * 它不会隐藏功能、改写布局或自动请求全屏；全屏仍只能由用户在设置中主动触发。
 */
export type DeviceRole = 'desktop' | 'pad';

const ROLE_KEY = 'clock-device-role';
const ANDROID_TABLET_UA = /Tablet|\bTab\b|MediaPad|MatePad|\bPad\b|SM-T|SM-X|TB-|YT-|Redmi\s*Pad|Mi\s*Pad/i;

function roleFromOverride(value: string | null): DeviceRole | null {
  if (value === 'desktop' || value === 'main') return 'desktop';
  if (value === 'pad' || value === 'secondary') return 'pad';
  return null;
}

/**
 * 优先使用诊断覆盖（?device=pad|desktop；兼容旧 ?role=main|secondary），再识别 iPad/iPadOS
 * 与 Android 平板。手机继续归入 desktop，因为当前产品只定义横屏 Pad/Desktop 两类界面。
 */
export function detectDeviceRole(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): DeviceRole {
  try {
    const query = new URLSearchParams(window.location.search);
    const override = roleFromOverride(query.get('device')) ?? roleFromOverride(query.get('role'));
    if (override) return override;
    const saved = roleFromOverride(localStorage.getItem(ROLE_KEY));
    if (saved) return saved;
  } catch {
    // 隐私模式、预渲染或非浏览器测试环境继续走 UA 识别。
  }

  if (/iPad/i.test(ua)) return 'pad';
  if (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) return 'pad';
  if (/Android/i.test(ua)) {
    if (ANDROID_TABLET_UA.test(ua)) return 'pad';
    try {
      const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
      const shortSide = Math.min(window.screen.width, window.screen.height);
      if (coarsePointer && shortSide >= 600) return 'pad';
    } catch {
      // 缺少屏幕或 pointer API 时保守回落到 desktop。
    }
  }
  return 'desktop';
}

/* ---------- 全屏兼容层 ---------- */

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

/** 发起全屏（含厂商前缀回退）。仅在浏览器确认成功后返回 true。 */
export async function requestAppFullscreen(): Promise<boolean> {
  const d = document as FsDoc;
  const enabled = d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? d.mozFullScreenEnabled ?? d.msFullscreenEnabled;
  if (enabled === false) return false;
  if (isAppFullscreen()) return true;
  const el = document.documentElement as FsEl;
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen ?? el.mozRequestFullScreen ?? el.msRequestFullscreen;
  if (typeof req !== 'function') return false;
  try {
    await req.call(el);
    return true;
  } catch {
    return false;
  }
}
