import * as THREE from 'three';
import { GLOBALS } from '../contracts/globals';
import { cameraHandle } from '../camera/cameraHandle';
import type { AnchorQuery, System, UpdateContext } from '../contracts';
import { Renderer } from './Renderer';
import { Telemetry, type FreeCameraPose, type GauntletApi, type TapeEntry } from './Telemetry';
import { Hud } from './Hud';
import { CitySystem } from '../city/CitySystem';
import { DayNightSystem } from '../city/DayNightSystem';
import { TraversalSystem } from '../swing/TraversalSystem';
import { CameraSystem } from '../camera/CameraSystem';
import { FxSystem } from '../fx/FxSystem';
import { AudioSystem } from '../fx/AudioSystem';
import { InputSystem } from '../input/InputSystem';
import { MainMenu, type GameMode } from '../ui/MainMenu';
import { Subtitles } from '../ui/Subtitles';
import { ScoreSystem, type ScoreReport } from '../score/ScoreSystem';
import { setLanguage } from '../i18n/i18n';
import { isClassicMode, setClassicMode, onClassicModeChange } from './ClassicMode';

/** LEAD-OWNED. Wiring + main loop. Builders extend their own systems, not this file. */
export class Game {
  private renderer: Renderer;
  private telemetry: Telemetry;
  private hud: Hud;
  private input: InputSystem;
  private city: CitySystem;
  private dayNight: DayNightSystem;
  private traversal: TraversalSystem;
  private camera: CameraSystem;
  private fx: FxSystem;
  private score: ScoreSystem;
  private subtitles: Subtitles;
  private menu: MainMenu | null = null;
  private systems: System[];

  private last = performance.now();
  private elapsed = 0;
  private frame = 0;
  private paused = true;
  private raf = 0;

  /** Critic staging: player pinned, world still live. See GauntletApi. */
  private playerFrozen = false;
  /** Harness-only deterministic clock; see the setFixedDelta hook below. */
  private fixedDelta: number | null = null;
  private freeCamPose: FreeCameraPose | null = null;
  private readonly freezeAt = new THREE.Vector3();

  /**
   * Debug-HUD visibility is the AND of two independent inputs: the player's
   * Settings preference and the harness override (`__GAUNTLET__.setHudVisible`).
   * The Settings toggle must never resurrect the debug block inside a critic
   * screenshot, and the harness switch must never strip it for a player who
   * asked for it — so each side mutates only its own flag and both feed one
   * apply. Defaults: preference ON (the game's long-standing behaviour), and
   * the harness has asked for nothing yet, so ON.
   */
  private debugHudPref = true;
  private debugHudHarness = true;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.telemetry = new Telemetry(this.renderer);
    this.input = new InputSystem(canvas);
    this.city = new CitySystem(this.renderer.scene);
    this.dayNight = new DayNightSystem(this.renderer.scene);
    this.traversal = new TraversalSystem(this.city, this.input.state);
    // The camera needs world queries for its collision sweep. It gets the frozen
    // AnchorQuery abstraction, never CitySystem itself, so the architecture rule
    // holds: only the contract couples the world to anything downstream.
    // Cast so this compiles whether or not the feel-builder has added the field yet.
    (cameraHandle as { world?: AnchorQuery }).world = this.city;
    this.camera = new CameraSystem(this.renderer.camera, this.traversal.snapshot, this.input.state);
    this.fx = new FxSystem(this.renderer.scene, this.traversal.snapshot);
    this.hud = new Hud();
    this.score = new ScoreSystem(this.traversal.snapshot);
    this.subtitles = new Subtitles();

    // Wire voice-line subtitles to the overlay. VoiceLineSystem fires the
    // callback on play and on end with the line's KEY; Subtitles resolves it to
    // text at render time so a switch mid-line re-renders in the new language.
    const voiceLines = AudioSystem.getPrimary()?.getVoiceLines();
    voiceLines?.setOnSubtitleChange((key) => {
      if (key) this.subtitles.showKey(key);
      else this.subtitles.hide();
    });

    // Order matters: input -> world -> traversal -> camera -> fx -> score.
    // Score reads the snapshot after traversal has written it, so it sees this
    // frame's state and one-shot edges rather than the previous frame's.
    this.systems = [this.input, this.city, this.dayNight, this.traversal, this.camera, this.fx, this.score];

