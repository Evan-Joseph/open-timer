import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Maximize, X } from 'lucide-react';
import { setAnimationsEnabled, useAnimationsEnabled, useSettings, updateSettings } from '../lib/settings.js';
import { AMBIENT_LABELS } from '../lib/ambient.js';
import { detectDeviceRole, requestAppFullscreen } from '../lib/device.js';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  theme: string;
  onThemeChange: (t: string) => void;
  onLogout: () => Promise<void>;
  /** 只读监督态隐藏退出登录（本就没有登录会话） */
  isOwner: boolean;
}

export default function SettingsDialog({ open, onOpenChange, theme, onThemeChange, onLogout, isOwner }: Props) {
  const settings = useSettings();
  const animationsOn = useAnimationsEnabled();
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** 进入全屏被浏览器拒绝时的可理解反馈（权限、iframe 沙箱或不支持） */
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  const enterFullscreen = () => {
    setFullscreenError(null);
    if (requestAppFullscreen()) {
      onOpenChange(false);
    } else {
      setFullscreenError('浏览器拒绝了全屏请求。请改用 F11 或浏览器菜单进入全屏，应用会自动切换布局。');
    }
  };
  const deviceRole = detectDeviceRole();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <Dialog.Title className="dialog-title">设置</Dialog.Title>

          <div className="setting-row setting-row-inline">
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

          <div className="setting-row setting-row-inline">
            <span className="setting-label">结束提示音</span>
            <div className="seg-control" role="radiogroup" aria-label="结束提示音">
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

          <div className="setting-row setting-row-inline">
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
                  onClick={() => setAnimationsEnabled(value === 'on')}
                >
                  {label}
                </button>
              ))}
            </div>
            {reduced && <p className="setting-hint">系统开启了「减弱动态效果」，动画已自动关闭。</p>}
          </div>

          <div className="setting-row">
            <span className="setting-label">全屏</span>
            <div>
              <button
                className="ghost-btn"
                data-testid="settings-fullscreen-btn"
                onClick={() => void enterFullscreen()}
              >
                <Maximize size={15} aria-hidden /> 进入全屏
              </button>
            </div>
            {fullscreenError && <p className="setting-hint setting-hint-error" role="status">{fullscreenError}</p>}
            <p className="setting-hint">
              副屏会在首次触摸后尝试全屏。当前识别：<strong>{deviceRole === 'secondary' ? '副屏（Pad）' : '主控（电脑）'}</strong>。
            </p>
          </div>

          <div className="setting-row">
            <span className="setting-label">说明</span>
            <p className="setting-hint">
              计时结束只表示这段时间已记录，不代表学习任务完成或掌握。真实作答、错因与复习由 study-ledger 管理。
            </p>
          </div>

          {isOwner && (
            <div className="setting-row">
              <button
                className="danger-btn"
                onClick={async () => {
                  await onLogout();
                  onOpenChange(false);
                }}
              >
                退出登录
              </button>
            </div>
          )}

          <Dialog.Close className="icon-btn dialog-close" aria-label="关闭">
            <X size={16} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
