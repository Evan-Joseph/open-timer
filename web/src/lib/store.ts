/** 应用状态：鉴权、服务端状态同步、写动作。所有秒数以服务端为准。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubjectApi, StateApi, SessionApi } from './api.js';
import { apiGet, apiPost, apiPatch } from './api.js';
import type { SyncAnchor } from './clock.js';
import { shanghaiTodayLocal } from './clock.js';

export type AuthPhase = 'loading' | 'setup' | 'readonly' | 'ready';

export interface ClockStore {
  phase: AuthPhase;
  /** 已登录可写（'ready'）；readonly 为公开只读监督态 */
  isOwner: boolean;
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
  start: (subjectId: string, intentNote: string | null) => Promise<string | null>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: (endNote: string | null) => Promise<void>;
  switchSubject: (subjectId: string) => Promise<void>;
  /** 撤回（作废）一个已停止的会话；服务端保留审计，所有汇总自动排除 */
  withdraw: (sessionId: string, reason?: string | null) => Promise<boolean>;
  /** 误触继续：重开一个已停止的会话（保留原段与秒数，新段从当前起算） */
  resumeSession: (sessionId: string) => Promise<boolean>;
  setNote: (sessionId: string, note: string) => Promise<void>;
  adjustStart: (sessionId: string, startedAt: string) => Promise<boolean>;
}

