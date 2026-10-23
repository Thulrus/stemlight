import type { MsMark } from '../core/quantize';

/** Short synthesized click: a decaying sine. Accented clicks are higher and louder. */
function makeClick(ctx: BaseAudioContext, freq: number, gain: number, dur = 0.03): AudioBuffer {
  const len = Math.ceil(dur * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / ctx.sampleRate;
    d[i] = gain * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 120);
  }
  return buf;
}

/**
 * Plays the song through Web Audio and, when an audition track is set, schedules a
 * click on each of its marks (accented on label "1") with a small lookahead, so the
 * user can hear whether timing is right. Span ends that don't touch the next mark
 * get a soft low tick.
 */
export class Player {
  readonly ctx: AudioContext;
  private buffer?: AudioBuffer;
  private source?: AudioBufferSourceNode;
  private readonly musicGain: GainNode;
  private readonly clickGain: GainNode;
  private readonly clicks: { normal: AudioBuffer; accent: AudioBuffer; end: AudioBuffer };
  private startCtxTime = 0;
  private startOffset = 0;
  private playing = false;
  private timer?: number;
  private scheduledUntil = 0;
  private marks: MsMark[] = [];
  private markIdx = 0;
  onEnded?: () => void;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.musicGain = this.ctx.createGain();
    this.clickGain = this.ctx.createGain();
    this.musicGain.connect(this.ctx.destination);
    this.clickGain.connect(this.ctx.destination);
    this.clicks = {
      normal: makeClick(this.ctx, 1800, 0.6),
      accent: makeClick(this.ctx, 2600, 0.9),
      end: makeClick(this.ctx, 700, 0.35, 0.02),
    };
  }

  load(buffer: AudioBuffer) {
    this.stop();
    this.buffer = buffer;
    this.startOffset = 0;
  }

  get duration() { return this.buffer?.duration ?? 0; }
  get isPlaying() { return this.playing; }

  get currentTime(): number {
    if (!this.playing) return this.startOffset;
    return Math.min(this.duration, this.startOffset + (this.ctx.currentTime - this.startCtxTime));
  }

  setMusicVolume(v: number) { this.musicGain.gain.value = v; }
  setClickVolume(v: number) { this.clickGain.gain.value = v; }

  /** Marks (already quantized, in ms) to click on; pass [] to stop auditioning. */
  setAudition(marks: MsMark[]) {
    this.marks = marks;
    this.resyncClicks();
  }

  async play(from = this.currentTime) {
    if (!this.buffer) return;
    await this.ctx.resume();
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.musicGain);
    // Start slightly in the future so the first clicks can be scheduled in time.
    const when = this.ctx.currentTime + 0.05;
    src.start(when, from);
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
        this.startOffset = this.duration;
        this.stopTimer();
        this.onEnded?.();
      }
    };
    this.source = src;
    this.startCtxTime = when;
    this.startOffset = from;
    this.playing = true;
    this.resyncClicks();
    this.stopTimer();
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  pause() {
    if (!this.playing) return;
    this.startOffset = this.currentTime;
    this.playing = false;
    this.stopSource();
    this.stopTimer();
  }

  stop() {
    this.pause();
    this.startOffset = 0;
  }

  seek(t: number) {
    const clamped = Math.max(0, Math.min(this.duration, t));
    if (this.playing) void this.play(clamped);
    else this.startOffset = clamped;
  }

  private stopSource() {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = undefined;
    }
  }

  private stopTimer() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private pending: AudioBufferSourceNode[] = [];

  /** Cancel already-scheduled clicks and restart scheduling from the playhead. */
  private resyncClicks() {
    for (const p of this.pending) { try { p.stop(); } catch { /* ignore */ } }
    this.pending = [];
    const nowMs = this.currentTime * 1000;
    this.markIdx = this.marks.findIndex((m) => m.start >= nowMs - 1 || m.end >= nowMs);
    if (this.markIdx < 0) this.markIdx = this.marks.length;
    this.scheduledUntil = this.currentTime;
  }

  private fire(buf: AudioBuffer, songTime: number) {
    const when = this.startCtxTime + (songTime - this.startOffset);
    if (when < this.ctx.currentTime) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.clickGain);
    s.start(when);
    s.onended = () => { this.pending = this.pending.filter((p) => p !== s); };
    this.pending.push(s);
  }

  private schedule() {
    if (!this.playing) return;
    const horizon = this.currentTime + 0.15;
    const from = this.scheduledUntil;
    while (this.markIdx < this.marks.length) {
      const m = this.marks[this.markIdx];
      const start = m.start / 1000;
      if (start > horizon) break;
      if (start >= from) this.fire(m.label === '1' ? this.clicks.accent : this.clicks.normal, start);
      const next = this.marks[this.markIdx + 1];
      const end = m.end / 1000;
      if (end - start > 0.2 && (!next || next.start > m.end)) {
        if (end > horizon) break;
        if (end >= from) this.fire(this.clicks.end, end);
      }
      this.markIdx++;
    }
    this.scheduledUntil = horizon;
  }
}
