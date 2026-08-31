/** 统一 Motion 过渡：尊重系统减弱动态效果与应用内“动画”开关。 */

import { useMemo } from 'react';
import { useAnimationsEnabled } from './settings.js';

export const MOTION_EASE = [0.2, 0, 0, 1] as const;

/**
 * Operate 型界面的浮层/视图过渡统一为设计 token 的 250ms。
 * 关闭动画时不保留首帧或退出帧，避免看似已关闭却仍缓动的 Motion 分支。
 */
export function useMotionTransition() {
  const enabled = useAnimationsEnabled();
  return useMemo(
    () => (enabled ? { duration: 0.25, ease: MOTION_EASE } : { duration: 0 }),
    [enabled],
  );
}

export function useMotionInitial<T>(initial: T): T | false {
  const enabled = useAnimationsEnabled();
  return enabled ? initial : false;
}
