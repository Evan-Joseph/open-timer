/** 应用状态：鉴权、服务端状态同步、写动作。所有秒数以服务端为准。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubjectApi, StateApi, SessionApi, ActiveSessionApi } from './api.js';
import { apiGet, apiPost, apiPatch } from './api.js';
import type { SyncAnchor } from './clock.js';
import { shanghaiTodayLocal } from './clock.js';

export type AuthPhase = 'loading' | 'setup' | 'login' | 'ready';

export interface SubjectWithMeta extends SubjectApi {}

export interface ClockStore {
  phase: AuthPhase;
  subjects: SubjectApi[];
  state: StateApi | null;
  anchor: SyncAnchor | null;
  sessions: SessionApi[];
  todayDate: string;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setupPassword: (p: string) => Promise<boolean>;
  login: (p: string) => Promise<boolean>;
  logout: () => Promise<void>;
  start: (subjectId: string, intentNote: string | null) => Promise<boolean>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: (endNote: string | null) => Promise<void>;
  switchSubject: (subjectId: string) => Promise<void>;
  voidSession: (sessionId: string, reason: string | null) => Promise<void>;
  setNote: (sessionId: string, note: string) => Promise<void>;
}

const POLL_MS = 10_000;

export function useClockStore(): ClockStore {
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [subjects, setSubjects] = useState<SubjectApi[]>([]);
  const [state, setState] = useState<StateApi | null>(null);
  const [sessions, setSessions] = useState<SessionApi[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  /** 每次收到 state 响应时记录单调时刻，供锚点使用 */
  const perfAtStateRef = useRef<number>(0);

  const todayDate = state?.today_date ?? shanghaiTodayLocal();

  const applyState = useCallback((s: StateApi) => {
    perfAtStateRef.current = performance.now();
    setState(s);
  }, []);

  const loadSessions = useCallback(async (date: string) => {
    try {
      const data = await apiGet<{ sessions: SessionApi[] }>(`/api/v1/sessions?date=${date}`);
      setSessions(data.sessions);
    } catch {
      /* 静默：时间轴保留旧数据 */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await apiGet<StateApi>('/api/v1/state');
      applyState(s);
      setError(null);
      await loadSessions(s.today_date);
    } catch (e) {
      setError('暂时无法同步，正在重试');
    }
  }, [applyState, loadSessions]);

  // 初始鉴权探测
  useEffect(() => {
    (async () => {
      try {
        const me = await apiGet<{ authenticated: boolean; setup_done: boolean }>('/api/v1/auth/me');
        if (!me.setup_done) setPhase('setup');
        else if (!me.authenticated) setPhase('login');
        else setPhase('ready');
        const subs = await apiGet<SubjectApi[]>('/api/v1/subjects').catch(() => [] as SubjectApi[]);
        if (subs.length === 0) {
          // subjects 需要凭据；未登录时先占位，登录后再拉
        }
        setSubjects(subs);
      } catch {
        setPhase('login');
      }
    })();
  }, []);

  // ready 后启动轮询
  useEffect(() => {
    if (phase !== 'ready') return;
    refresh();
    pollRef.current = window.setInterval(refresh, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [phase, refresh]);

  // 加载 subjects（ready 后一定有凭据）
  useEffect(() => {
    if (phase !== 'ready') return;
    apiGet<SubjectApi[]>('/api/v1/subjects').then(setSubjects).catch(() => {});
  }, [phase]);

  const setupPassword = useCallback(async (p: string) => {
    const res = await apiPost('/api/v1/auth/setup', { password: p });
    if (res.ok) {
      setPhase('ready');
      return true;
    }
    setError('设置失败，请重试');
    return false;
  }, []);

  const login = useCallback(async (p: string) => {
    const res = await apiPost('/api/v1/auth/login', { password: p });
    if (res.ok) {
      setPhase('ready');
      return true;
    }
    setError('密码不正确');
    return false;
  }, []);

  const logout = useCallback(async () => {
    await apiPost('/api/v1/auth/logout');
    setState(null);
    setPhase('login');
  }, []);

  const activeId = state?.active_session?.session_id ?? null;

  const start = useCallback(
    async (subjectId: string, intentNote: string | null) => {
      setBusy(true);
      const res = await apiPost<{ session_id: string }>('/api/v1/sessions', {
        subject_id: subjectId,
        intent_note: intentNote || null,
      });
      setBusy(false);
      if (!res.ok) {
        setError(res.data && (res.data as any).error === 'ACTIVE_SESSION_EXISTS' ? '已有进行中的会话' : '开始失败');
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const pause = useCallback(async () => {
    if (!activeId) return;
    setBusy(true);
    await apiPost(`/api/v1/sessions/${activeId}/pause`);
    setBusy(false);
    await refresh();
  }, [activeId, refresh]);

  const resume = useCallback(async () => {
    if (!activeId) return;
    setBusy(true);
    await apiPost(`/api/v1/sessions/${activeId}/resume`);
    setBusy(false);
    await refresh();
  }, [activeId, refresh]);

  const stop = useCallback(
    async (endNote: string | null) => {
      if (!activeId) return;
      setBusy(true);
      await apiPost(`/api/v1/sessions/${activeId}/stop`, { end_note: endNote || null });
      setBusy(false);
      await refresh();
    },
    [activeId, refresh],
  );

  const switchSubject = useCallback(
    async (subjectId: string) => {
      if (!activeId) return;
      setBusy(true);
      await apiPost(`/api/v1/sessions/${activeId}/switch`, { subject_id: subjectId });
      setBusy(false);
      await refresh();
    },
    [activeId, refresh],
  );

  const voidSession = useCallback(
    async (sessionId: string, reason: string | null) => {
      setBusy(true);
      await apiPost(`/api/v1/sessions/${sessionId}/void`, { reason });
      setBusy(false);
      await refresh();
    },
    [refresh],
  );

  const setNote = useCallback(
    async (sessionId: string, note: string) => {
      await apiPatch(`/api/v1/sessions/${sessionId}/note`, { note }).catch(() => {});
      await refresh();
    },
    [refresh],
  );

  // 构造单调时钟锚点：随 state 身份 memo，避免每次渲染重新锚定导致秒数跳变。
  // confirmedSeconds 是该次 state 响应中的服务端净秒数，anchorPerfMs 为收到响应的单调时刻。
  const anchor: SyncAnchor | null = useMemo(() => {
    if (!state?.active_session) return null;
    return {
      confirmedSeconds: state.active_session.active_seconds,
      running: state.active_session.status === 'running',
      anchorPerfMs: perfAtStateRef.current,
      serverNowMs: state.server_now_ms,
    };
  }, [state]);

  return {
    phase,
    subjects,
    state,
    anchor,
    sessions,
    todayDate,
    busy,
    error,
    refresh,
    setupPassword,
    login,
    logout,
    start,
    pause,
    resume,
    stop,
    switchSubject,
    voidSession,
    setNote,
  };
}
