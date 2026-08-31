/**
 * 神奇海螺浮层：按科目给出「下一步做什么」建议。
 * 范式完全复用近 7 天回顾的居中浮层（DESIGN.md §6）：遮罩 + 材质面板 + 三通道关闭。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Shell, X, RefreshCw, Play, Shuffle } from 'lucide-react';
import { conchAsk, getConchRevision, type ConchAskResponseApi, type ConchSubjectApi, type ConchWindow } from '../lib/api.js';
import { saveConchStartMark } from '../lib/conch-mark.js';
import type { ClockStore } from '../lib/store.js';
import { useModalFocus } from '../lib/modal-focus.js';

const WINDOW_LABELS: Record<ConchWindow, string> = { all: '从始至今', '30d': '近 30 天', '7d': '近 7 天' };
const WINDOWS: readonly ConchWindow[] = ['all', '30d', '7d'];
const KIND_LABELS: Record<string, string> = {
  lecture: '看课',
  problems: '刷题',
  book: '读书',
  review: '复习',
  test: '模考',
  other: '其他',
};
const CONF_LABELS: Record<string, string> = { high: '把握高', medium: '较有把握', low: '仅供参考' };

const ERROR_TEXT: Record<string, string> = {
  not_configured: '海螺还没接上大脑：服务端未配置 CONCH_*（wrangler secret）。',
  credential: '海螺服务的 API 凭据已失效，更新后才能继续。',
  timeout: '海螺沉思太久没回过神来，再问一次？',
  upstream: '海螺的脑子暂时不在服务区，再问一次？',
  invalid: '海螺这次说话含糊，再问一次？',
  rate: '问得太勤啦，稍后再来。',
  internal: '海螺服务暂时无法处理这次请求，再问一次？',
  network: '海螺没听见（网络错误），再问一次？',
};
const RETRYABLE = new Set(['timeout', 'upstream', 'invalid', 'internal', 'network']);

// v5 = 语义 revision + 模型标识 + 原始事实校验。v4 不复用，避免继续展示规则收紧前的建议。
const CACHE_KEY = 'clock-conch-cache-v5';
/** state 不可用（极短启动窗口）时的唯一兜底 TTL；正常状态下不按时间过期。 */
const CACHE_TTL_FALLBACK_MS = 30 * 60 * 1000;

interface CacheEntry {
  ts: number;
  data: ConchAskResponseApi;
}

type CacheMap = Partial<Record<ConchWindow, CacheEntry>>;

