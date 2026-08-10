import { useEffect, useState } from 'react';
import { useClockStore } from './lib/store.js';
import AuthGate from './components/AuthGate.js';
import ClockFace from './components/ClockFace.js';
import Timeline from './components/Timeline.js';
import SettingsDialog from './components/SettingsDialog.js';
import { Settings } from 'lucide-react';

export default function App() {
  const store = useClockStore();
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
        <span className="topbar-title">沉浸时钟</span>
        <span className={`topbar-status-dot ${store.state?.active_session?.status === 'running' ? 'live' : ''}`} aria-hidden />
        <span className="topbar-date">{store.todayDate} · 北京时间</span>
        <button className="icon-btn" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <Settings size={18} />
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
