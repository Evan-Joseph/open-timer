import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { X, Check } from 'lucide-react';
import { useSettings, updateSettings } from '../lib/settings.js';
import { RHYTHM_PRESETS, type RhythmConfig } from '@clock/shared';

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

  // Apple Settings 式选择列表：每档一行，右侧勾选
  const rhythmOptions: Array<{ key: string; title: string; sub: string; config: RhythmConfig }> = [
    {
      key: 'flow',
      title: '平衡 · 52 分专注 / 17 分小憩',
      sub: 'DeskTime 生产力研究的高效比例，适合大多数学习日',
      config: RHYTHM_PRESETS.flow,
    },
    {
      key: 'deep',
      title: '深度 · 90 分专注 / 20 分小憩',
      sub: '贴合人体约 90 分钟的超昼夜节律，适合考研深度心流',
      config: RHYTHM_PRESETS.deep,
    },
    {
      key: 'custom',
      title: '自定义',
      sub: '完全按你自己的节奏来',
      config: r,
    },
  ];
  const selectedKey = !r.enabled ? 'off' : rhythmOptions.find((o) => o.key !== 'custom' && matches(o.config, r))?.key ?? 'custom';

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
            <span className="setting-label">专注节奏</span>
            <div className="rhythm-list" role="radiogroup" aria-label="专注节奏">
              {rhythmOptions.map((o) => {
                const active = selectedKey === o.key;
                return (
                  <button
                    key={o.key}
                    role="radio"
                    aria-checked={active}
                    className={`rhythm-option ${active ? 'active' : ''}`}
                    onClick={() => {
                      if (o.key === 'custom') {
                        updateSettings({ rhythm: { enabled: true, focusMin: 40, breakMin: 10, longBreakEvery: 3, longBreakMin: 20 } });
                      } else {
                        updateSettings({ rhythm: o.config });
                      }
                    }}
                  >
                    <span className="rhythm-option-text">
                      <span className="rhythm-option-title">{o.title}</span>
                      <span className="rhythm-option-sub">{o.sub}</span>
                    </span>
                    {active && (
                      <span className="rhythm-option-check" aria-hidden>
                        <Check size={16} />
                      </span>
                    )}
                  </button>
                );
              })}
              <button
                role="radio"
                aria-checked={selectedKey === 'off'}
                className={`rhythm-option ${selectedKey === 'off' ? 'active' : ''}`}
                onClick={() => updateSettings({ rhythm: RHYTHM_PRESETS.off })}
              >
                <span className="rhythm-option-text">
                  <span className="rhythm-option-title">关闭节奏</span>
                  <span className="rhythm-option-sub">纯计时，不受节奏影响</span>
                </span>
                {selectedKey === 'off' && (
                  <span className="rhythm-option-check" aria-hidden>
                    <Check size={16} />
                  </span>
                )}
              </button>
            </div>
            {selectedKey === 'custom' && (
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
                  小憩
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
            <p className="setting-hint">
              到节奏点时页面会温和提示「可以休息了」；休息够了会提示「可以回来了」。提示只是参考，不会自动暂停或继续。
            </p>
          </div>

          <div className="setting-row">
            <span className="setting-label">提示与声音</span>
            <div className="toggle-lines">
              <label className="switch-row">
                <span>节奏提醒（到点提示休息 / 休息够了提示回归）</span>
                <Switch.Root
                  className="switch-root"
                  checked={settings.rhythmNudge}
                  onCheckedChange={(v) => updateSettings({ rhythmNudge: v })}
                  aria-label="节奏提醒"
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

function matches(a: RhythmConfig, b: RhythmConfig): boolean {
  return a.focusMin === b.focusMin && a.breakMin === b.breakMin && a.longBreakEvery === b.longBreakEvery && a.longBreakMin === b.longBreakMin;
}