function readCacheMap(): CacheMap {
  try {
    return (JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') ?? {}) as CacheMap;
  } catch {
    /* 缓存损坏即弃 */
    return {};
  }
}

/**
 * 缓存命中纪律：已完成时间线无事实变化 → conch_revision 不变 → 长期命中、零 token。
 * 开始/暂停/继续/运行秒数不会推进它；完成、备注、修正、撤回、重开才会失效。
 * 三个窗口各自独立缓存，切换窗口互不覆盖。
 */
function readCache(window: ConchWindow, currentConchRevision: number | null, expectedModel: string | null): ConchAskResponseApi | null {
  const entry = readCacheMap()[window];
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (currentConchRevision !== null) {
    return entry.data.conch_revision === currentConchRevision && (expectedModel === null || entry.data.model === expectedModel)
      ? entry.data
      : null;
  }
  return age < CACHE_TTL_FALLBACK_MS ? entry.data : null;
}

function writeCache(window: ConchWindow, data: ConchAskResponseApi): void {
  try {
    const map = readCacheMap();
    map[window] = { ts: Date.now(), data };
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式静默降级 */
  }
}

interface Props {
  onClose: () => void;
  store: ClockStore;
}

/** 单科目推荐卡：备选方案支持点击开工与「换一换」轮换（本地轮换，不重新请求）。 */
function ConchCard({
  s,
  colorId,
  hasActiveSession,
  starting,
  onStart,
}: {
  s: ConchSubjectApi;
  colorId: string;
  hasActiveSession: boolean;
  starting: boolean;
  onStart: (subjectId: string, note: string) => void;
}) {
  const [altIndex, setAltIndex] = useState(0);
  const alts = s.alternatives;
  const alt = alts.length > 0 ? alts[altIndex % alts.length] : null;
  const startDisabled = hasActiveSession || starting;

  return (
    <div className="conch-card" data-color={colorId}>
      <div className="conch-card-head">
        <span className="conch-subject-dot" aria-hidden />
        <span className="conch-subject-name">{s.display_name}</span>
        {s.running_now && <span className="conch-running-badge">进行中</span>}
        <span className="conch-meta">最近活动 {s.last_active_date.slice(5)}</span>
        <span className={`conch-conf conch-conf-${s.confidence}`} title={CONF_LABELS[s.confidence]}>
          {CONF_LABELS[s.confidence]}
        </span>
      </div>
      <div className="conch-action-line">
        <span className="conch-chip">{KIND_LABELS[s.action_kind] ?? '其他'}</span>
        {s.topic && <span className="conch-topic">{s.topic}</span>}
      </div>
      <div className="conch-next">{s.next_action}</div>
      {s.rationale && <div className="conch-rationale">{s.rationale}</div>}
      {alt && (
        <div className="conch-alts">
          <span className="conch-alts-label">或者</span>
          <button
            type="button"
            className="conch-alt-btn"
            disabled={startDisabled}
            title={hasActiveSession ? '先结束当前会话' : '以这条备选为备注开始计时'}
            onClick={() => onStart(s.subject_id, alt)}
            data-testid={`conch-alt-${s.subject_id}`}
          >
            <Play size={12} aria-hidden />
            {alt}
          </button>
          {alts.length > 1 && (
            <button
              type="button"
              className="conch-alt-shuffle"
              onClick={() => setAltIndex((i) => (i + 1) % alts.length)}
              aria-label="换一条备选"
              title="换一条备选"
              data-testid={`conch-alt-shuffle-${s.subject_id}`}
            >
              <Shuffle size={13} aria-hidden />
              换一换
            </button>
          )}
        </div>
      )}
      {s.pattern && <div className="conch-footnote">节奏：{s.pattern}</div>}
      <div className="conch-card-actions">
        <button
          className="ghost-btn"
          disabled={startDisabled}
          title={hasActiveSession ? '先结束当前会话' : '以该建议为备注开始计时'}
          onClick={() => onStart(s.subject_id, s.next_action)}
          data-testid={`conch-start-${s.subject_id}`}
        >
          <Play size={14} aria-hidden />
          {starting ? '开始中…' : '开始这个科目'}
        </button>
      </div>
    </div>
  );
}

export default function ConchOverlay({ onClose, store }: Props) {
  const [windowSel, setWindowSel] = useState<ConchWindow>('all');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [data, setData] = useState<ConchAskResponseApi | null>(null);
  const [errorKind, setErrorKind] = useState('network');
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);

  const activeSession = store.state?.active_session ?? null;
  /** 用 ref 读 semantic revision：避免 load 身份随 state 轮询变化触发重复请求 */
  const stateRef = useRef(store.state);
  const panelRef = useRef<HTMLDivElement>(null);
  stateRef.current = store.state;
  useModalFocus(true, panelRef);

  const load = useCallback(async (w: ConchWindow, force = false) => {
    setPhase('loading');
    setFromCache(false);
    setErrorRequestId(null);
    if (!force) {
      // 缓存命中前用单行 revision 做语义校验：不拉时间轴、不调模型。
      // 这让跨端完成/备注也能立刻使缓存失效，而普通开始/暂停/继续仍长期命中。
      let conchRevision = stateRef.current?.conch_revision ?? null;
      let conchModel: string | null = null;
      try {
        const revision = await getConchRevision();
        conchRevision = revision.conch_revision;
        conchModel = revision.model;
      } catch {
        // 离线/瞬断时，仍按最近 state 的语义版本或短暂兜底缓存展示，不把网络波动变成强制重问。
      }
      const cached = readCache(w, conchRevision, conchModel);
      if (cached) {
        setData(cached);
        setPhase('ready');
        setFromCache(true);
        return;
      }
    }
    const res = await conchAsk(w);
    if (res.networkError) {
      setErrorKind('network');
      setErrorRequestId(res.requestId);
      setPhase('error');
      return;
    }
    if (res.ok && res.data) {
      setData(res.data);
      setPhase('ready');
      writeCache(w, res.data);
      return;
    }
    if (res.status === 401) {
      store.expireOwnerSession();
      onClose();
      return;
    }
    const errorCode = (res.data as unknown as { error?: string } | null)?.error;
    const kind =
      errorCode === 'CONCH_CREDENTIAL_INVALID' ? 'credential'
      : res.status === 503 ? 'not_configured'
      : res.status === 504 ? 'timeout'
      : res.status === 502 ? 'upstream'
      : res.status === 422 ? 'invalid'
      : res.status === 429 ? 'rate'
      : 'internal';
    setErrorKind(kind);
    setErrorRequestId(res.requestId);
    setPhase('error');
  }, []);

  useEffect(() => {
    void load(windowSel);
  }, [windowSel, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 一键开始：以推荐语作为 intent_note 直接开工；结束时预填同句为结束备注 */
  const startSubject = async (subjectId: string, nextAction: string) => {
    if (activeSession) return;
    setStartingId(subjectId);
    const note = nextAction.slice(0, 200);
    const sessionId = await store.start(subjectId, note);
    setStartingId(null);
    if (sessionId) {
      saveConchStartMark({ sessionId, note });
      onClose();
    }
  };

  const colorOf = (subjectId: string) => store.subjects.find((s) => s.subject_id === subjectId)?.color_id ?? 'amber';

  return (
    <motion.div
      key="conch-overlay"
      className="history-overlay-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
      onClick={onClose}
    >
      <motion.div
        key="conch-panel"
          className="history-overlay-panel conch-panel"
          ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="神奇海螺 · 下一步做什么"
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
        onClick={(e) => e.stopPropagation()}
        data-testid="conch-panel"
      >
        <div className="history-overlay-head">
          <div className="history-overlay-title conch-title">
            <Shell size={16} aria-hidden />
            <strong>神奇海螺</strong>
            <span>下一步做什么{fromCache && phase === 'ready' ? ' · 缓存' : ''}</span>
          </div>
          <div className="conch-head-actions">
            <button
              className="icon-btn"
              aria-label="重新问一次"
              title="重新问一次"
              disabled={phase === 'loading'}
              onClick={() => void load(windowSel, true)}
            >
              <RefreshCw size={16} className={phase === 'loading' ? 'conch-spin' : undefined} />
            </button>
            <button className="icon-btn" aria-label="关闭" title="关闭" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="seg-control conch-window-seg" role="radiogroup" aria-label="统计窗口">
          {WINDOWS.map((w) => (
            <button
              key={w}
              role="radio"
              aria-checked={windowSel === w}
              className={`seg-item ${windowSel === w ? 'active' : ''}`}
              onClick={() => setWindowSel(w)}
              disabled={phase === 'loading'}
            >
              {WINDOW_LABELS[w]}
            </button>
          ))}
        </div>

        <div className="conch-body">
          {phase === 'loading' && (
            <div className="conch-loading" role="status">
              <div className="conch-loading-main">
                <Shell size={20} aria-hidden className="conch-breathe" />
                <span>神奇海螺正在看已完成的记录…</span>
              </div>
              <span className="conch-loading-sub">通常约 10 秒；超过 30 秒会自动结束并允许重试</span>
            </div>
          )}

          {phase === 'error' && (
            <div className="conch-error" role="alert">
              <span>{ERROR_TEXT[errorKind]}</span>
              {errorRequestId && <span className="conch-diagnostic">诊断编号：{errorRequestId}</span>}
              {RETRYABLE.has(errorKind) && (
                <button className="ghost-btn" onClick={() => void load(windowSel, true)}>
                  再问一次
                </button>
              )}
            </div>
          )}

          {phase === 'ready' && data && (
            <>
              {data.subjects.length === 0 && (
                <div className="conch-empty">最近没有活跃科目，先去学一会儿吧。</div>
              )}
              {data.subjects.map((s) => (
                <ConchCard
                  key={s.subject_id}
                  s={s}
                  colorId={colorOf(s.subject_id)}
                  hasActiveSession={!!activeSession}
                  starting={startingId === s.subject_id}
                  onStart={(subjectId, note) => void startSubject(subjectId, note)}
                />
              ))}
              {data.skipped.length > 0 && (
                <div className="conch-skipped">
                  {data.skipped.map((s) => (
                    <span key={s.subject_id}>
                      {s.display_name} · {s.reason === 'not_started' ? '还没开始' : '最近没活动'}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
