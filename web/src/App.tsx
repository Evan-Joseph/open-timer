import { useEffect, useState } from 'react';
import { useClockStore } from './lib/store.js';
import { useAnimationsEnabled, useSettings } from './lib/settings.js';
import { ambient } from './lib/ambient.js';
import AuthGate from './components/AuthGate.js';
import ClockFace from './components/ClockFace.js';
import Timeline from './components/Timeline.js';
import SettingsDialog from './components/SettingsDialog.js';
import { Settings } from 'lucide-react';

export default function App() {
  const store = useClockStore();
  const settings = useSettings();
  const animationsEnabled = useAnimationsEnabled();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('clock-theme') || 'auto');

  // 主题应用
  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    };
    apply();
    localStorage.setItem('clock-theme', theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // 动画开关：off 时给 <html> 挂 class，CSS 层全局归零（与组件层 motion 跳过并存）
  useEffect(() => {
    document.documentElement.classList.toggle('animations-off', !animationsEnabled);
  }, [animationsEnabled]);

  // 标签页标题反映运行状态
  useEffect(() => {
    const base = '11408 沉浸时钟';
    const s = store.state?.active_session;
    if (s && s.status === 'running') {
      const subj = store.subjects.find((x) => x.subject_id === s.subject_id)?.display_name ?? s.subject_id;
      document.title = `▶ ${subj} · ${base}`;
    } else if (s && s.status === 'paused') {
      document.title = `⏸ 已暂停 · ${base}`;
    } else {
      document.title = base;
    }
  }, [store.state, store.subjects]);

  // 环境音生命周期：设置变化时启停；后台标签页保持播放（不打断沉浸听感）
  useEffect(() => {
    if (settings.ambientKind === 'none') {
      ambient.stop();
    } else {
      ambient.setVolume(settings.ambientVolume);
      if (ambient.kind() !== settings.ambientKind) ambient.start(settings.ambientKind);
    }
  }, [settings.ambientKind, settings.ambientVolume]);

  // 浏览器 autoplay 策略：刷新后无手势时 AudioContext 保持 suspended（静音）。
  // 注册一次性手势监听，首次任意点击/按键时恢复；成功后自动移除，避免反复挂监听。
  useEffect(() => {
    if (settings.ambientKind === 'none') return;
    const unlock = () => {
      ambient.ensureAudible();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, [settings.ambientKind]);

  // 全屏（2026-08-20 决策）：Pad/Desktop/全屏共用同一套布局与代码。
  // 进入全屏只是视口变大，顶栏、主时钟、时间轴原样保留，尺寸由既有的
  // dvh/clamp 响应式规则自适应；不再维护 fullscreen-mode 分支、控制条或抽屉。

  if (store.phase === 'loading') {
    return (
      <div className="boot">
        <div className="boot-dot" aria-hidden />
      </div>
    );
  }

  if (store.phase === 'setup' || store.phase === 'login') {
    return <AuthGate phase={store.phase} onSetup={store.setupPassword} onLogin={store.login} error={store.error} />;
  }

  return (
    <div className="app">
      <header className="topbar material">
        {/* 品牌名已按 2026-08-20 决策隐藏：顶栏只保留状态点与日期；
            标签页标题（document.title）与 index.html <title> 仍承担识别职责 */}
        <span className={`topbar-status-dot ${store.state?.active_session?.status === 'running' ? 'live' : ''}`} aria-hidden />
        <span className="topbar-date">{store.todayDate} · 北京时间</span>
        <button className="icon-btn" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <Settings size={20} />
        </button>
      </header>

      {store.error && (
        <div className="sync-banner" role="status">
          {store.error}
        </div>
      )}

      {store.toast && (
        <div className="toast" role="status" aria-live="polite" data-testid="toast">
          {store.toast}
        </div>
      )}

      <main className="main">
        <ClockFace store={store} />
      </main>

      <Timeline store={store} />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        theme={theme}
        onThemeChange={setTheme}
        onLogout={store.logout}
      />
    </div>
  );
}
