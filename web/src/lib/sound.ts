/** 轻音效：WebAudio 合成的柔和短音，无外部资源。默认关闭，设置内可开。 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** 结束确认音：两枚柔和的下行正弦音（约 0.5s）。 */
export function playFinishChime(volume = 0.12): void {
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime;
  for (const [freq, at] of [
    [660, 0],
    [523.25, 0.18],
  ] as const) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(volume, t0 + at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.42);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.45);
  }
}

/** 离开提醒音：单枚上行三连音（约 1.2s），比结束音更柔和、突出"召唤"感。 */
export function playAwayReminder(volume = 0.1): void {
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime;
  for (const [freq, at] of [
    [392, 0],
    [523.25, 0.22],
    [659.25, 0.44],
  ] as const) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(volume, t0 + at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.7);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.75);
  }
}
