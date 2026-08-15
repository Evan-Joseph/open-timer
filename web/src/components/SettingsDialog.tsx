import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useSettings, updateSettings } from '../lib/settings.js';
import { AMBIENT_LABELS } from '../lib/ambient.js';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  theme: string;
  onThemeChange: (t: string) => void;
  onLogout: () => Promise<void>;
}

export default function SettingsDialog({ open, onOpenChange, theme, onThemeChange, onLogout }: Props) {
  const settings = useSettings();
  const animationsOn = localStorage.getItem('clock-animations') !== 'off';
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <Dialog.Title className="dialog-title">设置</Dialog.Title>

          <div className="setting-row">
            <span className="setting-label">外观</span>
            <div className="seg-control" role="radiogroup" aria-label="主题">
              {[
                ['light', '浅色'],
                ['dark', '深色'],
                ['auto', '跟随系统'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={theme === value}
                  className={`seg-item ${theme === value ? 'active' : ''}`}
                  onClick={() => onThemeChange(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span className="setting-label">结束提示音</span>
            <div className="seg-control" role="radiogroup" aria-label="结束计时提示音">
              {[
                ['off', '关闭'],
                ['on', '开启'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={settings.finishSound === (value === 'on')}
                  className={`seg-item ${settings.finishSound === (value === 'on') ? 'active' : ''}`}
                  onClick={() => updateSettings({ finishSound: value === 'on' })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span className="setting-label">环境音（默认关闭）</span>
            <div className="ambient-list" role="radiogroup" aria-label="环境音">
              {(['none', 'rain', 'wind', 'waves', 'fire', 'cafe', 'tick'] as const).map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={settings.ambientKind === k}
                  className={`ambient-item ${settings.ambientKind === k ? 'active' : ''}`}
                  onClick={() => updateSettings({ ambientKind: k })}
                >
                  {k === 'none' ? '关闭' : AMBIENT_LABELS[k]}
                </button>
              ))}
            </div>
            <label className="ambient-volume">
              <span>音量 <output>{Math.round(settings.ambientVolume * 100)}%</output></span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(settings.ambientVolume * 100)}
                onChange={(e) => updateSettings({ ambientVolume: Number(e.target.value) / 100 })}
                aria-label="环境音音量"
              />
            </label>
            <p className="setting-hint">
              全部由浏览器实时合成。新用户默认 45%，实际响度仍取决于系统、浏览器和耳机音量；建议先低后高调整。刷新后需点击页面恢复声音（浏览器自动播放限制）。
            </p>
          </div>

          <div className="setting-row">
            <span className="setting-label">动画</span>
            <div className="seg-control" role="radiogroup" aria-label="动画">
              {[
                ['on', '开'],
                ['off', '关'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={animationsOn === (value === 'on')}
                  className={`seg-item ${animationsOn === (value === 'on') ? 'active' : ''}`}
                  disabled={reduced}
                  onClick={() => {
                    localStorage.setItem('clock-animations', value);
                    window.location.reload();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {reduced && <p className="setting-hint">系统开启了「减弱动态效果」，动画已自动关闭。</p>}
          </div>

          <div className="setting-row">
            <span className="setting-label">说明</span>
            <p className="setting-hint">
              计时结束只表示这段时间已记录，不代表学习任务完成或掌握。真实作答、错因与复习由 study-ledger 管理。
            </p>
          </div>

          <div className="setting-row">
            <button className="danger-btn" onClick={() => void onLogout()}>
              退出登录
            </button>
          </div>

          <Dialog.Close className="icon-btn dialog-close" aria-label="关闭">
            <X size={16} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
