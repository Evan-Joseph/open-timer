/** 时钟主区：空闲 / 运行 / 暂停 / 结束反馈四态。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, Square, Flag, Undo2 } from 'lucide-react';
import type { ClockStore } from '../lib/store.js';
import { useMonotonicSeconds, useBeijingTime, formatHms, formatHmsShort, formatDurationZh, formatBeijingTime } from '../lib/clock.js';
import { useSettings } from '../lib/settings.js';
import { playFinishChime } from '../lib/sound.js';

const REDUCED = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const animationsEnabled = !REDUCED && localStorage.getItem('clock-animations') !== 'off';

function M({ children, ...props }: any) {
  if (!animationsEnabled) return <div {...props}>{children}</div>;
  return (
    <motion.div {...props} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
      {children}
    </motion.div>
  );
}

export default function ClockFace({ store }: { store: ClockStore }) {
  const { state, subjects, anchor, busy } = store;
  const active = state?.active_session ?? null;
  const settings = useSettings();

  const seconds = useMonotonicSeconds(anchor);
  // 本段活跃秒（running 增长 / paused 冻结）：主计时拆为「前段累计 + 本段」
  const segmentSecs = useMonotonicSeconds(store.segmentAnchor, 1000);
  const prevSecs = Math.max(0, seconds - segmentSecs);
  /** 暂停（离开）已有时长 */
  const awaySeconds = useMonotonicSeconds(store.awayAnchor, 1000);
  const beijing = useBeijingTime(anchor ? { serverNowMs: anchor.serverNowMs, anchorPerfMs: anchor.anchorPerfMs } : null);

  // 空闲态北京时间与"距上次专注"间隔（5s 步进，共用一个 interval）
  const [idleNowMs, setIdleNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setIdleNowMs(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  const idleTime = formatBeijingTime(idleNowMs);

  /* ---------- 结束反馈 ---------- */
  const [lastStopped, setLastStopped] = useState<{ sessionId: string; subjectId: string; seconds: number } | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [selectedSubject, setSelectedSubject] = useState<string>(
    () => localStorage.getItem('clock-last-subject') || 'math',
  );
  const [intentDraft, setIntentDraft] = useState('');
  /** 用户手动选过后，任何轮询/异步更新都不得再改变选择 */
  const userPickedRef = useRef(false);

  const pickSubject = useCallback((id: string) => {
    userPickedRef.current = true;
    setSelectedSubject(id);
  }, []);

  // 记住最近使用科目（下次进入直接默认）
  useEffect(() => {
    localStorage.setItem('clock-last-subject', selectedSubject);
  }, [selectedSubject]);

  // 仅当"从未手动选过且无本地记录"时，才用当天最后一个会话的科目作默认值（只发生一次）
  useEffect(() => {
    if (userPickedRef.current) return;
    if (localStorage.getItem('clock-last-subject')) return;
    if (store.sessions.length > 0) {
      userPickedRef.current = true; // 防止后续轮询再次改动
      setSelectedSubject(store.sessions[store.sessions.length - 1].subject_id);
    }
  }, [store.sessions]);

  const subjectOf = (id: string | null | undefined) => subjects.find((s) => s.subject_id === id);

  const handleStop = async () => {
    const snapshot = active ? { sessionId: active.session_id, subjectId: active.subject_id, seconds } : null;
    if (snapshot) {
      if (settings.finishSound) playFinishChime();
      setLastStopped(snapshot); // 立即呈现结束反馈（store.stop 内部乐观清空活动会话）
    }
    await store.stop(null);
  };

  /* ---------- 结束反馈态 ---------- */
  if (lastStopped && !active) {
    const subj = subjectOf(lastStopped.subjectId);
    return (
      <section className="clockface" aria-live="polite">
        <M className="finish-card">
          <div className="finish-glow" aria-hidden />
          <div className="subject-pill" data-color={subj?.color_id}>
            <span className="pill-dot" aria-hidden />
            {subj?.display_name ?? lastStopped.subjectId}
          </div>
          <div className="finish-big" data-testid="finish-duration">
            {formatDurationZh(lastStopped.seconds)}
          </div>
          <p className="finish-line">
            已记录本次投入。今天累计 {formatDurationZh(state?.today_active_seconds ?? lastStopped.seconds)}。
          </p>
          <input
            className="finish-note"
            placeholder="补一句备注（可选）"
            value={noteDraft}
            maxLength={200}
            onChange={(e) => setNoteDraft(e.target.value)}
            aria-label="结束备注"
          />
          <div className="finish-actions">
            <button
              className="ghost-btn"
              data-testid="finish-withdraw-btn"
              disabled={store.busy}
              onClick={() => {
                void store.withdraw(lastStopped.sessionId, '误记');
                setLastStopped(null);
                setNoteDraft('');
              }}
            >
              <Undo2 size={14} aria-hidden /> 撤回这条
            </button>
            <button
              className="primary-btn"
              onClick={() => {
                if (noteDraft.trim()) void store.setNote(lastStopped.sessionId, noteDraft.trim());
                setLastStopped(null);
                setNoteDraft('');
              }}
            >
              好，继续
            </button>
          </div>
        </M>
      </section>
    );
  }

  /* ---------- 运行 / 暂停态 ---------- */
  if (active) {
    const subj = subjectOf(active.subject_id);
    const paused = active.status === 'paused';
    return (
      <section className={`clockface ${paused ? 'is-paused' : 'is-running'}`}>
        <div className="subject-pill large" data-color={subj?.color_id}>
          <span className="pill-dot" aria-hidden />
          {subj?.display_name ?? active.subject_id}
          <span className="pill-status">{paused ? '· 离开中' : '· 进行中'}</span>
        </div>

        <div className="big-timer" data-testid="timer-seconds" aria-live="off" aria-label={`累计 ${formatHms(seconds)}，本段 ${formatHmsShort(segmentSecs)}`}>
          <span className="timer-prev" aria-hidden>{formatHms(prevSecs)}</span>
          <span className="timer-plus" aria-hidden>+</span>
          <span className="timer-seg">{formatHmsShort(segmentSecs)}</span>
        </div>

        <div className="sub-line">
          北京时间 {beijing} · 今天累计 {formatDurationZh(state?.today_active_seconds ?? 0)}
        </div>
        {active.intent_note && <div className="intent-line">「{active.intent_note}」</div>}

        {/* 暂停（离开）时长：中性提示，不计入学习 */}
        {paused && (
          <div className="away-line" data-testid="away-line" aria-live="off">
            已离开 {formatHms(awaySeconds)}
            <span className="away-note"> · 不计学习时长</span>
          </div>
        )}

        <div className="control-row">
          {paused ? (
            <button className="control-btn resume" onClick={store.resume} disabled={busy} aria-label="继续计时" title="继续">
              <Play size={24} />
            </button>
          ) : (
            <button className="control-btn pause" onClick={store.pause} disabled={busy} aria-label="暂停计时" title="暂停">
              <Pause size={24} />
            </button>
          )}
          <button className="control-btn stop" onClick={handleStop} disabled={busy} aria-label="结束并保存" title="结束并保存">
            <Square size={24} />
          </button>
        </div>

        {/* 换科目：结束当前段并开启新段 */}
        <details className="switch-subject">
          <summary>切换到其他科目</summary>
          <div className="switch-grid">
            {subjects
              .filter((s) => s.subject_id !== active.subject_id)
              .map((s) => (
                <button
                  key={s.subject_id}
                  className="switch-btn"
                  data-color={s.color_id}
                  onClick={() => store.switchSubject(s.subject_id)}
                  disabled={busy}
                >
                  <span className="pill-dot" aria-hidden />
                  {s.display_name}
                </button>
              ))}
          </div>
        </details>
      </section>
    );
  }

  /* ---------- 空闲态 ---------- */
  const recent = store.sessions.map((s) => s.subject_id);
  const ordered = [...subjects].sort((a, b) => {
    const ai = recent.indexOf(a.subject_id);
    const bi = recent.indexOf(b.subject_id);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.sort_order - b.sort_order;
  });

  return (
    <section className="clockface idle">
      <div className="idle-clock" data-testid="idle-clock">
        {idleTime}
      </div>
      <div className="idle-date">
        {new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full' }).format(new Date())}
      </div>

      <div className="subject-picker" role="radiogroup" aria-label="选择科目">
        {ordered.map((s) => (
          <button
            key={s.subject_id}
            role="radio"
            aria-checked={selectedSubject === s.subject_id}
            className={`subject-chip ${selectedSubject === s.subject_id ? 'selected' : ''}`}
            data-color={s.color_id}
            onClick={() => pickSubject(s.subject_id)}
          >
            <span className="pill-dot" aria-hidden />
            {s.display_name}
          </button>
        ))}
      </div>

      <input
        className="intent-input"
        placeholder="本次想做什么？（可选）"
        value={intentDraft}
        maxLength={200}
        onChange={(e) => setIntentDraft(e.target.value)}
        aria-label="本次目标（可选）"
      />

      <button className="start-btn" data-testid="start-btn" disabled={busy} onClick={() => store.start(selectedSubject, intentDraft || null)}>
        <Flag size={20} aria-hidden /> 开始
      </button>

      <div className="today-hint">今天已记录 {formatDurationZh(state?.today_active_seconds ?? 0)}</div>
    </section>
  );
}
