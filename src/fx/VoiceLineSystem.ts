import { makeRng, type UpdateContext } from '../contracts';
import { FX_TUNING } from './tuning';
import type { StringTableKey } from '../i18n/i18n';

const VOICE_STORAGE_KEY = 'gauntlet.voiceVolume';

/**
 * Subtitle KEYS, not text. The lines live in src/i18n/strings.ts so they follow
 * the UI language; the AUDIO stays Spanish in both, which is what
 * `settings.voicesSpanishOnly` explains in Settings.
 */
const LINE_KEYS = [
  'voice.line1',
  'voice.line2',
  'voice.line3',
  'voice.line4',
  'voice.line5',
] as const satisfies readonly StringTableKey[];

const LINE_COUNT = LINE_KEYS.length;

/**
 * OWNED BY: feel-builder. Random voice lines with subtitles.
 *
 * A third audio bus (voiceGain) is a SIBLING of masterGain and musicGain,
 * connected straight to ctx.destination. The Voice Volume slider owns it
 * independently of the SFX and Music sliders.
 *
 * Lines play every `FX_TUNING.voiceInterval` seconds of GAME time, not wall
 * time. The timer does NOT advance while the game is paused. No line plays on
 * the main menu (paused by default). No line overlaps another. No line repeats
 * immediately.
 *
 * The HTMLAudioElement streams the MP3 — `decodeAudioData` would bloat the
 * heap by ~30-60 MB of PCM per clip. `createMediaElementSource` routes it
 * through `voiceGain`.
 */
export class VoiceLineSystem {
  private static readStoredVoiceVolume(): number {
    try {
      const raw = localStorage.getItem(VOICE_STORAGE_KEY);
      if (raw === null) return 100;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return 100;
      return Math.max(0, Math.min(100, Math.round(parsed)));
    } catch {
      return 100;
    }
  }

  static voiceVolumePercent = VoiceLineSystem.readStoredVoiceVolume();

  static setVoiceVolumePercent(v: number): number {
    const next = Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 100)));
    VoiceLineSystem.voiceVolumePercent = next;
    try {
      localStorage.setItem(VOICE_STORAGE_KEY, String(next));
    } catch {
      // Private-mode contexts throw on localStorage; keep runtime state.
    }
    for (const instance of VoiceLineSystem.instances) instance.applyVoiceVolume();
    return next;
  }

  static voiceVolume(): number {
    return VoiceLineSystem.voiceVolumePercent;
  }

  private static readonly instances = new Set<VoiceLineSystem>();

  private ctx: AudioContext | null = null;
  private voiceGain: GainNode | null = null;
  private voiceEl: HTMLAudioElement | null = null;
  private voiceSource: MediaElementAudioSourceNode | null = null;

  private timer = FX_TUNING.voiceInterval;
  private lastIndex = -1;
  private playing = false;
  private paused = true;
  private rng = makeRng(Date.now());
  private active = false;

  /** Currently playing line's subtitle KEY, or null. Text is resolved at render
   *  time so a subtitle on screen follows a mid-line language switch. */
  private currentKey: StringTableKey | null = null;
  private onSubtitleChange: ((key: StringTableKey | null) => void) | null = null;

  constructor() {
    VoiceLineSystem.instances.add(this);
  }

  setOnSubtitleChange(cb: (key: StringTableKey | null) => void): void {
    this.onSubtitleChange = cb;
  }

  /**
   * Lazily create the voiceGain bus and route the streaming HTMLAudioElement
   * through it. Must be called from a user-gesture path so AudioContext
   * doesn't reject play().
   */
  ensure(ctx: AudioContext): void {
    if (this.ctx) return;
    this.ctx = ctx;

    this.voiceGain = ctx.createGain();
    this.voiceGain.connect(ctx.destination);
    this.applyVoiceVolume();

    const el = new Audio();
    el.preload = 'metadata';
    el.src = `${import.meta.env.BASE_URL}assets/audios/audio-01.mp3`;
    this.voiceSource = ctx.createMediaElementSource(el);
    this.voiceSource.connect(this.voiceGain);
    this.voiceEl = el;

    el.addEventListener('ended', () => {
      this.playing = false;
      this.currentKey = null;
      this.onSubtitleChange?.(null);
    });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.pauseVoice();
    }
  }

  start(): void {
    this.active = true;
    this.timer = FX_TUNING.voiceInterval;
  }

  stop(): void {
    this.active = false;
    this.pauseVoice();
    this.timer = FX_TUNING.voiceInterval;
  }

  update(ctx: UpdateContext): void {
    if (!this.active || this.paused || this.playing) return;
    this.timer -= ctx.dt;
    if (this.timer <= 0) {
      this.timer += FX_TUNING.voiceInterval;
      this.playRandomLine();
    }
  }

  /** Returns the KEY of the currently playing line, or null. */
  getCurrentKey(): StringTableKey | null {
    return this.currentKey;
  }

  private playRandomLine(): void {
    if (!this.ctx || !this.voiceGain || !this.voiceEl) return;
    const volume = VoiceLineSystem.voiceVolumePercent;
    if (volume <= 0) return;

    let idx: number;
    do {
      idx = Math.floor(this.rng() * LINE_COUNT);
    } while (idx === this.lastIndex && LINE_COUNT > 1);
    this.lastIndex = idx;

    const el = this.voiceEl;
    el.src = `${import.meta.env.BASE_URL}assets/audios/audio-0${idx + 1}.mp3`;
    this.currentKey = LINE_KEYS[idx];
    this.playing = true;
    this.onSubtitleChange?.(this.currentKey);

    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.catch(() => {
        this.playing = false;
        this.currentKey = null;
        this.onSubtitleChange?.(null);
      });
    }
  }

  private pauseVoice(): void {
    if (this.voiceEl && !this.voiceEl.paused) {
      this.voiceEl.pause();
    }
    this.playing = false;
    if (this.currentKey) {
      this.currentKey = null;
      this.onSubtitleChange?.(null);
    }
  }

  private applyVoiceVolume(): void {
    if (!this.ctx || !this.voiceGain) return;
    const percent = VoiceLineSystem.voiceVolumePercent;
    this.voiceGain.gain.setValueAtTime((percent / 100) * 2, this.ctx.currentTime);
  }

  dispose(): void {
    VoiceLineSystem.instances.delete(this);
    this.pauseVoice();
    this.voiceEl = null;
    this.voiceSource = null;
    this.voiceGain = null;
    this.ctx = null;
  }
}
