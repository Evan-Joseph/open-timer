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
  /** 当前开放段（本轮连续专注）的单调锚点，用于节奏环 */
  segmentAnchor: SyncAnchor | null;
  /** 今日各科净秒数 */
  todayBySubject: Array<{ subject_id: string; seconds: number }>;
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

const POLL_MS_IDLE = 15_000; // 空闲时慢轮询
const POLL_MS_ACTIVE = 5_000; // 运行中快轮询（UI 靠单调时钟平滑，轮询只校准）

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

  const refresh = useCallback(async () => {
    try {
      // state 与 sessions 并行拉取，减少串行延迟
      const [s] = await Promise.all([
        apiGet<StateApi>('/api/v1/state'),
        apiGet<{ sessions: SessionApi[] }>(`/api/v1/sessions?date=${shanghaiTodayLocal()}`).then((d) => setSessions(d.sessions)).catch(() => {}),
      ]);
      applyState(s);
      setError(null);
    } catch (e) {
      setError('暂时无法同步，正在重试');
    }
  }, [applyState]);

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

  // ready 后启动轮询；运行中加快频率
  const isActive = state?.active_session != null;
  useEffect(() => {
    if (phase !== 'ready') return;
    refresh();
    const interval = isActive ? POLL_MS_ACTIVE : POLL_MS_IDLE;
    pollRef.current = window.setInterval(refresh, interval);
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
  }, [phase, refresh, isActive]);

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

  /**
   * 乐观更新活动会话状态：点击即响应，不等网络；后台 refresh 以服务端事实校正。
   * 暂停时把确认秒数推进到当前单调时刻再冻结，避免 UI 先显示旧锚点、后被轮询"跳秒"。
   */
  const optimisticSetStatus = useCallback((status: 'running' | 'paused' | null) => {
    setState((prev) => {
      if (!prev?.active_session) return prev;
      let seconds = prev.active_session.active_seconds;
      if (status === 'paused' && prev.active_session.status === 'running') {
        // 暂停：把秒数推进到当前单调时刻再冻结，避免跳回旧锚点
        const elapsed = Math.max(0, (performance.now() - perfAtStateRef.current) / 1000);
        seconds = prev.active_session.active_seconds + Math.floor(elapsed);
      }
      if (status === 'running' && prev.active_session.status === 'paused') {
        // 继续：重锚到"现在"，否则会把暂停时长也算进 elapsed
        perfAtStateRef.current = performance.now();
      }
      return {
        ...prev,
        active_session: status === null ? null : { ...prev.active_session, status, active_seconds: seconds },
      };
    });
  }, []);

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
    optimisticSetStatus('paused'); // 立即反馈
    setBusy(true);
    const res = await apiPost(`/api/v1/sessions/${activeId}/pause`);
    setBusy(false);
    if (!res.ok) { optimisticSetStatus('running'); return; } // 失败回滚
    refresh();
  }, [activeId, refresh, optimisticSetStatus]);

  const resume = useCallback(async () => {
    if (!activeId) return;
    optimisticSetStatus('running');
    setBusy(true);
    const res = await apiPost(`/api/v1/sessions/${activeId}/resume`);
    setBusy(false);
    if (!res.ok) { optimisticSetStatus('paused'); return; }
    refresh();
  }, [activeId, refresh, optimisticSetStatus]);

  const stop = useCallback(
    async (endNote: string | null) => {
      if (!activeId) return;
      optimisticSetStatus(null); // 立即回到空闲/结束反馈
      setBusy(true);
      const res = await apiPost(`/api/v1/sessions/${activeId}/stop`, { end_note: endNote || null });
      setBusy(false);
      refresh();
    },
    [activeId, refresh, optimisticSetStatus],
  );

  const switchSubject = useCallback(
    async (subjectId: string) => {
      if (!activeId) return;
      setBusy(true);
      const res = await apiPost<{ started?: { session_id: string; subject_id: string; status: 'running' } }>(
        `/api/v1/sessions/${activeId}/switch`,
        { subject_id: subjectId },
      );
      setBusy(false);
      if (!res.ok) return;
      refresh();
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

  // 当前开放段锚点：段已过秒数 = server_now - current_segment_started_at
  const segmentAnchor: SyncAnchor | null = useMemo(() => {
    const a = state?.active_session;
    if (!a || !a.current_segment_started_at) return null;
    const segStartedMs = Date.parse(a.current_segment_started_at);
    if (!Number.isFinite(segStartedMs)) return null;
    const segSecs = a.status === 'running' ? Math.max(0, (state.server_now_ms - segStartedMs) / 1000) : 0;
    return {
      confirmedSeconds: Math.floor(segSecs),
      running: a.status === 'running',
      anchorPerfMs: perfAtStateRef.current,
      serverNowMs: state.server_now_ms,
    };
  }, [state]);

  // 今日各科小计（sessions 已按当日窗口裁剪，active_seconds 直接累加）
  const todayBySubject = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      if (s.status === 'voided') continue;
      map.set(s.subject_id, (map.get(s.subject_id) ?? 0) + s.active_seconds);
    }
    return [...map.entries()].map(([subject_id, seconds]) => ({ subject_id, seconds }));
  }, [sessions]);

  return {
    phase,
    subjects,
    state,
    anchor,
    segmentAnchor,
    todayBySubject,
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
