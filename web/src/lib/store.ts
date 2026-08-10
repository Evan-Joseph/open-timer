/** 应用状态：鉴权、服务端状态同步、写动作。所有秒数以服务端为准。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubjectApi, StateApi, SessionApi } from './api.js';
import { apiGet, apiPost, apiPatch } from './api.js';
import type { SyncAnchor } from './clock.js';
import { shanghaiTodayLocal } from './clock.js';

export type AuthPhase = 'loading' | 'setup' | 'login' | 'ready';

export interface ClockStore {
  phase: AuthPhase;
  subjects: SubjectApi[];
  state: StateApi | null;
  anchor: SyncAnchor | null;
  /** 当前开放段（本轮连续专注）的单调锚点，用于节奏环 */
  segmentAnchor: SyncAnchor | null;
  /** 暂停（离开）已有时长的单调锚点；非 paused 为 null */
  awayAnchor: SyncAnchor | null;
  sessions: SessionApi[];
  todayDate: string;
  busy: boolean;
  error: string | null;
  /** 一次性轻提示（成功/撤销等），自动消失 */
  toast: string | null;
  refresh: () => Promise<void>;
  setupPassword: (p: string) => Promise<boolean>;
  login: (p: string) => Promise<boolean>;
  logout: () => Promise<void>;
  start: (subjectId: string, intentNote: string | null) => Promise<boolean>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: (endNote: string | null) => Promise<void>;
  switchSubject: (subjectId: string) => Promise<void>;
  /** 撤回（作废）一个已停止的会话；服务端保留审计，所有汇总自动排除 */
  withdraw: (sessionId: string, reason?: string | null) => Promise<boolean>;
  setNote: (sessionId: string, note: string) => Promise<void>;
}

const POLL_MS_IDLE = 15_000; // 空闲时慢轮询
const POLL_MS_ACTIVE = 5_000; // 运行中快轮询（UI 靠单调时钟平滑，轮询只校准）
const ERROR_TTL_MS = 6_000;
const TOAST_TTL_MS = 2_600;

