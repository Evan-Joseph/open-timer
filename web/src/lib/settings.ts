/** 本地设置（localStorage）：节奏、提醒、声音。纯展示参考，不进服务端契约。 */

import { useEffect, useState } from 'react';
import type { RhythmConfig } from '@clock/shared';
import { RHYTHM_PRESETS, isValidRhythm } from '@clock/shared';
import type { AmbientKind } from './ambient.js';

const KEY = 'clock-settings-v2';

export interface LocalSettings {
  rhythm: RhythmConfig;
  /** 到节奏点时显示温和提示（页面内，非系统通知） */
  rhythmNudge: boolean;
  /** 结束时轻音效（默认关） */
  finishSound: boolean;
  /** 节奏阶段切换铃声（默认关） */
  rhythmChime: boolean;
  /** 环境音类型（默认 none） */
  ambientKind: AmbientKind;
  /** 环境音音量 0..1 */
  ambientVolume: number;
}

const DEFAULTS: LocalSettings = {
  rhythm: RHYTHM_PRESETS.off,
  rhythmNudge: true,
  finishSound: false,
  rhythmChime: false,
  ambientKind: 'none',
  ambientVolume: 0.35,
};

function load(): LocalSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return {
      rhythm: isValidRhythm(parsed.rhythm) ? parsed.rhythm : DEFAULTS.rhythm,
      rhythmNudge: typeof parsed.rhythmNudge === 'boolean' ? parsed.rhythmNudge : true,
      finishSound: typeof parsed.finishSound === 'boolean' ? parsed.finishSound : false,
      rhythmChime: typeof parsed.rhythmChime === 'boolean' ? parsed.rhythmChime : false,
      ambientKind: typeof parsed.ambientKind === 'string' ? parsed.ambientKind : 'none',
      ambientVolume: typeof parsed.ambientVolume === 'number' ? parsed.ambientVolume : DEFAULTS.ambientVolume,
    };
  } catch {
    return DEFAULTS;
  }
}

/** 简单的全局设置 store（跨组件同步用自定义事件）。 */
const EVT = 'clock-settings-changed';

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
