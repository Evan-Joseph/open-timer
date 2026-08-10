/** 时钟主区：空闲 / 运行 / 暂停 / 结束反馈四态。 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Pause, Play, Square, Flag } from 'lucide-react';
import type { ClockStore } from '../lib/store.js';
import { useMonotonicSeconds, useBeijingTime, formatHms, formatDurationZh, formatBeijingTime } from '../lib/clock.js';
import { useSettings } from '../lib/settings.js';
import { playFinishChime } from '../lib/sound.js';
import RhythmRing from './RhythmRing.js';

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
  /** 当前开放段（本轮连续专注）已过秒数，供节奏环 */
  const segmentSecs = useMonotonicSeconds(store.segmentAnchor, 1000);
  const beijing = useBeijingTime(anchor ? { serverNowMs: anchor.serverNowMs, anchorPerfMs: anchor.anchorPerfMs } : null);

  // 空闲态北京时间（无锚点时用 Date 直接显示）
  const [idleTime, setIdleTime] = useState(() => formatBeijingTime(Date.now()));
  useEffect(() => {
    const t = window.setInterval(() => setIdleTime(formatBeijingTime(Date.now())), 5000);
    return () => window.clearInterval(t);
  }, []);

  /* ---------- 结束反馈 ---------- */
  const [lastStopped, setLastStopped] = useState<{ sessionId: string; subjectId: string; seconds: number } | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [selectedSubject, setSelectedSubject] = useState<string>(subjects[0]?.subject_id ?? 'math');
  const [intentDraft, setIntentDraft] = useState('');

  // 空闲态默认选最近科目
  useEffect(() => {
    const recent = store.sessions.map((s) => s.subject_id);
    if (recent.length > 0 && selectedSubject === subjects[0]?.subject_id) {
      setSelectedSubject(recent[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.sessions]);

  const subjectOf = (id: string | null | undefined) => subjects.find((s) => s.subject_id === id);

  const handleStop = async () => {
    const snapshot = active ? { sessionId: active.session_id, subjectId: active.subject_id, seconds } : null;
    await store.stop(null);
    if (snapshot) {
      if (settings.finishSound) playFinishChime();
      setLastStopped(snapshot);
    }
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
          <span className="pill-status">{paused ? '· 已暂停' : '· 进行中'}</span>
        </div>

        <div className="big-timer" data-testid="timer-seconds" aria-live="off">
          {formatHms(seconds)}
        </div>

        <div className="sub-line">
          北京时间 {paused ? beijing : beijing} · 今天累计 {formatDurationZh(state?.today_active_seconds ?? 0)}
        </div>
        {active.intent_note && <div className="intent-line">「{active.intent_note}」</div>}

        {/* 番茄节奏参考（设置内开启后显示） */}
        {settings.rhythm.enabled && (
          <RhythmRing
            segmentSeconds={segmentSecs}
            totalSeconds={seconds}
            config={settings.rhythm}
            paused={paused}
            nudgeEnabled={settings.rhythmNudge}
            onTakeBreak={() => void store.pause()}
            onDismissNudge={() => {}}
          />
        )}

        <div className="control-row">
          {paused ? (
            <button className="control-btn resume" onClick={store.resume} disabled={busy} aria-label="继续计时" title="继续">
              <Play size={22} />
            </button>
          ) : (
            <button className="control-btn pause" onClick={store.pause} disabled={busy} aria-label="暂停计时" title="暂停">
              <Pause size={22} />
            </button>
          )}
          <button className="control-btn stop" onClick={handleStop} disabled={busy} aria-label="结束并保存" title="结束并保存">
            <Square size={20} />
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
            onClick={() => setSelectedSubject(s.subject_id)}
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
        <Flag size={18} aria-hidden /> 开始
      </button>

      <div className="today-hint">今天已记录 {formatDurationZh(state?.today_active_seconds ?? 0)}</div>
    </section>
  );
}
