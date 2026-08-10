import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { X } from 'lucide-react';
import { useSettings, updateSettings } from '../lib/settings.js';
import { RHYTHM_PRESETS } from '@clock/shared';

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

  const r = settings.rhythm;
  const presetKey = !r.enabled
    ? 'off'
    : r.focusMin === 52 && r.breakMin === 17
      ? 'flow'
      : 'classic';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content material" aria-describedby={undefined}>
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
            <span className="setting-label">专注节奏（可选参考，不会自动暂停）</span>
            <div className="seg-control" role="radiogroup" aria-label="专注节奏">
              {[
                ['off', '关闭'],
                ['classic', '经典 25/5'],
                ['flow', '沉浸 52/17'],
                ['custom', '自定义'],
              ].map(([value, label]) => {
                const active = presetKey === value || (value === 'custom' && r.enabled && presetKey === 'classic' && isCustom(r));
                return (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={active}
                    className={`seg-item ${active ? 'active' : ''}`}
                    onClick={() => {
                      if (value === 'off') updateSettings({ rhythm: RHYTHM_PRESETS.off });
                      else if (value === 'classic') updateSettings({ rhythm: RHYTHM_PRESETS.classic });
                      else if (value === 'flow') updateSettings({ rhythm: RHYTHM_PRESETS.flow });
                      else updateSettings({ rhythm: { ...r, enabled: true } });
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {r.enabled && (
              <div className="rhythm-custom">
                <label className="rhythm-field">
                  专注
                  <input
                    type="number"
                    min={5}
                    max={120}
                    value={r.focusMin}
                    onChange={(e) => updateSettings({ rhythm: { ...r, focusMin: clamp(Number(e.target.value), 5, 120) } })}
                  />
                  分
                </label>
                <label className="rhythm-field">
                  短休
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={r.breakMin}
                    onChange={(e) => updateSettings({ rhythm: { ...r, breakMin: clamp(Number(e.target.value), 1, 60) } })}
                  />
                  分
                </label>
                <label className="rhythm-field">
                  每
                  <input
                    type="number"
                    min={2}
                    max={8}
                    value={r.longBreakEvery}
                    onChange={(e) => updateSettings({ rhythm: { ...r, longBreakEvery: clamp(Number(e.target.value), 2, 8) } })}
                  />
                  轮长休
                  <input
                    type="number"
                    min={5}
                    max={90}
                    value={r.longBreakMin}
                    onChange={(e) => updateSettings({ rhythm: { ...r, longBreakMin: clamp(Number(e.target.value), 5, 90) } })}
                  />
                  分
                </label>
              </div>
            )}
            <p className="setting-hint">到节奏点只给温和提示，你可以随时忽略继续专注。休息 = 暂停，不计学习时长。</p>
          </div>

          <div className="setting-row">
            <span className="setting-label">提示与声音</span>
            <div className="toggle-lines">
              <label className="switch-row">
                <span>到节奏点时温和提示休息</span>
                <Switch.Root
                  className="switch-root"
                  checked={settings.rhythmNudge}
                  onCheckedChange={(v) => updateSettings({ rhythmNudge: v })}
                  aria-label="到节奏点时温和提示休息"
                >
                  <Switch.Thumb className="switch-thumb" />
                </Switch.Root>
              </label>
              <label className="switch-row">
                <span>结束计时时播放轻提示音</span>
                <Switch.Root
                  className="switch-root"
                  checked={settings.finishSound}
                  onCheckedChange={(v) => updateSettings({ finishSound: v })}
                  aria-label="结束计时时播放轻提示音"
                >
                  <Switch.Thumb className="switch-thumb" />
                </Switch.Root>
              </label>
            </div>
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

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function isCustom(r: { focusMin: number; breakMin: number }): boolean {
  return !(r.focusMin === 25 && r.breakMin === 5) && !(r.focusMin === 52 && r.breakMin === 17);
}