const POLL_MS_IDLE = 30_000; // 空闲慢轮询（30s：空闲显示由服务端锚定墙钟，间隔不敏感；省一半请求）
const POLL_MS_ACTIVE = 3_000; // 运行中快轮询（3s：状态变更传播上限，对表足够；勿再压小，免费档 100k req/天 受限）
const ERROR_TTL_MS = 6_000;
const TOAST_TTL_MS = 2_600;
const SYNC_PULSE_KEY = 'clock-sync-pulse';

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
  /** refresh 发出时刻（performance.now），用于 RTT 半程锚点修正 */
  const sendPerfRef = useRef<number>(0);
  /** RTT 样本窗口（最近 8 次）：中点锚定的误差界是 ±RTT/2，
   *  弱网 RTT 突增的样本会把锚点污染 1s+ 又被迟滞锁住。
   *  重锚时拒绝显著高延迟样本（NTP 最小延迟择优 / Live Share improveAccuracy 思想）。 */
  const rttWindowRef = useRef<number[]>([]);
  const lastRttMsRef = useRef(0);
  /** 当前样本是否适合用于重锚（首样本无窗口基线时放行） */
  const rttUsable = () => {
    const win = rttWindowRef.current;
    if (win.length < 2) return true;
    const sorted = [...win].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return lastRttMsRef.current <= Math.max(1000, 3 * median);
  };
  /** 同源多标签同步主通道（BroadcastChannel），不可用时回退 storage 事件 */
  const bcRef = useRef<BroadcastChannel | null>(null);
  /** 写操作进行中：期间轮询响应不得覆盖乐观状态（防止"结束反馈反复横跳"） */
  const writeLockedRef = useRef(false);
  /** 锚点纪律：保留上一个锚点，偏差小时不重锚（防计时抖动） */
  const anchorRef = useRef<SyncAnchor | null>(null);
  const segmentAnchorRef = useRef<SyncAnchor | null>(null);
  const awayAnchorRef = useRef<SyncAnchor | null>(null);
  /** 最新已应用的 state（用于丢弃滞后轮询响应） */
  const stateRef = useRef<StateApi | null>(null);
  /** 写操作前后递增；旧 epoch 的在途轮询永远不能覆盖新状态。 */
  const syncEpochRef = useRef(0);
  const refreshSeqRef = useRef(0);
  const appliedSessionsSeqRef = useRef(0);

  const todayDate = state?.today_date ?? shanghaiTodayLocal();

  const applyState = useCallback((s: StateApi, epoch: number) => {
    // 写操作进行中：服务端返回的可能是写完成前的旧状态，不得覆盖乐观 UI
    if (writeLockedRef.current || epoch !== syncEpochRef.current) return;
    // 丢弃滞后的轮询响应（以服务端时间戳为主），防止旧状态回跳。
    // 但同一毫秒内的写后快照可能携带更高 revision / conch_revision；
    // 不能因时间相等而吞掉它，否则刚完成一段后海螺仍会拿旧缓存。
    if (stateRef.current) {
      const current = stateRef.current;
      if (s.server_now_ms < current.server_now_ms) return;
      if (
        s.server_now_ms === current.server_now_ms &&
        s.revision <= current.revision &&
        s.conch_revision <= current.conch_revision
      ) {
        return;
      }
    }
    // RTT 采样：中点锚定要求样本延迟正常，高延迟样本不参与重锚决策
    const rttMs = sendPerfRef.current > 0 ? performance.now() - sendPerfRef.current : 0;
    lastRttMsRef.current = rttMs;
    const win = rttWindowRef.current;
    win.push(rttMs);
    if (win.length > 8) win.shift();
    // RTT 半程锚点：把服务端 server_now_ms 配到「请求-响应中点」而非响应到达时刻，
    // 消除系统性 RTT/2 偏差（公网 RTT 200-300ms → 原多算 100-150ms）。
    perfAtStateRef.current =
      sendPerfRef.current > 0 ? (sendPerfRef.current + performance.now()) / 2 : performance.now();
    stateRef.current = s;
    setState(s);
  }, []);

  const applySessions = useCallback((list: SessionApi[], epoch: number, sequence: number) => {
    if (writeLockedRef.current || epoch !== syncEpochRef.current) return;
    if (sequence < appliedSessionsSeqRef.current) return;
    appliedSessionsSeqRef.current = sequence;
    setSessions(list);
  }, []);

  /**
   * 解锁写状态时再次推进 epoch。写前或写中的在途响应即使晚到，也会被确定性丢弃。
   */
  const releaseWriteLock = useCallback(async () => {
    syncEpochRef.current += 1;
    writeLockedRef.current = false;
  }, []);

  const beginWrite = useCallback(() => {
    syncEpochRef.current += 1;
    writeLockedRef.current = true;
  }, []);

  const notifyPeers = useCallback(() => {
    // 同源多标签同步：BroadcastChannel 优先（进程内、无 localStorage 同步写盘副作用），
    // 不可用时回退 localStorage storage 事件（storage 监听处兜底）。
    if (bcRef.current) {
      bcRef.current.postMessage({ kind: 'sync' });
    } else {
      localStorage.setItem(SYNC_PULSE_KEY, `${Date.now()}:${crypto.randomUUID()}`);
    }
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
    const epoch = syncEpochRef.current;
    const sequence = ++refreshSeqRef.current;
    sendPerfRef.current = performance.now(); // RTT 半程锚点：记录发出时刻
    try {
      // sessions 的日期必须跟随服务端权威的 today_date（而非客户端墙钟）。
      // 首次加载无 state 时用客户端兜底；之后一律以服务端日期为准，跨北京时间午夜
      // 时不会因客户端墙钟/时区偏差拉错当天会话（契约：客户端不自行换算日期）。
      const today = stateRef.current?.today_date ?? shanghaiTodayLocal();
      const [s] = await Promise.all([
        apiGet<StateApi>('/api/v1/state'),
        apiGet<{ sessions: SessionApi[] }>(`/api/v1/sessions?date=${today}`)
          .then((d) => applySessions(d.sessions, epoch, sequence))
          .catch(() => {}),
      ]);
      applyState(s, epoch);
      if (!writeLockedRef.current) setError(null);
    } catch {
      if (epoch === syncEpochRef.current) flashError('暂时无法同步，正在重试');
    }
  }, [applyState, applySessions, flashError]);

  // 同源其他标签页完成写操作后立即同步；跨设备仍由服务端轮询校准。
  // 只读监督态同样需要同步（公开端点），故 readonly 一并订阅。
  useEffect(() => {
    if (phase !== 'ready' && phase !== 'readonly') return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === SYNC_PULSE_KEY) void refresh();
    };
    window.addEventListener('storage', onStorage);
    // 同源多标签主通道：BroadcastChannel，收到同步脉冲立即 refresh（服务端权威校正）。
    // 比 storage 事件更可靠（Safari 隐私模式等场景 storage 事件不可靠）且无写盘开销。
    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('immersive-clock');
      bc.onmessage = (event: MessageEvent) => {
        if (event.data?.kind === 'sync') void refresh();
      };
    }
    bcRef.current = bc;
    return () => {
      window.removeEventListener('storage', onStorage);
      bc?.close();
      bcRef.current = null;
    };
  }, [phase, refresh]);

  // 初始鉴权探测：未登录默认进入只读监督态（公开端点可看，写操作需解锁）
  useEffect(() => {
    (async () => {
      try {
        const me = await apiGet<{ authenticated: boolean; setup_done: boolean }>('/api/v1/auth/me');
        if (!me.setup_done) setPhase('setup');
        else if (!me.authenticated) setPhase('readonly');
        else setPhase('ready');
        const subs = await apiGet<SubjectApi[]>('/api/v1/subjects').catch(() => [] as SubjectApi[]);
        setSubjects(subs);
      } catch {
        setPhase('readonly');
      }
    })();
  }, []);

  // ready/readonly 后启动轮询；运行中加快频率（只读态轮询的是公开端点）
  const isActive = state?.active_session != null;
  useEffect(() => {
    if (phase !== 'ready' && phase !== 'readonly') return;
    refresh();
    const interval = isActive ? POLL_MS_ACTIVE : POLL_MS_IDLE;
    pollRef.current = window.setInterval(refresh, interval);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    // bfcache（往返缓存）恢复只触发 pageshow，不走 focus/visibilitychange；
    // 冻结（Page Lifecycle freeze/resume）恢复也不触发二者，需单独监听。
    // 冻结期间 performance.now() 继续走，恢复后 compute() 自动算出含冻结时长的正确 elapsed；
    // 这里补 refresh 只是消除「解冻后到下一次轮询前」的显示滞后。
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    const onResume = () => refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('resume', onResume);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('resume', onResume);
    };
  }, [phase, refresh, isActive]);

  // 加载 subjects（ready/readonly 均可：公开端点）
  useEffect(() => {
    if (phase !== 'ready' && phase !== 'readonly') return;
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
    // 回到只读监督态（而非阻断式登录页）：监督者仍可查看
    setPhase('readonly');
  }, []);

  const activeId = state?.active_session?.session_id ?? null;

  /**
   * 乐观更新活动会话状态：点击即响应，不等网络；后台 refresh 以服务端事实校正。
   * 暂停时把确认秒数推进到当前单调时刻再冻结，避免 UI 先显示旧锚点、后被轮询"跳秒"。
   */
  const optimisticSetStatus = useCallback((status: 'running' | 'paused' | null) => {
    setState((prev) => {
      if (!prev?.active_session) return prev;
      const projectedServerNowMs = prev.server_now_ms + Math.max(0, performance.now() - perfAtStateRef.current);
      let seconds = prev.active_session.active_seconds;
      let currentSegmentSeconds = prev.active_session.current_segment_active_seconds;
      let currentSegmentStartedAt = prev.active_session.current_segment_started_at;
      if (status === 'paused' && prev.active_session.status === 'running') {
        // 暂停：把秒数推进到当前单调时刻再冻结，避免跳回旧锚点
        const elapsed = Math.max(0, (performance.now() - perfAtStateRef.current) / 1000);
        const elapsedSeconds = Math.floor(elapsed);
        seconds = prev.active_session.active_seconds + elapsedSeconds;
        currentSegmentSeconds = Math.max(0, (prev.active_session.current_segment_active_seconds ?? 0) + elapsedSeconds);
        currentSegmentStartedAt = null;
      }
      if (status === 'running' && prev.active_session.status === 'paused') {
        // 继续：重锚到"现在"，否则会把暂停时长也算进 elapsed
        perfAtStateRef.current = performance.now();
        currentSegmentSeconds = 0;
        currentSegmentStartedAt = new Date(projectedServerNowMs).toISOString();
      }
      // 乐观时间戳同样以服务端锚点外推，避免客户端墙钟偏差触发错误的休息逾期。
      const paused_at = status === 'paused'
        ? prev.active_session.paused_at ?? new Date(projectedServerNowMs).toISOString()
        : null;
      return {
        ...prev,
        active_session: status === null ? null : {
          ...prev.active_session,
          status,
          active_seconds: seconds,
          current_segment_active_seconds: currentSegmentSeconds,
          current_segment_started_at: currentSegmentStartedAt,
          paused_at,
        },
      };
    });
  }, []);

  const start = useCallback(
    async (subjectId: string, intentNote: string | null) => {
      beginWrite();
      setBusy(true);
      const res = await apiPost<{ session_id: string; started_at: string }>('/api/v1/sessions', {
        subject_id: subjectId,
        intent_note: intentNote || null,
      });
      setBusy(false);
      await releaseWriteLock();
      if (!res.ok) {
        const errCode = res.data && (res.data as { error?: string }).error;
        flashError(errCode === 'ACTIVE_SESSION_EXISTS' ? '已有进行中的会话' : '开始失败，请重试');
        refresh(); // 可能别处已有活动会话，拉取真实状态
        return null;
      }
      notifyPeers();
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
                  current_segment_active_seconds: 0,
                  paused_at: null,
                  intent_note: intentNote || null,
                },
              }
            : prev,
        );
      }
      refresh();
      return d?.session_id ?? null;
    },
    [beginWrite, refresh, flashError, notifyPeers],
  );

  const pause = useCallback(async () => {
    if (!activeId) return;
    beginWrite(); // 锁定：轮询不得覆盖乐观状态
    optimisticSetStatus('paused'); // 立即反馈
    setBusy(true);
    const res = await apiPost(`/api/v1/sessions/${activeId}/pause`);
    setBusy(false);
    await releaseWriteLock();
    if (!res.ok) {
      optimisticSetStatus('running'); // 失败回滚
      flashError('暂停失败，请重试');
      refresh();
      return;
    }
    notifyPeers();
    refresh();
  }, [activeId, beginWrite, refresh, optimisticSetStatus, flashError, notifyPeers]);

  const resume = useCallback(async () => {
    if (!activeId) return;
    beginWrite();
    optimisticSetStatus('running');
    setBusy(true);
    const res = await apiPost(`/api/v1/sessions/${activeId}/resume`);
    setBusy(false);
    await releaseWriteLock();
    if (!res.ok) {
      optimisticSetStatus('paused');
      flashError('继续失败，请重试');
      refresh();
      return;
    }
    notifyPeers();
    refresh();
  }, [activeId, beginWrite, refresh, optimisticSetStatus, flashError, notifyPeers]);

  const stop = useCallback(
    async (endNote: string | null) => {
      if (!activeId) return;
      beginWrite();
      optimisticSetStatus(null); // 立即回到空闲/结束反馈
      setBusy(true);
      const res = await apiPost(`/api/v1/sessions/${activeId}/stop`, { end_note: endNote || null });
      setBusy(false);
      await releaseWriteLock();
      if (!res.ok) {
        // 失败回滚：恢复运行态（乐观清空过头了，以服务端为准）
        flashError('结束失败，请重试');
        refresh();
        return;
      }
      notifyPeers();
      // stop 会推进 conch_revision；等待本次权威快照落地，确保用户刚结束又打开海螺时
      // 不会拿到旧语义缓存（开始/暂停/继续则仍保持异步刷新，避免不必要阻塞）。
      await refresh();
    },
    [activeId, beginWrite, refresh, optimisticSetStatus, flashError, notifyPeers],
  );

  const switchSubject = useCallback(
    async (subjectId: string) => {
      if (!activeId) return;
      beginWrite();
      setBusy(true);
      const res = await apiPost(`/api/v1/sessions/${activeId}/switch`, { subject_id: subjectId });
      setBusy(false);
      await releaseWriteLock();
      if (!res.ok) {
        flashError('切换失败，请重试');
        refresh();
        return;
      }
      notifyPeers();
      // switch 会结束旧科目的一段已完成专注，故需等待语义缓存版本更新。
      await refresh();
    },
    [activeId, beginWrite, refresh, flashError, notifyPeers],
  );

  /**
   * 撤回（作废）已停止会话。一致性保证：
   * - 服务端 void 后，state/sessions/daily-summary/时间轴/概览全部自动排除该会话；
   * - 原始事件链与 manual_adjustment 审计保留，不是删除历史。
   */
  const withdraw = useCallback(
    async (sessionId: string, reason: string | null = '误记') => {
      beginWrite();
      const removedSeconds = sessions.find((session) => session.session_id === sessionId)?.active_seconds ?? 0;
      setBusy(true);
      const res = await apiPost(`/api/v1/sessions/${sessionId}/void`, { reason });
      setBusy(false);
      await releaseWriteLock();
      if (!res.ok) {
        flashError('撤回失败，请重试');
        refresh();
        return false;
      }
      setSessions((current) => current.filter((session) => session.session_id !== sessionId));
      setState((current) => current ? { ...current, today_active_seconds: Math.max(0, current.today_active_seconds - removedSeconds) } : current);
      flashToast('已撤回这条记录');
      notifyPeers();
      await refresh();
      return true;
    },
    [beginWrite, sessions, refresh, flashError, flashToast, notifyPeers],
  );

  /**
   * 误触继续：重开已停止会话。服务端约束：仅 stopped 可重开，且无其他活动会话；
   * 原会话的段、备注、时长修正全部保留，新段从当前时刻起算。
   */
  const resumeSession = useCallback(
    async (sessionId: string) => {
      beginWrite();
      setBusy(true);
      const res = await apiPost(`/api/v1/sessions/${sessionId}/resume`);
      setBusy(false);
      await releaseWriteLock();
      if (!res.ok) {
        flashError('继续失败，请重试');
        refresh();
        return false;
      }
      flashToast('已继续这段会话');
      notifyPeers();
      await refresh();
      return true;
    },
    [beginWrite, refresh, flashError, flashToast, notifyPeers],
  );

  const setNote = useCallback(
    async (sessionId: string, note: string) => {
      const res = await apiPatch(`/api/v1/sessions/${sessionId}/note`, { note }).catch(() => null);
      if (res?.ok) notifyPeers();
      // 已完成备注是海螺输入，等待 conch_revision 快照落地再返回。
      await refresh();
    },
    [refresh, notifyPeers],
  );

  const adjustStart = useCallback(async (sessionId: string, startedAt: string) => {
    setBusy(true);
    const res = await apiPost(`/api/v1/sessions/${sessionId}/adjust-start`, {
      started_at: startedAt,
      reason: '补录实际开始时间',
    });
    setBusy(false);
    if (!res.ok) {
      flashError('开始时间无效，请检查是否早于结束时间');
      return false;
    }
    flashToast('开始时间已更新');
    notifyPeers();
    await refresh();
    return true;
  }, [flashError, flashToast, refresh, notifyPeers]);

  // 构造单调时钟锚点：随 state 身份 memo，避免每次渲染重新锚定导致秒数跳变。
  // 防拖锚点纪律（NTP 式）：偏差 ≤1.2s 时保持旧锚继续平滑，只有大偏差才重锚。
  const anchor: SyncAnchor | null = useMemo(() => {
    if (!state?.active_session) {
      anchorRef.current = null;
      return null;
    }
    const next: SyncAnchor = {
      confirmedSeconds: state.active_session.active_seconds,
      running: state.active_session.status === 'running',
      anchorPerfMs: perfAtStateRef.current,
      serverNowMs: state.server_now_ms,
    };
    const prev = anchorRef.current;
    if (prev && prev.running === next.running && prev.confirmedSeconds === next.confirmedSeconds) {
      // 服务端确认值未变：保持旧锚，避免重锚引起的小拖
      return prev;
    }
    if (prev && prev.running === next.running) {
      // 偏差 = 旧锚外推值 - 新确认值；小于阈值则视为本地单调时钟更平滑，不重锚
      const driftSec = Math.abs(prev.confirmedSeconds + (performance.now() - prev.anchorPerfMs) / 1000 - next.confirmedSeconds);
      if (driftSec <= 1.2) return prev;
      // 弱网防护：大偏差需要重锚，但高 RTT 样本的中点估计误差界 ±RTT/2 太大，
      // 宁可继续外推等下一个好样本（NTP 最小延迟择优思想）
      if (!rttUsable()) return prev;
    }
    anchorRef.current = next;
    return next;
  }, [state]);

  // 当前开放段锚点：本段活跃秒数来自服务端（running 增长 / paused 冻结为末段净秒）
  const segmentAnchor: SyncAnchor | null = useMemo(() => {
    const a = state?.active_session;
    if (!a || a.current_segment_active_seconds == null) {
      segmentAnchorRef.current = null;
      return null;
    }
    const next: SyncAnchor = {
      confirmedSeconds: Math.max(0, Math.floor(a.current_segment_active_seconds)),
      running: a.status === 'running',
      anchorPerfMs: perfAtStateRef.current,
      serverNowMs: state.server_now_ms,
    };
    const prev = segmentAnchorRef.current;
    if (prev && prev.running === next.running) {
      const driftSec = Math.abs(prev.confirmedSeconds + (performance.now() - prev.anchorPerfMs) / 1000 - next.confirmedSeconds);
      if (driftSec <= 1.2) return prev;
      if (!rttUsable()) return prev; // 弱网高 RTT 样本不重锚
    }
    segmentAnchorRef.current = next;
    return next;
  }, [state]);

  // 暂停（离开）计时锚点：now - paused_at（同样防抖重锚）
  const awayAnchor: SyncAnchor | null = useMemo(() => {
    const a = state?.active_session;
    if (!a || a.status !== 'paused' || !a.paused_at) {
      awayAnchorRef.current = null;
      return null;
    }
    const pausedMs = Date.parse(a.paused_at);
    if (!Number.isFinite(pausedMs)) {
      awayAnchorRef.current = null;
      return null;
    }
    const next: SyncAnchor = {
      confirmedSeconds: Math.max(0, Math.floor((state.server_now_ms - pausedMs) / 1000)),
      running: true,
      anchorPerfMs: perfAtStateRef.current,
      serverNowMs: state.server_now_ms,
    };
    const prev = awayAnchorRef.current;
    if (prev && prev.running) {
      const extrapolated = prev.confirmedSeconds + (performance.now() - prev.anchorPerfMs) / 1000;
      const driftSec = Math.abs(extrapolated - next.confirmedSeconds);
      // 休息时长单调前进：偏差小保持旧锚（平滑）；新确认值落后于本地外推时也保持旧锚，
      // 防止「已休息」数字回跳（轮询校准竞态下服务端确认值可能暂时落后于单调外推）。
      // 仅当确认值领先外推 >1.2s（如设备休眠后真实休息比外推更长）且 RTT 样本可信才重锚。
      if (driftSec <= 1.2 || next.confirmedSeconds < extrapolated) return prev;
      if (!rttUsable()) return prev; // 弱网高 RTT 样本不重锚
    }
    awayAnchorRef.current = next;
    return next;
  }, [state]);

  return {
    phase,
    isOwner: phase === 'ready',
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
    resumeSession,
    setNote,
    adjustStart,
  };
}
