/**
 * 环境音引擎：纯 WebAudio 合成，零外部资源、无版权风险。
 *
 * 方案参考（Pomofocus/潮汐/Forest 类竞品的通行做法）：
 * - 所有声音由噪声源 + 滤波器 + LFO 合成；
 * - AudioContext 必须由用户手势激活（浏览器 autoplay 策略）；
 * - 页面隐藏时挂起，可见时恢复，省电且不中断听感连续性。
 *
 * 声音类型：
 * - rain    雨声：粉红噪声经高通+低通，偶有"雨滴"瞬态
 * - wind    风声：棕噪声经慢速 LFO 调制低通截止频率
 * - waves   海浪：噪声 + 慢速包络（约 8s 一波）
 * - fire    篝火：棕噪声 + 随机爆裂瞬态
 * - cafe    咖啡馆：棕噪声低音量 + 轻微中频起伏
 * - tick    时钟滴答：每秒一次短促方波瞬态（可选，默认关）
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

class AmbientEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: AudioNode[] = [];
  private tickTimer: number | null = null;
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

  /** 生成噪声缓冲（2s 循环） */
  private makeNoiseBuffer(ctx: AudioContext, type: 'white' | 'pink' | 'brown'): AudioBuffer {
    const len = ctx.sampleRate * 2;
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

  private teardown(): void {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const n of this.nodes) {
      try {
        (n as AudioBufferSourceNode).stop?.();
      } catch { /* ignore */ }
      try {
        n.disconnect();
      } catch { /* ignore */ }
    }
    this.nodes = [];
  }

  private startNoise(kind: Exclude<AmbientKind, 'tick' | 'none'>): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    this.teardown();

    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.8); // 淡入
    out.connect(this.master);

    if (kind === 'rain') {
      const src = this.makeSource(ctx, this.makeNoiseBuffer(ctx, 'pink'));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 400;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 6000;
      const g = ctx.createGain(); g.gain.value = 0.55;
      src.connect(hp).connect(lp).connect(g).connect(out);
      src.start();
      this.nodes.push(src, hp, lp, g);
    } else if (kind === 'wind') {
      const src = this.makeSource(ctx, this.makeNoiseBuffer(ctx, 'brown'));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 300; lp.Q.value = 0.7;
      // 慢速 LFO 调制截止频率，形成"风一阵一阵"
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.12;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 220;
      lfo.connect(lfoGain).connect(lp.frequency);
      const g = ctx.createGain(); g.gain.value = 1.1;
      src.connect(lp).connect(g).connect(out);
      src.start(); lfo.start();
      this.nodes.push(src, lp, lfo, lfoGain, g);
    } else if (kind === 'waves') {
      const src = this.makeSource(ctx, this.makeNoiseBuffer(ctx, 'pink'));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      const wave = ctx.createGain();
      wave.gain.value = 0;
      // 8 秒一波的包络
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 1 / 8;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.45;
      lfo.connect(lfoGain).connect(wave.gain);
      const base = ctx.createConstantSource();
      base.offset.value = 0.3;
      base.connect(wave.gain);
      src.connect(lp).connect(wave).connect(out);
      src.start(); lfo.start(); base.start();
      this.nodes.push(src, lp, wave, lfo, lfoGain, base);
    } else if (kind === 'fire') {
      const src = this.makeSource(ctx, this.makeNoiseBuffer(ctx, 'brown'));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1200;
      const g = ctx.createGain(); g.gain.value = 0.7;
      src.connect(lp).connect(g).connect(out);
      src.start();
      this.nodes.push(src, lp, g);
      // 随机爆裂声
      const schedulePop = () => {
        if (this.current !== 'fire' || !this.ctx) return;
        const pop = this.ctx.createOscillator();
        pop.type = 'square';
        pop.frequency.value = 100 + Math.random() * 400;
        const pg = this.ctx.createGain();
        pg.gain.setValueAtTime(0.02 + Math.random() * 0.05, this.ctx.currentTime);
        pg.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);
        pop.connect(pg).connect(out);
        pop.start();
        pop.stop(this.ctx.currentTime + 0.09);
        this.tickTimer = window.setTimeout(schedulePop, 200 + Math.random() * 1500) as unknown as number;
      };
      schedulePop();
    } else if (kind === 'cafe') {
      const src = this.makeSource(ctx, this.makeNoiseBuffer(ctx, 'brown'));
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.4;
      const g = ctx.createGain(); g.gain.value = 0.4;
      src.connect(bp).connect(g).connect(out);
      src.start();
      this.nodes.push(src, bp, g);
    }
  }

  private startTick(): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    this.teardown();
    // 每秒滴答一次：短促高频瞬态
    const tickOnce = () => {
      if (this.current !== 'tick' || !this.ctx || !this.master) return;
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 2400;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.028, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.03);
      osc.connect(g).connect(this.master);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.04);
    };
    tickOnce();
    this.tickTimer = window.setInterval(tickOnce, 1000) as unknown as number;
  }

  /** 启动某种环境音（需用户手势后调用） */
  start(kind: AmbientKind): void {
    this.current = kind;
    if (kind === 'none') {
      this.teardown();
      this.running = false;
      return;
    }
    this.running = true;
    if (kind === 'tick') this.startTick();
    else this.startNoise(kind);
  }

  stop(): void {
    this.current = 'none';
    this.teardown();
    this.running = false;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.linearRampToValueAtTime(this.volume, this.ctx.currentTime + 0.15);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  kind(): AmbientKind {
    return this.current;
  }

  /** 页面隐藏时挂起；可见时恢复 */
  suspend(): void {
    if (this.ctx && this.running && this.ctx.state === 'running') void this.ctx.suspend();
  }
  resume(): void {
    if (this.ctx && this.running && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 节奏提醒铃：柔和两音（需已激活 ctx） */
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
