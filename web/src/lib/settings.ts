/** 本地设置（localStorage）：声音、环境音。纯展示参考，不进服务端契约。 */

import { useEffect, useState } from 'react';
import type { AmbientKind } from './ambient.js';

const KEY = 'clock-settings-v2';

export interface LocalSettings {
  /** 结束时轻音效（默认关） */
  finishSound: boolean;
  /** 环境音类型（默认 none） */
  ambientKind: AmbientKind;
  /** 环境音音量 0..1 */
  ambientVolume: number;
}

const DEFAULTS: LocalSettings = {
  finishSound: false,
  ambientKind: 'none',
  ambientVolume: 0.45,
};

function load(): LocalSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return {
      finishSound: typeof parsed.finishSound === 'boolean' ? parsed.finishSound : false,
      ambientKind: typeof parsed.ambientKind === 'string' ? parsed.ambientKind : 'none',
      ambientVolume: typeof parsed.ambientVolume === 'number' ? parsed.ambientVolume : DEFAULTS.ambientVolume,
    };
  } catch {
    return DEFAULTS;
  }
}

/** 简单的全局设置 store（跨组件同步用自定义事件）。 */
const EVT = 'clock-settings-changed';

function systemPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function areAnimationsEnabled(): boolean {
  return !systemPrefersReducedMotion() && localStorage.getItem('clock-animations') !== 'off';
}

export function setAnimationsEnabled(enabled: boolean): void {
  localStorage.setItem('clock-animations', enabled ? 'on' : 'off');
  window.dispatchEvent(new CustomEvent(EVT));
}

export function useAnimationsEnabled(): boolean {
  const [enabled, setEnabled] = useState(areAnimationsEnabled);
  useEffect(() => {
    const update = () => setEnabled(areAnimationsEnabled());
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    window.addEventListener(EVT, update);
    media.addEventListener('change', update);
    return () => {
      window.removeEventListener(EVT, update);
      media.removeEventListener('change', update);
    };
  }, []);
  return enabled;
}

export function getSettings(): LocalSettings {
  return load();
}

export function updateSettings(patch: Partial<LocalSettings>): void {
  const next = { ...load(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(EVT));
}

export function useSettings(): LocalSettings {
  const [settings, setSettings] = useState<LocalSettings>(load);
  useEffect(() => {
    const onChange = () => setSettings(load());
    window.addEventListener(EVT, onChange);
    return () => window.removeEventListener(EVT, onChange);
  }, []);
  return settings;
}
