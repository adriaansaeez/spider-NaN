import type { PlayerSnapshot } from '../contracts';
import { makeRng } from '../contracts';
import { VoiceLineSystem } from './VoiceLineSystem';

/**
 * OWNED BY: feel-builder.
 * Original synthesized WebAudio (no samples, nothing from the source video):
 *  - speed-reactive wind bed
 *  - attach "thwip" transient
 *  - release whoosh
 *  - the score riser / trick stinger / run-banked chime (score-builder)
 * Starts lazily on first user gesture so autoplay policies don't break.
 */
export class AudioSystem {
  private static readonly volumeStorageKey = 'gauntlet.sfxVolume';
  private static sfxVolumePercent = AudioSystem.readStoredVolume();
  private static readonly musicVolumeStorageKey = 'gauntlet.musicVolume';
  private static musicVolumePercent = AudioSystem.readStoredMusicVolume();
  private static readonly instances = new Set<AudioSystem>();
  /**
   * The instance every non-FX caller routes through, so the whole game shares
   * ONE AudioContext. The "Volumen de efectos" slider drives `masterGain`, and
   * the background track deliberately rides its OWN `musicGain` bus, a direct
   * sibling of `masterGain` connected straight to `ctx.destination`. That is
   * the requirement — the Music slider owns exactly what the SFX slider does
   * not. If a future reader finds `musicGain` hanging off `masterGain` and
   * "simplifies" it back, the separate Music volume slider silently stops
   * working. Do not reconnect it.
   */
  private static primary: AudioSystem | null = null;

  /** Game.ts needs the primary instance to start/stop voice lines and wire subtitles. */
  static getPrimary(): AudioSystem | null {
    return AudioSystem.primary;
  }

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicEl: HTMLAudioElement | null = null;
  private voiceLines = new VoiceLineSystem();
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private lastSpeed = 0;

  constructor() {
    AudioSystem.instances.add(this);
    AudioSystem.primary ??= this;
    const unlock = () => this.ensure();
    addEventListener('pointerdown', unlock, { once: false });
    addEventListener('keydown', unlock);
  }

  static volumePercent(): number {
    return AudioSystem.sfxVolumePercent;
  }

