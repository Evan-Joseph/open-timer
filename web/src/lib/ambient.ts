/**
 * 环境音引擎：纯 WebAudio 合成，零外部资源、无版权风险。
 *
 * 音质设计原则（白噪声/环境音合成的通行做法）：
 * - 粉红噪声用 Paul Kellet 经济型滤波器；棕噪声用积分法（行业标准）；
 * - 4 秒缓冲，减少可听循环缝；立体声分层（左右不同噪声 + 微延迟）制造空间感；
 * - 全部滚降高频、缓慢调制，保证"柔和不刺耳"；
 * - 连续声音用 WebAudio LFO（运行在音频线程，后台标签页不受 JS 定时器节流影响）；
 * - 滴答音用前瞻调度（look-ahead scheduler），后台也保持精准节拍。
 */

export type AmbientKind = 'rain' | 'wind' | 'waves' | 'fire' | 'cafe' | 'tick' | 'none';

export const AMBIENT_LABELS: Record<Exclude<AmbientKind, 'none'>, string> = {
  rain: '雨声',
  wind: '风声',
  waves: '海浪',
  fire: '篝火',
  cafe: '咖啡馆',
  tick: '时钟滴答',
};

const BUFFER_SECONDS = 4;

class AmbientEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: Array<{ stop?: () => void; disconnect?: () => void }> = [];
  private tickScheduler: number | null = null;
  private nextTickTime = 0;
  private current: AmbientKind = 'none';
  private volume = 0.35;
  private running = false;

  private ensureCtx(): AudioContext | null {
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** 生成噪声缓冲。pink=Kellet 经济型，brown=积分白噪声，white=纯随机。 */
  private makeNoiseBuffer(ctx: AudioContext, type: 'white' | 'pink' | 'brown'): AudioBuffer {
    const len = ctx.sampleRate * BUFFER_SECONDS;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    if (type === 'white') {
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } else if (type === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last * 3.5;
      }
    }
    return buf;
  }

  private makeSource(ctx: AudioContext, buf: AudioBuffer): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  /** 注册一个可清理的节点 */
  private track(...ns: Array<{ stop?: () => void; disconnect?: () => void }>) {
    this.nodes.push(...ns);
  }

  /** 立体声噪声层：左右两个不同噪声，微延迟 + 声像展开，制造空间感 */
  private stereoNoise(ctx: AudioContext, type: 'white' | 'pink' | 'brown', out: AudioNode): void {
    const bufL = this.makeNoiseBuffer(ctx, type);
    const bufR = this.makeNoiseBuffer(ctx, type);
    const srcL = this.makeSource(ctx, bufL);
    const srcR = this.makeSource(ctx, bufR);
    const panL = ctx.createStereoPanner();
    const panR = ctx.createStereoPanner();
    panL.pan.value = -0.6;
    panR.pan.value = 0.6;
    const delayR = ctx.createDelay(0.05);
    delayR.delayTime.value = 0.021; // 21ms 微延迟 → 空间感
    srcL.connect(panL).connect(out);
    srcR.connect(delayR).connect(panR).connect(out);
    srcL.start();
    srcR.start();
    this.track(srcL, srcR, panL, panR, delayR);
  }

  private makeFilter(ctx: AudioContext, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private teardown(): void {
    if (this.tickScheduler !== null) {
      window.clearInterval(this.tickScheduler);
      this.tickScheduler = null;
    }
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* ignore */ }
      try { n.disconnect?.(); } catch { /* ignore */ }
    }
    this.nodes = [];
  }

  /** 带淡入的输出增益 */
  private makeOut(ctx: AudioContext): GainNode {
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, ctx.currentTime);
    out.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.8);
    out.connect(this.master!);
    return out;
  }

  /* ================= 各声音类型 ================= */

  private startRain(ctx: AudioContext, out: GainNode): void {
    // 雨底（密集低频）：白噪声 → 低通 1100Hz
    const bed = ctx.createGain();
    bed.gain.value = 0.5;
    const bedLp = this.makeFilter(ctx, 'lowpass', 1100);
    this.stereoNoise(ctx, 'white', bedLp);
    bedLp.connect(bed).connect(out);
    this.track(bedLp, bed);

    // 雨点细碎层（高频轻拍）：白噪声 → 高通 2800 → 低通 8000，音量随密度轻微波动
    const patter = ctx.createGain();
    patter.gain.value = 0.12;
    const patterHp = this.makeFilter(ctx, 'highpass', 2800);
    const patterLp = this.makeFilter(ctx, 'lowpass', 8000);
    this.stereoNoise(ctx, 'white', patterHp);
    patterHp.connect(patterLp).connect(patter);
    // 缓慢密度波动（0.07Hz）
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.04;
    lfo.connect(lfoGain).connect(patter.gain);
    lfo.start();
    patter.connect(out);
    this.track(patterHp, patterLp, patter, lfo, lfoGain);
  }

  private startWind(ctx: AudioContext, out: GainNode): void {
    // 棕噪声 → 低通（截止频率被两个不同速度的 LFO 调制，形成"一阵一阵"的自然风）
    const lp = this.makeFilter(ctx, 'lowpass', 260, 0.8);
    this.stereoNoise(ctx, 'brown', lp);
    const g = ctx.createGain();
    g.gain.value = 1.25;
    const lfo1 = ctx.createOscillator();
    lfo1.frequency.value = 0.09;
    const lfo1Gain = ctx.createGain();
    lfo1Gain.gain.value = 150;
    lfo1.connect(lfo1Gain).connect(lp.frequency);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.23;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 60;
    lfo2.connect(lfo2Gain).connect(lp.frequency);
    lfo1.start();
    lfo2.start();
    // 音量也随呼吸
    const ampLfo = ctx.createOscillator();
    ampLfo.frequency.value = 0.11;
    const ampLfoGain = ctx.createGain();
    ampLfoGain.gain.value = 0.2;
    ampLfo.connect(ampLfoGain).connect(g.gain);
    ampLfo.start();
    lp.connect(g).connect(out);
    this.track(lp, g, lfo1, lfo1Gain, lfo2, lfo2Gain, ampLfo, ampLfoGain);
  }

  private startWaves(ctx: AudioContext, out: GainNode): void {
    // 粉红噪声 → 低通 900Hz，振幅由两个不可通约周期（7s/11s）的正弦叠加 → 自然浪涌
    const lp = this.makeFilter(ctx, 'lowpass', 900);
    this.stereoNoise(ctx, 'pink', lp);
    const wave = ctx.createGain();
    wave.gain.value = 0.35;
    const base = ctx.createConstantSource();
    base.offset.value = 0.35;
    base.connect(wave.gain);
    const lfo1 = ctx.createOscillator();
    lfo1.frequency.value = 1 / 7;
    const lfo1Gain = ctx.createGain();
    lfo1Gain.gain.value = 0.22;
    lfo1.connect(lfo1Gain).connect(wave.gain);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 1 / 11;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 0.14;
    lfo2.connect(lfo2Gain).connect(wave.gain);
    lfo1.start();
    lfo2.start();
    base.start();
    lp.connect(wave).connect(out);
    this.track(lp, wave, base, lfo1, lfo1Gain, lfo2, lfo2Gain);
  }

  private startFire(ctx: AudioContext, out: GainNode): void {
    // 篝火底（低频噼啪床）：棕噪声 → 低通 1500Hz
    const bedLp = this.makeFilter(ctx, 'lowpass', 1500);
    this.stereoNoise(ctx, 'brown', bedLp);
    const bed = ctx.createGain();
    bed.gain.value = 0.6;
    bedLp.connect(bed).connect(out);
    this.track(bedLp, bed);

    // 随机爆裂：短促带通噪声瞬态，随机中心频率/时间/音量
    const schedulePop = () => {
      if (this.current !== 'fire' || !this.ctx || !this.master) return;
      const c = this.ctx;
      const src = this.makeSource(c, this.makeNoiseBuffer(c, 'white'));
      src.loop = false;
      const bp = this.makeFilter(c, 'bandpass', 300 + Math.random() * 1800, 1.2);
      const g = c.createGain();
      const t0 = c.currentTime + Math.random() * 0.1;
      const peak = 0.05 + Math.random() * 0.1;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
      src.connect(bp).connect(g).connect(out);
      src.start(t0);
      src.stop(t0 + 0.14);
      this.tickScheduler = window.setTimeout(schedulePop, 120 + Math.random() * 700) as unknown as number;
    };
    schedulePop();
  }

  private startCafe(ctx: AudioContext, out: GainNode): void {
    // 低频交谈底：棕噪声 → 带通 250-700
    const murmurBp = this.makeFilter(ctx, 'bandpass', 420, 0.5);
    this.stereoNoise(ctx, 'brown', murmurBp);
    const murmur = ctx.createGain();
    murmur.gain.value = 0.5;
    murmurBp.connect(murmur).connect(out);
    this.track(murmurBp, murmur);

    // 中高频细碎人声感：粉红噪声 → 带通 1400，缓慢随机起伏
    const chatterBp = this.makeFilter(ctx, 'bandpass', 1400, 0.9);
    this.stereoNoise(ctx, 'pink', chatterBp);
    const chatter = ctx.createGain();
    chatter.gain.value = 0.1;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.15;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(chatter.gain);
    lfo.start();
    chatterBp.connect(chatter).connect(out);
    this.track(chatterBp, chatter, lfo, lfoGain);
  }

  /** 前瞻调度滴答：在音频时钟上提前排好未来 2 秒的 tick，后台标签页也精准 */
  private startTick(ctx: AudioContext): void {
    this.nextTickTime = ctx.currentTime + 0.1;
    const scheduleAhead = () => {
      if (this.current !== 'tick' || !this.ctx || !this.master) return;
      while (this.nextTickTime < this.ctx.currentTime + 2.0) {
        this.scheduleOneTick(this.ctx, this.master, this.nextTickTime);
        this.nextTickTime += 1.0;
      }
    };
    scheduleAhead();
    // 每 500ms 补排一次；即使后台被节流到 1s，也有 2s 提前量兜底
    this.tickScheduler = window.setInterval(scheduleAhead, 500) as unknown as number;
  }

  /** 单个 tick-tock：短促带通噪声，交替两个音高（更像真钟表） */
  private tickTockPhase = 0;
  private scheduleOneTick(ctx: AudioContext, master: GainNode, t: number): void {
    const isTock = this.tickTockPhase % 2 === 1;
    this.tickTockPhase++;
    const src = this.makeSource(ctx, this.makeNoiseBuffer(ctx, 'white'));
    src.loop = false;
    const bp = this.makeFilter(ctx, 'bandpass', isTock ? 900 : 1200, 2.0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.14, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.stop(t + 0.06);
  }

  /* ================= 对外 API ================= */

  start(kind: AmbientKind): void {
    this.current = kind;
    if (kind === 'none') {
      this.teardown();
      this.running = false;
      return;
    }
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    this.teardown();
    this.running = true;
    if (kind === 'tick') {
      this.startTick(ctx);
      return;
    }
    const out = this.makeOut(ctx);
    if (kind === 'rain') this.startRain(ctx, out);
    else if (kind === 'wind') this.startWind(ctx, out);
    else if (kind === 'waves') this.startWaves(ctx, out);
    else if (kind === 'fire') this.startFire(ctx, out);
    else if (kind === 'cafe') this.startCafe(ctx, out);
  }

  stop(): void {
    this.current = 'none';
    this.teardown();
    this.running = false;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(this.volume, this.ctx.currentTime + 0.15);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  kind(): AmbientKind {
    return this.current;
  }

  /** 节奏提醒铃：柔和上行音（需已激活 ctx） */
  chime(long: boolean): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    const notes = long ? [523.25, 659.25, 783.99] : [659.25, 783.99];
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      const t0 = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.12, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.8);
      osc.connect(g).connect(this.master!);
      osc.start(t0);
      osc.stop(t0 + 0.85);
    });
  }
}

export const ambient = new AmbientEngine();