    this.resetWorld();
    this.exposeApi();
    this.menu = new MainMenu(canvas, {
      setPaused: (paused) => this.setPaused(paused),
      reset: () => (window as unknown as { __GAUNTLET__: GauntletApi }).__GAUNTLET__.reset(),
      // The menu owns the MODE; ScoreSystem owns the model. This one call is the
      // whole surface between them — no window globals, no reaching inside.
      setScoringEnabled: (on) => this.score.setEnabled(on),
      // The menu owns the PREFERENCE; Game owns the HUD and ANDs it with the
      // harness override so a critic's setHudVisible(false) always wins.
      setDebugHudVisible: (on) => {
        this.debugHudPref = on;
        this.applyDebugHudVisible();
      },
      // The menu owns the PREFERENCE and its persistence lives in
      // core/ClassicMode, which is also what `__GAUNTLET__.setClassicMode`
      // drives — one flag, three entry points.
      setClassicMode: (on) => { setClassicMode(on); },
    });
    this.loop();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    this.telemetry.sample(rawDt * 1000);

    if (!this.paused) {
      // `fixedDelta` (see setFixedDelta) replaces wall-clock dt for EVERY system,
      // including the input tape's own clock, so a replay is frame-exact rather
      // than merely drift-free. Null = normal wall-clock play.
      const dt = this.fixedDelta ?? Math.min(rawDt, GLOBALS.maxDeltaSeconds);
      this.elapsed += dt;
      this.frame++;
      const ctx: UpdateContext = { dt, elapsed: this.elapsed, frame: this.frame };
      this.traversal.setAimYaw(this.camera.yaw);
      for (const s of this.systems) {
        // Staging modes skip exactly one system each and leave every other
        // system running, which is the point: the city must keep streaming and
        // re-LODing around a player that is being held still or moved by hand.
        if (this.playerFrozen && s === this.traversal) {
          this.traversal.snapshot.position.copy(this.freezeAt);
          this.traversal.snapshot.velocity.set(0, 0, 0);
          this.traversal.snapshot.speed = 0;
          continue;
        }
        if (this.freeCamPose && s === this.camera) continue;
        s.update(ctx);
      }
      if (this.freeCamPose) this.applyFreeCamera();
    }

