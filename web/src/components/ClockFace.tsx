/** 时钟主区：空闲 / 运行 / 暂停 / 结束反馈四态。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, Square, Flag, Undo2 } from 'lucide-react';
import type { ClockStore } from '../lib/store.js';
import { useMonotonicSeconds, useDualMonotonic, useWallSeconds, useBeijingTime, formatHms, formatHmsShort, formatDurationZh, formatBeijingTime, awayLevelOf } from '../lib/clock.js';
import { useSettings } from '../lib/settings.js';
import { playFinishChime, playAwayReminder } from '../lib/sound.js';

const REDUCED = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const animationsEnabled = !REDUCED && localStorage.getItem('clock-animations') !== 'off';

/* 全屏召回"再等 5 分钟"（推迟仅一次性的简单实现：到期后若仍离开则再次弹出） */
const AWAY_SNOOZE_MS = 5 * 60_000;

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
  // 本段活跃秒（running 增长 / paused 冻结）：与总累计用同一 tick 同源计算，杜绝抢秒抖动
  const { total: totalSecs, seg: segmentSecs, prev: prevSecs } = useDualMonotonic(anchor, store.segmentAnchor, 1000);
  /** 暂停（离开）已有时长（墙钟推进，测试可用 page.clock fake） */
  const awaySeconds = useWallSeconds(store.awayAnchor, 1000);
  const beijing = useBeijingTime(anchor ? { serverNowMs: anchor.serverNowMs, anchorPerfMs: anchor.anchorPerfMs } : null);

  /* ---------- 离开（暂停）渐进提醒 ---------- */
  const [awaySnoozedUntil, setAwaySnoozedUntil] = useState(0); // 全屏召回推迟到的时间戳
  const [awayDismissed, setAwayDismissed] = useState(false);   // 本轮暂停已手动关闭全屏召回
  const awayChimePlayedRef = useRef(false);                   // L2 提示音只播一次
  const paused = active?.status === 'paused';
  const awayLevel = awayLevelOf(awaySeconds);
  // 离开状态复位：回到运行/停止后，下一轮暂停重新开始提醒
  useEffect(() => {
    if (!paused) {
      awayChimePlayedRef.current = false;
      setAwayDismissed(false);
      setAwaySnoozedUntil(0);
    }
  }, [paused]);
  // L2：到达 20 分钟时单次轻音（浏览器需已交互，计时本身需要交互才能开始，满足 autoplay 前提）
  useEffect(() => {
    if (awayLevel >= 2 && !awayChimePlayedRef.current) {
      awayChimePlayedRef.current = true;
      playAwayReminder();
    }
  }, [awayLevel]);
  // L3：到达 30 分钟且未推迟/未关闭 → 全屏召回
  const showAwayRecall = awayLevel >= 3 && !awayDismissed && Date.now() >= awaySnoozedUntil;

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
    return (
      <>
      <section className={`clockface ${paused ? 'is-paused' : 'is-running'}`} data-away-level={awayLevel}>
        <div className="subject-pill large" data-color={subj?.color_id}>
          <span className="pill-dot" aria-hidden />
          {subj?.display_name ?? active.subject_id}
          <span className="pill-status">{paused ? '· 离开中' : '· 进行中'}</span>
        </div>

        <div className="big-timer" data-testid="timer-seconds" aria-live="off" aria-label={`累计 ${formatHms(totalSecs)}，本段 ${formatHmsShort(segmentSecs)}`}>
          <span className="timer-prev" aria-hidden>{formatHms(prevSecs)}</span>
          <span className="timer-plus" aria-hidden>+</span>
          <span className="timer-seg">{formatHmsShort(segmentSecs)}</span>
        </div>

        <div className="sub-line">
          北京时间 {beijing} · 今天累计 {formatDurationZh(state?.today_active_seconds ?? 0)}
        </div>
        {active.intent_note && <div className="intent-line">「{active.intent_note}」</div>}

        {/* 离开时长：常驻占位（running 时空行），暂停/恢复瞬间不引起布局位移。
            渐进提醒：L1 ≥15min 黄 + pill 呼吸；L2 ≥20min 红；L3 ≥30min 全屏召回 */}
        <div className="away-slot" aria-live="off">
          {paused && (
            <div
              className={`away-line${awayLevel >= 2 ? ' strong' : awayLevel >= 1 ? ' urgent' : ''}`}
              data-testid="away-line"
            >
              已离开 {formatHms(awaySeconds)}
              <span className="away-note"> · 不计学习时长</span>
            </div>
          )}
        </div>

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

      {/* L3 全屏召回：离开 ≥30 分钟。渐入 + 半透明遮罩，可"回到学习 / 再等 5 分钟 / 点遮罩关闭本轮" */}
      {showAwayRecall && (
        <div
          className="away-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="离开提醒"
          onClick={() => setAwayDismissed(true)}
        >
          <div className="away-overlay-card" onClick={(e) => e.stopPropagation()}>
            <div className="away-overlay-title">已离开 {formatHms(awaySeconds)}</div>
            <p className="away-overlay-text">回来继续这一段吗？休息久了容易掉出状态。</p>
            <div className="away-overlay-actions">
              <button className="primary-btn" onClick={() => void store.resume()} disabled={busy}>
                <Play size={18} aria-hidden /> 回到学习
              </button>
              <button className="ghost-btn" onClick={() => setAwaySnoozedUntil(Date.now() + AWAY_SNOOZE_MS)}>
                再等 5 分钟
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
      <div className="idle-clock" data-testid="idle-clock" key={idleTime}>
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