export function useClockStore(): ClockStore {
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [subjects, setSubjects] = useState<SubjectApi[]>([]);
  const [state, setState] = useState<StateApi | null>(null);
  const [sessions, setSessions] = useState<SessionApi[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  /** 每次收到 state 响应时记录单调时刻，供锚点使用 */
  const perfAtStateRef = useRef<number>(0);

  const todayDate = state?.today_date ?? shanghaiTodayLocal();

  const applyState = useCallback((s: StateApi) => {
    perfAtStateRef.current = performance.now();
    setState(s);
  }, []);

  /** 错误提示：自动消失，不打扰 */
  const flashError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => setError(null), ERROR_TTL_MS);
  }, []);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_TTL_MS);
  }, []);

  const refresh = useCallback(async () => {
    try {
      // state 与 sessions 并行拉取，减少串行延迟
      const [s] = await Promise.all([
        apiGet<StateApi>('/api/v1/state'),
        apiGet<{ sessions: SessionApi[] }>(`/api/v1/sessions?date=${shanghaiTodayLocal()}`)
          .then((d) => setSessions(d.sessions))
          .catch(() => {}),
      ]);
      applyState(s);
      setError(null);
    } catch {
      flashError('暂时无法同步，正在重试');
    }
  }, [applyState, flashError]);

  // 初始鉴权探测
  useEffect(() => {
    (async () => {
      try {
        const me = await apiGet<{ authenticated: boolean; setup_done: boolean }>('/api/v1/auth/me');
        if (!me.setup_done) setPhase('setup');
        else if (!me.authenticated) setPhase('login');
        else setPhase('ready');
        const subs = await apiGet<SubjectApi[]>('/api/v1/subjects').catch(() => [] as SubjectApi[]);
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

  const setupPassword = useCallback(
    async (p: string) => {
      const res = await apiPost('/api/v1/auth/setup', { password: p });
      if (res.ok) {
        setPhase('ready');
        return true;
      }
      flashError('设置失败，请重试');
      return false;
    },
    [flashError],
  );

  const login = useCallback(
    async (p: string) => {
      const res = await apiPost('/api/v1/auth/login', { password: p });
      if (res.ok) {
        setPhase('ready');
        return true;
      }
      flashError('密码不正确');
      return false;
    },
    [flashError],
  );

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
      // 乐观 paused：暂停时刻记为当前墙钟；resume/stop 时清空（以服务端为准）
      const paused_at = status === 'paused' ? prev.active_session.paused_at ?? new Date().toISOString() : null;
      return {
        ...prev,
        active_session: status === null ? null : { ...prev.active_session, status, active_seconds: seconds, paused_at },
      };
    });
  }, []);

  const start = useCallback(
    async (subjectId: string, intentNote: string | null) => {
      setBusy(true);
      const res = await apiPost<{ session_id: string; started_at: string }>('/api/v1/sessions', {
        subject_id: subjectId,
        intent_note: intentNote || null,
      });
      setBusy(false);
      if (!res.ok) {
        const errCode = res.data && (res.data as { error?: string }).error;
        flashError(errCode === 'ACTIVE_SESSION_EXISTS' ? '已有进行中的会话' : '开始失败，请重试');
        refresh(); // 可能别处已有活动会话，拉取真实状态
        return false;
      }
      // 乐观进入运行态：立即渲染，不等 refresh 往返
      const d = res.data;
      if (d) {
        perfAtStateRef.current = performance.now();
        setState((prev) =>
          prev
            ? {
                ...prev,
                active_session: {
                  session_id: d.session_id,
                  subject_id: subjectId,
                  started_at: d.started_at,
                  status: 'running',
                  active_seconds: 0,
                  current_segment_started_at: d.started_at,
                  paused_at: null,
                  intent_note: intentNote || null,
                },
              }
            : prev,
        );
      }
      refresh();
      return true;
    },
    [refresh, flashError],
  );

  const pause = useCallback(async () => {
    if (!activeId) return;
    optimisticSetStatus('paused'); // 立即反馈
    setBusy(true);
    const res = await apiPost(`/api/v1/sessions/${activeId}/pause`);
    setBusy(false);
    if (!res.ok) {
      optimisticSetStatus('running'); // 失败回滚
      flashError('暂停失败，请重试');
      return;
    }
    refresh();
  }, [activeId, refresh, optimisticSetStatus, flashError]);

  const resume = useCallback(async () => {
    if (!activeId) return;
    optimisticSetStatus('running');
    setBusy(true);
    const res = await apiPost(`/api/v1/sessions/${activeId}/resume`);
    setBusy(false);
    if (!res.ok) {
      optimisticSetStatus('paused');
      flashError('继续失败，请重试');
      return;
    }
    refresh();
  }, [activeId, refresh, optimisticSetStatus, flashError]);

  const stop = useCallback(
    async (endNote: string | null) => {
      if (!activeId) return;
      optimisticSetStatus(null); // 立即回到空闲/结束反馈
      setBusy(true);
      const res = await apiPost(`/api/v1/sessions/${activeId}/stop`, { end_note: endNote || null });
      setBusy(false);
      if (!res.ok) {
        // 失败回滚：恢复运行态（乐观清空过头了，以服务端为准）
        flashError('结束失败，请重试');
        refresh();
        return;
      }
      refresh();
    },
    [activeId, refresh, optimisticSetStatus, flashError],
  );

  const switchSubject = useCallback(
    async (subjectId: string) => {
      if (!activeId) return;
      setBusy(true);
      const res = await apiPost(`/api/v1/sessions/${activeId}/switch`, { subject_id: subjectId });
      setBusy(false);
      if (!res.ok) {
        flashError('切换失败，请重试');
        return;
      }
      refresh();
    },
    [activeId, refresh, flashError],
  );

  /**
   * 撤回（作废）已停止会话。一致性保证：
   * - 服务端 void 后，state/sessions/daily-summary/时间轴/概览全部自动排除该会话；
   * - 原始事件链与 manual_adjustment 审计保留，不是删除历史。
   */
  const withdraw = useCallback(
    async (sessionId: string, reason: string | null = '误记') => {
      setBusy(true);
      const res = await apiPost(`/api/v1/sessions/${sessionId}/void`, { reason });
      setBusy(false);
      if (!res.ok) {
        flashError('撤回失败，请重试');
        return false;
      }
      flashToast('已撤回这条记录');
      refresh();
      return true;
    },
    [refresh, flashError, flashToast],
  );

  const setNote = useCallback(
    async (sessionId: string, note: string) => {
      await apiPatch(`/api/v1/sessions/${sessionId}/note`, { note }).catch(() => {});
      refresh();
    },
    [refresh],
  );

  // 构造单调时钟锚点：随 state 身份 memo，避免每次渲染重新锚定导致秒数跳变。
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

  // 暂停（离开）计时锚点：now - paused_at
  const awayAnchor: SyncAnchor | null = useMemo(() => {
    const a = state?.active_session;
    if (!a || a.status !== 'paused' || !a.paused_at) return null;
    const pausedMs = Date.parse(a.paused_at);
    if (!Number.isFinite(pausedMs)) return null;
    return {
      confirmedSeconds: Math.max(0, Math.floor((state.server_now_ms - pausedMs) / 1000)),
      running: true,
      anchorPerfMs: perfAtStateRef.current,
      serverNowMs: state.server_now_ms,
    };
  }, [state]);

  return {
    phase,
    subjects,
    state,
    anchor,
    segmentAnchor,
    awayAnchor,
    sessions,
    todayDate,
    busy,
    error,
    toast,
    refresh,
    setupPassword,
    login,
    logout,
    start,
    pause,
    resume,
    stop,
    switchSubject,
    withdraw,
    setNote,
  };
}