    this.renderer.render();
    this.hud.update(this.telemetry.report(), this.traversal.snapshot, this.city.buildingCount);
    (window as unknown as { __GAUNTLET__: GauntletApi }).__GAUNTLET__.frameCount = this.frame;
  };

  private exposeApi() {
    const api: GauntletApi = {
      ready: true,
      frameCount: 0,
      perf: () => this.telemetry.report(),
      player: () => this.traversal.snapshot,
      playTape: (tape: TapeEntry[]) => {
        this.telemetry.clear();
        this.setPaused(false);
        return this.input.playTape(tape);
      },
      reset: () => this.resetWorld(),
      setPaused: (p: boolean) => this.setPaused(p),
      setTimeOfDay: (t: number) => {
        this.dayNight.paused = true;
        this.dayNight.setTimeOfDay(t);
      },
      setHudVisible: (v: boolean) => {
        this.debugHudHarness = v;
        this.applyDebugHudVisible();
        // The score overlay and voice-line subtitles obey the same switch,
        // so critic screenshots and the tod-sweep are never polluted.
        this.score.setHudVisible(v);
        this.subtitles.setVisible(v);
      },
      // Classic mode: the flag is owned by core/ClassicMode, which notifies the
      // four systems that render it. Game only mirrors the state onto the
      // automation surface, and does so from the subscription below as well, so
      // the Settings toggle and this setter can never disagree.
      classicMode: isClassicMode(),
      setClassicMode: (v: boolean) => setClassicMode(v),
      setPlayerPosition: (x, y, z, freeze) => this.setPlayerPosition(x, y, z, freeze),
      setPlayerFrozen: (f) => this.setPlayerFrozen(f),
      setFreeCamera: (pose) => this.setFreeCamera(pose),
    };
    // Additive: the combo score. Attached after construction rather than added
    // to the frozen GauntletApi interface, following the setFixedDelta pattern.
    // It is the only way to verify the scoring model headlessly.
    (api as GauntletApi & { score?: () => ScoreReport }).score = () => this.score.report();
    // Additive: which mode the current run is in ('arcade' | 'libre'). The
    // harness always lands in 'arcade' (see MainMenu.dismissForHarness).
    (api as GauntletApi & { gameMode?: () => GameMode | null }).gameMode =
      () => this.menu?.currentMode() ?? null;

    // Additive: language control. Lets the harness set the UI language for
    // critic screenshots without touching localStorage.
    (api as GauntletApi & { setLanguage?: (lang: string) => void }).setLanguage =
      (lang: string) => {
        if (lang === 'en' || lang === 'es') setLanguage(lang);
      };

    // Additive hook — deliberately attached after construction rather than added
    // to the frozen GauntletApi interface in Telemetry.ts (lead-owned).
    //
    // WHY IT EXISTS. The traversal solver now carries its substep remainder
    // across frames, so simulated time tracks real time and the simulation no
    // longer speeds up and slows down with rAF jitter. That removes the DRIFT,
    // but it cannot remove the fact that rAF delivery is still wall-clock: two
    // runs get different dt sequences, so state transitions still land on
    // slightly different frames and a frame-indexed comparison still shows
    // small differences. Frame-EXACT replay needs the dt sequence itself to be
    // identical, which only a fixed-dt driver can provide.
    //
    // Pass milliseconds (e.g. 1000/60) to pin every system's dt; pass null to
    // hand the clock back to the wall. Real play must never call this — it makes
    // the game run at a speed decoupled from real time when frames are late.
    (api as GauntletApi & { setFixedDelta?: (ms: number | null) => void }).setFixedDelta =
      (ms: number | null) => {
        this.fixedDelta = ms === null ? null : Math.max(0, ms) / 1000;
      };
    onClassicModeChange((on) => { api.classicMode = on; });
    (window as unknown as { __GAUNTLET__: GauntletApi }).__GAUNTLET__ = api;
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.menu?.dismissForHarness();
      const voiceLines = AudioSystem.getPrimary()?.getVoiceLines();
      voiceLines?.setPaused(false);
      voiceLines?.start();
    } else {
      const voiceLines = AudioSystem.getPrimary()?.getVoiceLines();
      voiceLines?.setPaused(true);
    }
  }

  /** Apply the effective debug-HUD visibility: preference AND harness override. */
  private applyDebugHudVisible(): void {
    this.hud.setVisible(this.debugHudPref && this.debugHudHarness);
  }

  private resetWorld(): void {
    this.traversal.reset();
    // reset() is the harness/critic entry point and exit-to-menu goes through
    // it, so the run must end here or a replay would start mid-combo.
    this.score.reset();
    const s = this.traversal.snapshot;
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);
    s.altitude = Math.max(0, s.position.y - this.city.surfaceHeightAt(s.position.x, s.position.z));
    s.anchorPosition = null;
    s.ropeLength = 0;
    s.justAttached = false;
    s.justReleased = false;
    s.justGroundPull = false;
    // The camera's yaw is authoritative for the player's aim (setAimYaw), so
    // a reset that leaves it wherever the pre-reset frames drifted it to is
    // NOT a deterministic start state — and that residual was measured: with
    // an otherwise frame-exact replay it was the only remaining source of
    // divergence, growing from 2e-5 m at frame 0 to 1.7 m by the end of a
    // 985-frame tape. Zeroing it here costs nothing in play (reset is a
    // harness/critic entry point) and makes the aim reproducible.
    this.camera.yaw = 0;
    this.telemetry.clear();
  }

  // ---------------------------------------------------------------------------
  // critic staging — see the GauntletApi docs for why these exist
  // ---------------------------------------------------------------------------

  private setPlayerPosition(x: number, y: number, z: number, freeze?: boolean): void {
    // reset() first so the player does not arrive still attached to an anchor
    // 800 m away, which would immediately whip them back out of frame.
    this.traversal.reset();
    const s = this.traversal.snapshot;
    s.position.set(x, y, z);
    s.velocity.set(0, 0, 0);
    s.speed = 0;
    this.freezeAt.set(x, y, z);
    if (freeze !== undefined) this.playerFrozen = freeze;
    // Settle the world synchronously so the caller can screenshot immediately —
    // and so this works while paused, when update() never runs.
    this.city.refocus();
    if (this.freeCamPose) this.applyFreeCamera();
  }

  private setPlayerFrozen(frozen: boolean): void {
    this.playerFrozen = frozen;
    if (frozen) this.freezeAt.copy(this.traversal.snapshot.position);
  }

  private setFreeCamera(pose: FreeCameraPose | null): void {
    this.freeCamPose = pose;
    if (pose) this.applyFreeCamera();
  }

  private applyFreeCamera(): void {
    const p = this.freeCamPose;
    if (!p) return;
    const cam = this.renderer.camera;
    cam.position.set(p.x, p.y, p.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(p.lookAtX, p.lookAtY, p.lookAtZ);
    if (p.fov !== undefined && p.fov !== cam.fov) {
      cam.fov = p.fov;
      cam.updateProjectionMatrix();
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.menu?.dispose();
    this.subtitles.dispose();
    for (const s of this.systems) s.dispose?.();
    this.renderer.dispose();
  }
}
