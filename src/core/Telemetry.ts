import type { PlayerSnapshot } from '../contracts';
import type { Renderer } from './Renderer';

/**
 * FROZEN CONTRACT — lead-owned. This is the automation surface every critic and
 * the capture harness depends on. Do not rename or remove fields; only add.
 *
 * Exposed on the page as `window.__GAUNTLET__`.
 */
export interface GauntletApi {
  ready: boolean;
  /** Rolling perf window. */
  perf(): PerfReport;
  /** Current player/traversal snapshot. */
  player(): PlayerSnapshot | null;
  /** Drive the game from a scripted input tape (headless gameplay capture). */
  playTape(tape: TapeEntry[]): Promise<void>;
  /** Reset the world to a deterministic start state. */
  reset(seed?: number): void;
  /** Freeze/unfreeze simulation for clean screenshots. */
  setPaused(p: boolean): void;
  /** Force a specific time of day, 0..1 (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset). */
  setTimeOfDay(t: number): void;
  /** Hide the debug HUD for reference-comparable screenshots. */
  setHudVisible(v: boolean): void;
  /** Frames rendered since load — lets the harness wait for real progress. */
  frameCount: number;

  /**
   * ADDITIVE. Is "Modo clásico" on? Kept in sync however the mode is changed —
   * this setter, the Settings panel, or the stored preference read at boot.
   */
  classicMode: boolean;
  /**
   * ADDITIVE. Turn the classic (initial-build) look on or off at runtime, and
   * return the applied state. One call applies all five changes atomically:
   * procedural sky (no photographic plates), no distance fog, no dynamic
   * shadows, flat untextured ground, and the procedural box hero. Default OFF —
   * a harness that never calls this sees exactly today's look.
   */
  setClassicMode(v: boolean): boolean;

  // --- critic staging controls -----------------------------------------------
  //
  // Added because a visual critic had to mark rooftop LOD 0/1/2 popping BLOCKED:
  // the detail tiers key off distance from the PLAYER (rooftopTertiaryRadius
  // 180 m, rooftopSecondaryRadius 330 m) and the only way to move the player was
  // `playTape`, which either overshot by 1200 m or wedged him against a wall.
  // These three put the player and the camera under direct control so a criterion
  // that has never been testable becomes testable.

  /**
   * Teleport the player. Resets traversal state, zeroes velocity and immediately
   * re-streams the city so chunk residency and both LOD sweeps settle in the
   * same call — the returned promise is not needed, the world is correct on
   * return, even while paused.
   *
   * @param freeze pin the player here (see `setPlayerFrozen`). Defaults to the
   *               current freeze state, so repeated calls while frozen stay frozen.
   */
  setPlayerPosition(x: number, y: number, z: number, freeze?: boolean): void;
  /**
   * Hold the player exactly where they are: traversal stops updating, but the
   * city, day/night, camera and FX keep running. This is what lets a critic step
   * the player across an LOD radius one call at a time without gravity or the
   * swing solver moving them in between.
   */
  setPlayerFrozen(frozen: boolean): void;
  /**
   * Detach the camera from the player. While detached the camera system stops
   * driving the view and the camera holds the pose given here, so the critic can
   * keep one building framed identically while the player moves across a radius.
   * Call with `null` to hand the camera back to the camera system.
   */
  setFreeCamera(pose: FreeCameraPose | null): void;
}

/** World-space camera placement for `setFreeCamera`. */
export interface FreeCameraPose {
  x: number; y: number; z: number;
  /** Point the camera looks at. */
  lookAtX: number; lookAtY: number; lookAtZ: number;
  /** Vertical FOV in degrees. Omit to keep the camera's current FOV. */
  fov?: number;
}

/** Where `jsHeapMb` came from, so nobody has to guess whether it is real. */
export type JsHeapSource =
  /** `performance.memory` observed to actually move — trustworthy. */
  | 'performance.memory'
  /** `performance.memory` present but returning a frozen, bucketised constant. */
  | 'performance.memory:quantised'
  /** No heap API at all (non-Chromium). */
  | 'unavailable';

export interface PerfReport {
  fps: number;
  frameMsAvg: number;
  frameMsP95: number;
  frameMsMax: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  /**
   * Live JS heap, or `null` when the browser cannot give a moving value.
   *
   * It is deliberately `null` rather than a plausible constant in the quantised
   * case — see `jsHeapSource`. A perf critic once recorded 7,203 identical
   * samples of "15.4 MB" and reported it as a measurement.
   */
  jsHeapMb: number | null;
  /** Which of the three cases above produced `jsHeapMb`. Additive field. */
  jsHeapSource: JsHeapSource;
  /** The frozen constant Chrome returned, when `jsHeapSource` is quantised. */
  jsHeapRawMb: number | null;
  /** Human-readable reason, non-null exactly when `jsHeapMb` is null. */
  jsHeapNote: string | null;
  /**
   * GPU resource counts from `renderer.info.memory`. The cheapest possible
   * regression gate for leaked GPU objects: both are bounded by streaming
   * residency, so a monotonic climb means something is not being disposed.
   */
  geometries: number;
  textures: number;
  loadMs: number;
  samples: number;
}