  static setVolumePercent(v: number): number {
    const next = Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 100)));
    AudioSystem.sfxVolumePercent = next;
    try {
      localStorage.setItem(AudioSystem.volumeStorageKey, String(next));
    } catch {
      // Storage can be unavailable in private or embedded contexts; keep runtime state.
    }
    for (const instance of AudioSystem.instances) instance.applyMasterVolume();
    return next;
  }

  private static readStoredVolume(): number {
    try {
      const raw = localStorage.getItem(AudioSystem.volumeStorageKey);
      if (raw === null) return 100;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return 100;
      return Math.max(0, Math.min(100, Math.round(parsed)));
    } catch {
      return 100;
    }
  }

  static musicVolume(): number {
    return AudioSystem.musicVolumePercent;
  }

  static setMusicVolumePercent(v: number): number {
    const next = Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 34)));
    AudioSystem.musicVolumePercent = next;
    try {
      localStorage.setItem(AudioSystem.musicVolumeStorageKey, String(next));
    } catch {
      // Storage can be unavailable in private or embedded contexts; keep runtime state.
    }
    for (const instance of AudioSystem.instances) instance.applyMusicVolume();
    return next;
  }

  private static readStoredMusicVolume(): number {
    try {
      const raw = localStorage.getItem(AudioSystem.musicVolumeStorageKey);
      if (raw === null) return 45;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return 34;
      return Math.max(0, Math.min(100, Math.round(parsed)));
    } catch {
      return 34;
    }
  }

  getVolumePercent(): number {
    return AudioSystem.volumePercent();
  }

  setVolumePercent(v: number): number {
    const next = AudioSystem.setVolumePercent(v);
    this.applyMasterVolume();
    return next;
  }

  setMusicVolumePercent(v: number): number {
    const next = AudioSystem.setMusicVolumePercent(v);
    this.applyMusicVolume();
    return next;
  }

  /** Start the voice-line scheduler. Called when the game enters playing state. */
  startVoiceLines(): void {
    this.voiceLines.start();
  }

  /** Stop the voice-line scheduler and silence any playing line. */
  stopVoiceLines(): void {
    this.voiceLines.stop();
  }

  /** Forward pause state so the voice scheduler doesn't tick while paused. */
  setVoiceLinesPaused(paused: boolean): void {
    this.voiceLines.setPaused(paused);
  }

  /** Expose for subtitle wiring in Game.ts. */
  getVoiceLines(): VoiceLineSystem {
    return this.voiceLines;
  }

  private ensure(): void {
    if (this.ctx) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.ctx = ctx;
      const resume = ctx.resume();
      if (resume && typeof resume.then === 'function') {
        // Playback only starts once the context is actually running: a media
        // element routed through a suspended context can reject play(). This is
        // still on the first-gesture path (ensure() only runs from a gesture),
        // so autoplay policy is satisfied and the failure can only be transient.
        void resume.then(() => this.applyMusicVolume()).catch(() => {});
      }
      this.masterGain = ctx.createGain();
      this.masterGain.connect(ctx.destination);
      this.applyMasterVolume();

      // Music bus — a SIBLING of masterGain, connected straight to the
      // destination. NOT downstream of masterGain: the SFX slider must not
      // mute it. See the class comment. The track is STREAMED through a media
      // element (createMediaElementSource), never decodeAudioData'd — decoding
      // a 1.1 MB MP3 would inflate the JS heap by ~30-60 MB of PCM, and the
      // perf budget caps the heap at 512 MB.
      this.musicGain = ctx.createGain();
      this.musicGain.connect(ctx.destination);
      this.startMusic();

      // Voice bus — a SIBLING of masterGain and musicGain, connected straight
      // to ctx.destination. The Voice Volume slider owns it independently.
      this.voiceLines.ensure(ctx);

      // 2s white-noise buffer reused for every voice (deterministic rng)
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      const rng = makeRng(0x5eed_a11);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = rng() * 2 - 1;
        last = last * 0.97 + w * 0.03;
        d[i] = w * 0.7 + last * 3;
      }
      this.noiseBuf = buf;

      // wind bed
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 350;
      filter.Q.value = 0.6;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.masterGain);
      src.start();
      this.windFilter = filter;
      this.windGain = gain;
    } catch {
      this.ctx = null;
    }
  }

  update(p: PlayerSnapshot, dt: number): void {
    if (!this.ctx || !this.windGain || !this.windFilter) return;
    this.applyMasterVolume();
    const speedT = Math.min(1, p.speed / 110);
    // wind level + airiness scale with speed, with gentle lag
    this.lastSpeed += (speedT - this.lastSpeed) * Math.min(1, 4 * dt);
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.015 + this.lastSpeed * 0.09, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(220 + this.lastSpeed * 2600, t, 0.18);

    if (p.justAttached) this.thwip();
    if (p.justReleased) this.whoosh();

    this.voiceLines.update({ dt, elapsed: 0, frame: 0 });
  }

  /** Attach: a fast rising "thwip" from a short oscillator + noise burst. */
  private thwip(): void {
    if (!this.ctx || !this.noiseBuf || !this.masterGain) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(340, t);
    osc.frequency.exponentialRampToValueAtTime(1150, t + 0.055);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(g).connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.1);

    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(3400, t + 0.05);
    bp.Q.value = 1.4;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    n.connect(bp).connect(ng).connect(this.masterGain);
    n.start(t);
    n.stop(t + 0.08);
  }

  /** Release: a soft downward whoosh. */
  private whoosh(): void {
    if (!this.ctx || !this.noiseBuf || !this.masterGain) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(240, t + 0.28);
    lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    n.connect(lp).connect(g).connect(this.masterGain);
    n.start(t);
    n.stop(t + 0.32);
  }

  // ---------------------------------------------------------------------------
  // Score audio (score-builder). Static so the scoring system never constructs
  // its own AudioSystem: these run on the primary instance's master bus and are
  // therefore governed by the same volume slider as every other sound. Each one
  // is a no-op before the first user gesture, when there is no AudioContext yet.
  // ---------------------------------------------------------------------------

  /** One rung of the points riser. `step` climbs the ladder, `heat` is 0..1. */
  static scoreTick(step: number, heat: number): void {
    AudioSystem.primary?.scoreTickVoice(step, heat);
  }

  /** A named trick landed. `tier` 0 = ordinary, 1 = the big ones. */
  static scoreTrick(tier: number, heat: number): void {
    AudioSystem.primary?.scoreTrickVoice(tier, heat);
  }

  /** Run over. A short warm chime when it beat the record, a soft thud if not. */
  static scoreBank(isRecord: boolean): void {
    AudioSystem.primary?.scoreBankVoice(isRecord);
  }

  /**
   * A short plucked blip on a major-pentatonic ladder. Pentatonic because a
   * long chain fires this many dozens of times and a scale with no semitone
   * clashes stays listenable; low gain and a 30 ms decay so it reads as a tick
   * rather than a note.
   */
  private scoreTickVoice(step: number, heat: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const semis = AudioSystem.pentatonic[((step % 10) + 10) % 10];
    // The whole ladder also transposes up with the multiplier, so a x8 chain
    // sits a fifth above a x1 one and the riser keeps "going up" past the top.
    const freq = 440 * Math.pow(2, (semis + heat * 7) / 12);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    const peak = 0.03 + heat * 0.025;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(g).connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  /** Trick stinger: a rising two- or three-note arpeggio over the same ladder. */
  private scoreTrickVoice(tier: number, heat: number): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const notes = tier > 0 ? [0, 4, 7, 12] : [0, 7];
    const root = 440 * Math.pow(2, (heat * 7) / 12);
    for (let i = 0; i < notes.length; i++) {
      const t = t0 + i * 0.055;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(root * Math.pow(2, notes[i] / 12), t);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2600, t);
      lp.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(tier > 0 ? 0.075 : 0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      osc.connect(lp).connect(g).connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.18);
    }
  }

  /** Run banked. Deliberately the only descending gesture in the score audio. */
  private scoreBankVoice(isRecord: boolean): void {
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    if (isRecord) {
      osc.frequency.setValueAtTime(523.25, t);
      osc.frequency.exponentialRampToValueAtTime(1046.5, t + 0.22);
    } else {
      osc.frequency.setValueAtTime(330, t);
      osc.frequency.exponentialRampToValueAtTime(110, t + 0.3);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(isRecord ? 0.11 : 0.07, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (isRecord ? 0.45 : 0.34));
    osc.connect(g).connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  /** Major pentatonic over an octave and a half — the riser's ladder. */
  private static readonly pentatonic = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

  private applyMasterVolume(): void {
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setValueAtTime(AudioSystem.sfxVolumePercent / 100, this.ctx.currentTime);
  }

  /**
   * Stream the OST through a media element so it never lands in the JS heap.
   * `decodeAudioData` would expand the 1.1 MB MP3 into ~30-60 MB of PCM for a
   * track this length — the perf budget caps the heap at 512 MB and the game
   * already sits at ~31 MB, so streaming is the only option that fits.
   */
  private startMusic(): void {
    if (!this.ctx || !this.musicGain) return;
    try {
      const el = new Audio();
      el.loop = true;
      el.preload = 'metadata';
      el.src = `${import.meta.env.BASE_URL}assets/ost.mp3`;
      // Routing the element into the graph takes over its output; from here on
      // `musicGain` is the only volume control for the track.
      this.ctx.createMediaElementSource(el).connect(this.musicGain);
      this.musicEl = el;
      this.applyMusicVolume();
    } catch {
      // createMediaElementSource can throw when the media backend is
      // unavailable; music degrades to silence rather than breaking the game.
      this.musicEl = null;
    }
  }

  private applyMusicVolume(): void {
    if (!this.ctx || !this.musicGain) return;
    const percent = AudioSystem.musicVolumePercent;
    // Linear, deliberately: the slider label prints this exact percent, so a
    // perceptual curve would make the displayed number lie about the level,
    // and the same map as the SFX bus keeps both sliders comparable.
    this.musicGain.gain.setValueAtTime(percent / 100, this.ctx.currentTime);
    const el = this.musicEl;
    if (!el) return;
    // 0 must PAUSE the element, not just zero the gain: a muted media element
    // keeps decoding every frame and burns CPU for nothing. Resume on any move
    // above 0.
    if (percent <= 0) {
      el.pause();
    } else if (el.paused && this.ctx.state === 'running') {
      void el.play().catch(() => {});
    }
  }

  dispose(): void {
    this.voiceLines.dispose();
    AudioSystem.instances.delete(this);
    if (AudioSystem.primary === this) {
      AudioSystem.primary = AudioSystem.instances.values().next().value ?? null;
    }
    this.musicEl?.pause();
    this.musicEl = null;
    this.musicGain = null;
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.masterGain = null;
  }
}
