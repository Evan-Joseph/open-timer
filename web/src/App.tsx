import { useEffect, useMemo, useRef, useState } from 'react';
import { useClockStore } from './lib/store.js';
import { useAnimationsEnabled, useSettings } from './lib/settings.js';
import { PREFS_APPLIED_EVT, pullRemotePrefs, schedulePrefsPush } from './lib/prefs.js';
import { ambient } from './lib/ambient.js';
import AuthGate from './components/AuthGate.js';
import ClockFace from './components/ClockFace.js';
import Timeline from './components/Timeline.js';
import SettingsDialog from './components/SettingsDialog.js';
import { detectDeviceRole } from './lib/device.js';
import { Settings, Lock } from 'lucide-react';

export default function App() {
  const store = useClockStore();
  const settings = useSettings();
  const animationsEnabled = useAnimationsEnabled();
  const deviceRole = useMemo(() => detectDeviceRole(), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 只读监督态的解锁弹层（输入 PIN 转 owner） */
  const [loginOpen, setLoginOpen] = useState(false);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('clock-theme') || 'auto');

  // 主题应用
  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // 多端同步：其他标签页（storage）或远端偏好到达（PREFS_APPLIED_EVT）时重读主题
  useEffect(() => {
    const reload = () => setTheme(localStorage.getItem('clock-theme') || 'auto');
    window.addEventListener('storage', reload);
    window.addEventListener(PREFS_APPLIED_EVT, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(PREFS_APPLIED_EVT, reload);
    };
  }, []);

  /** 主题变更：本地立即生效 + 推送远端（多端同步） */
  const changeTheme = (t: string) => {
    localStorage.setItem('clock-theme', t);
    setTheme(t);
    // 立即应用属性，不依赖 effect 因 state 变化重跑：
    // 若 state 与属性被外部因素短暂不一致（如远端偏好应用/测试重置），点击仍能落定。
    const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    schedulePrefsPush({ theme: t as 'light' | 'dark' | 'auto' });
  };

  // 偏好是低频数据：5 分钟后台校验，返回前台/聚焦时立即校验。
  // 同源标签页的偏好变化由 storage/BroadcastChannel 即时到达，不需要 15 秒烧 Worker 配额。
  const PREFS_POLL_MS = 5 * 60_000;
  const prefsUpdatedAtRef = useRef(0);
  useEffect(() => {
    if (store.phase !== 'ready') return;
    let cancelled = false;
    let timer: number | null = null;
    const pull = async () => {
      const next = await pullRemotePrefs(prefsUpdatedAtRef.current);
      if (!cancelled) prefsUpdatedAtRef.current = next;
    };
    const restartPolling = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      if (document.visibilityState !== 'visible') return;
      void pull();
      timer = window.setInterval(() => void pull(), PREFS_POLL_MS);
    };
    restartPolling();
    const onVisible = () => restartPolling();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [store.phase]);

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

  if (store.phase === 'setup') {
    return <AuthGate phase="setup" onSetup={store.setupPassword} onLogin={store.login} error={store.error} />;
  }

  return (
    <div className="app" data-device-role={deviceRole}>
      <header className="topbar material">
        {/* 品牌名已按 2026-08-20 决策隐藏：顶栏只保留状态点与日期；
            标签页标题（document.title）与 index.html <title> 仍承担识别职责 */}
        <span className={`topbar-status-dot ${store.state?.active_session?.status === 'running' ? 'live' : ''}`} aria-hidden />
        {!store.isOwner && <span className="topbar-readonly-badge">只读监督</span>}
        <span className="topbar-date">{store.todayDate} · 北京时间</span>
        {!store.isOwner && (
          <button
            className="icon-btn"
            aria-label="解锁操作"
            title="输入 PIN 解锁操作"
            onClick={() => setLoginOpen(true)}
            data-testid="unlock-btn"
          >
            <Lock size={18} />
          </button>
        )}
        <button className="icon-btn" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <Settings size={20} />
        </button>
      </header>

      {loginOpen && (
        <AuthGate
          phase="login"
          onSetup={store.setupPassword}
          onLogin={async (p) => {
            const ok = await store.login(p);
            if (ok) setLoginOpen(false);
            return ok;
          }}
          error={store.error}
          onClose={() => setLoginOpen(false)}
        />
      )}

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
        onThemeChange={changeTheme}
        onLogout={store.logout}
        isOwner={store.isOwner}
        deviceRole={deviceRole}
      />
    </div>
  );
}