/** One scripted input frame: hold these inputs for `ms` milliseconds. */
export interface TapeEntry {
  ms: number;
  moveX?: number;
  moveY?: number;
  lookX?: number;
  lookY?: number;
  swing?: boolean;
  dash?: boolean;
  dive?: boolean;
  jump?: boolean;
}

export class Telemetry {
  private times: number[] = [];
  private cursor = 0;
  private readonly cap = 240;
  readonly loadMs: number;

  // --- JS heap credibility ---------------------------------------------------
  //
  // `performance.memory.usedJSHeapSize` is a fingerprinting/timing-attack
  // surface, so Chrome both buckets it to 100 KB AND caches it for ~20 minutes
  // unless the browser was started with `--enable-precise-memory-info`.
  // `tools/capture.mjs` passes that flag; an independent critic driving their
  // own Chromium does not, and gets a byte-identical constant for the whole
  // session. Measured here: 1 distinct value in 24 samples without the flag,
  // 24 distinct values with it, while CDP saw a real 12–22 MB range both times.
  //
  // So we watch the raw value ourselves and only publish a number once we have
  // seen it move. Until then the report says it cannot measure, rather than
  // repeating a confident constant that would hide any leak underneath it.
  private heapFirst: number | null = null;
  private heapLast: number | null = null;
  private heapMoved = false;
  private heapFirstSeenMs = 0;
  /** How long a byte-identical reading must persist before we call it frozen. */
  private readonly heapStaleAfterMs = 3000;

  constructor(private renderer: Renderer) {
    this.loadMs = Math.round(performance.now());
  }

  sample(frameMs: number) {
    if (this.times.length < this.cap) this.times.push(frameMs);
    else {
      this.times[this.cursor] = frameMs;
      this.cursor = (this.cursor + 1) % this.cap;
    }
    this.sampleHeap();
  }

  /** Called every frame so staleness is measured in wall time, not in polls. */
  private sampleHeap(): void {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (!mem) return;
    const v = mem.usedJSHeapSize;
    if (this.heapFirst === null) {
      this.heapFirst = v;
      this.heapFirstSeenMs = performance.now();
    } else if (v !== this.heapLast) {
      this.heapMoved = true;
    }
    this.heapLast = v;
  }

  private heapReport(): Pick<PerfReport, 'jsHeapMb' | 'jsHeapSource' | 'jsHeapRawMb' | 'jsHeapNote'> {
    const raw = this.heapLast;
    if (raw === null) {
      return {
        jsHeapMb: null,
        jsHeapSource: 'unavailable',
        jsHeapRawMb: null,
        jsHeapNote: 'performance.memory is not implemented in this browser.',
      };
    }
    const mb = +(raw / 1048576).toFixed(1);
    // Not yet enough wall time to tell a stable heap from a frozen reading —
    // report the value, but do not yet claim it is trustworthy.
    const settled = performance.now() - this.heapFirstSeenMs >= this.heapStaleAfterMs;
    if (this.heapMoved || !settled) {
      return { jsHeapMb: mb, jsHeapSource: 'performance.memory', jsHeapRawMb: mb, jsHeapNote: null };
    }
    return {
      jsHeapMb: null,
      jsHeapSource: 'performance.memory:quantised',
      jsHeapRawMb: mb,
      jsHeapNote:
        `performance.memory has returned exactly ${mb} MB for the whole session; `
        + 'Chrome buckets and caches it (~20 min) unless the browser is launched with '
        + '--enable-precise-memory-info. This is a constant, not a measurement.',
    };
  }

  report(): PerfReport {
    const t = [...this.times].sort((a, b) => a - b);
    const n = t.length || 1;
    const avg = (this.times.reduce((s, v) => s + v, 0) || 0) / n;
    const info = this.renderer.gl.info;
    return {
      ...this.heapReport(),
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      fps: avg > 0 ? Math.round(1000 / avg) : 0,
      frameMsAvg: +avg.toFixed(2),
      frameMsP95: +(t[Math.floor(n * 0.95)] ?? 0).toFixed(2),
      frameMsMax: +(t[n - 1] ?? 0).toFixed(2),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      loadMs: this.loadMs,
      samples: this.times.length,
    };
  }

  /** Drop the warm-up frames so shader compilation doesn't poison the numbers. */
  clear() {
    this.times = [];
    this.cursor = 0;
  }
}
