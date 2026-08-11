import { useEffect, useState } from 'react';
import { useClockStore } from './lib/store.js';
import { useSettings } from './lib/settings.js';
import { ambient } from './lib/ambient.js';
import AuthGate from './components/AuthGate.js';
import ClockFace from './components/ClockFace.js';
import Timeline from './components/Timeline.js';
import SettingsDialog from './components/SettingsDialog.js';
import { Settings, Maximize2, GanttChart, List } from 'lucide-react';

export default function App() {
  const store = useClockStore();
  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** 全屏模式下时间轴是否展开 */
  const [fsShowTimeline, setFsShowTimeline] = useState(false);
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

  // 全屏状态跟踪
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  };

  // 退出全屏时恢复时间轴显示状态
  useEffect(() => {
    if (!isFullscreen) setFsShowTimeline(false);
  }, [isFullscreen]);

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
    <div className={`app ${isFullscreen ? 'fullscreen-mode' : ''}`}>
      <header className="topbar material">
        <span className="topbar-title">沉浸时钟</span>
        <span className={`topbar-status-dot ${store.state?.active_session?.status === 'running' ? 'live' : ''}`} aria-hidden />
        <span className="topbar-date">{store.todayDate} · 北京时间</span>
        <button className="icon-btn" aria-label="全屏沉浸模式" title="全屏" onClick={toggleFullscreen}>
          <Maximize2 size={16} />
        </button>
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

      {isFullscreen && (
        <div className="fs-controls">
          <button
            className="fs-control-btn"
            onClick={() => setFsShowTimeline((v) => !v)}
            aria-label={fsShowTimeline ? '收起时间轴' : '展开时间轴'}
            title={fsShowTimeline ? '收起时间轴' : '展开时间轴'}
          >
            {fsShowTimeline ? <List size={15} /> : <GanttChart size={15} />}
            <span>{fsShowTimeline ? '收起时间轴' : '展开时间轴'}</span>
          </button>
          <span className="fs-hint">按 Esc 退出全屏</span>
        </div>
      )}

      {(!isFullscreen || fsShowTimeline) && <Timeline store={store} />}

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
