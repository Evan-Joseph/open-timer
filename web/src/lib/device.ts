/** 全屏兼容层：Pad 与 Desktop 共享同一前端；仅在用户点击设置中的入口时请求。 */

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
