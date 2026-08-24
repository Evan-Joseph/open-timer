/**
 * 设备角色（2026-08-24）：主控（电脑）/ 副屏（Pad）。
 *
 * 识别顺序：手动覆盖（?role= 或 localStorage）→ UA 识别。
 * - iPad：显式 iPad UA；或 iPadOS 13+ 伪装成 Mac（触控点 >1 的 "Mac" 即 iPad）。
 * - Android 平板：UA 含 Android 且不含 Mobile（手机带 Mobile）。
 * 副屏定位 = 桌面陪伴屏：保留时钟 + 核心计时控制 + 时间轴展示，
 * 隐藏会发起额外请求/重操作的浮层入口（神奇海螺、近 7 天回顾），主控全功能。
 */

export type DeviceRole = 'main' | 'secondary';

const ROLE_KEY = 'clock-device-role';

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
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'secondary';
  return 'main';
}
