import * as THREE from 'three';
import type { PlayerSnapshot, System, TraversalState, UpdateContext } from '../contracts';
import { FX_TUNING as T } from './tuning';
import { PlayerFigure } from './PlayerFigure';
import { CharacterModel, loadCharacterAsset } from './CharacterModel';
import { ANKLE_REST, ankleRollDebug, PULL_TOTAL, wallRunDebug, type CharacterRig } from './poses';
import { MotionController, type FlipKind } from './motion';
import { SpeedOverlay } from './SpeedOverlay';
import { AudioSystem } from './AudioSystem';
import { ControlPrompt } from './ControlPrompt';
import { DashHud } from './DashHud';
import { cameraHandle } from '../camera/cameraHandle';
import { inputHandle } from '../input/inputHandle';
import { isClassicMode, onClassicModeChange } from '../core/ClassicMode';

/** Seconds the crosshair stays dimmed after a web press that found nothing. */
const REFUSED_DIM_TIME = 0.16;

/** Which hero representation renders. Gameplay is identical in both. */
export type CharacterMode = 'procedural' | 'model';

type FxDebugApi = Record<string, unknown> & {
  setCharacterMode?: (mode: CharacterMode) => CharacterMode;
  characterMode?: CharacterMode;
  characterModelReady?: boolean;
  characterStats?: () => unknown;
  triggerGroundPull?: () => void;
  setCharacterPoseState?: (state: TraversalState | null) => void;
  setWallRunShiftScale?: (scale: number) => void;
  setAnkleRollScale?: (drive: number, roll?: number) => void;
  setMotionVariant?: (i: number | null) => void;
  setMotionFlip?: (kind: string | null) => void;
};

/**
 * OWNER: feel-builder.
 * Visual feedback + audio orchestration (reference-pack/VISUAL_FEEDBACK.md):
 *  - taut, visible web line with an attach shoot-out and a release snap
 *  - white flash glints on attach / release
 *  - state-readable player silhouette, in either character mode (PlayerFigure
 *    boxes or the authored skinned CharacterModel — see `setCharacterMode`)
 *  - the two-handed ground web pull: TWO strands, not one
 *  - a one-shot dash web throw strand (cosmetic; separate from the swing line)
 *  - speed streaks + wind wisps (SpeedOverlay)
 *  - synthesized wind / thwip / whoosh (AudioSystem)
 * Everything is deterministic (driven by snapshot + ctx) and cheap: a handful
 * of extra draw calls, no post-processing.
 */
export class FxSystem implements System {
  private figure: PlayerFigure;
  private model: CharacterModel | null = null;
  /** The rig currently being updated and drawn. */
  private rig: CharacterRig;
  private characterMode: CharacterMode = isClassicMode() ? 'procedural' : T.characterMode;
  /**
   * The mode to go back to when classic mode turns off.
   *
   * RULE (deliberately simple and predictable): an EXPLICIT
   * `setCharacterMode()` call always wins and always becomes the mode we
   * restore — including while classic is on. So classic ON forces 'procedural',
   * and classic OFF restores whatever was last chosen explicitly, or the mode
   * that was live before classic was switched on if nothing was chosen since.
   */
  private preClassicMode: CharacterMode = T.characterMode;
  private unsubscribeClassic: (() => void) | null = null;
  private modelLoadStarted = false;
  private modelLoadFailed = false;
  private modelLoadMs = 0;
  /** Set by `__GAUNTLET__.triggerGroundPull()`; consumed on the next frame. */
  private pullRequest = false;
  /** See `setAmbientOnly`: pose + travelling lights only, for the title screen. */
  private ambientOnly = false;
  private debugApiAttached = false;
  /**
   * Visual-only state override for `__GAUNTLET__.setCharacterPoseState`. The
   * pose library covers every TraversalState, but the traversal system does not
   * currently transition into all of them (PERCH has no entry edge), so without
   * this there is no way to put eyes on those poses in the running game — and in
   * this project a description is not evidence. Affects nothing but which pose
   * the rig is asked for.
   */
  private poseOverride: TraversalState | null = null;
  private overrideSnap: PlayerSnapshot | null = null;
  private overlay: SpeedOverlay;
  private audio: AudioSystem;
  private prompt: ControlPrompt;
  private dashHud: DashHud;
  /** The crosshair element, for the refused-web acknowledgement. Looked up
   *  lazily because index.html owns it and it may not exist in a test page. */
  private crosshair: HTMLElement | null = null;
  private crosshairLookedUp = false;
  /** Seconds left on the "that press found nothing" dim. */
  private refusedDim = 0;
  private navLight: THREE.PointLight;
  private nightFill: THREE.HemisphereLight;
  private streetSkimLight: THREE.PointLight;
  private streetSkimPool: THREE.Mesh;
  private streetSkimPoolMat: THREE.MeshBasicMaterial;
  private streetSkimQuat = new THREE.Quaternion();

  private web: THREE.Mesh;
  private webMat: THREE.MeshBasicMaterial;
  private webDir = new THREE.Vector3();
  private webUp = new THREE.Vector3(0, 1, 0);
  private webQuat = new THREE.Quaternion();
  private webAnchor = new THREE.Vector3();
  private webAnim = 0;      // 0..1 attached progress
  private webPhase: 'attaching' | 'attached' | 'snapping' | 'off' = 'off';
  private webTimer = 0;

  /** The two ground-pull strands. Separate from the swing line: they coexist. */
  private pullWebs: THREE.Mesh[] = [];
  private pullWebMat: THREE.MeshBasicMaterial;
  private pullAnchors = [new THREE.Vector3(), new THREE.Vector3()];
  private pullClock = -1;

  /**
   * Cosmetic dash throw strand. Same cylinder recipe as pullWebs / this.web,
   * but its own mesh so the swing line is never disturbed. Driven only by
   * PlayerSnapshot.state/stateTime/velocity — never writes back to gameplay.
   */
  private dashThrow: THREE.Mesh;
  private dashThrowMat: THREE.MeshBasicMaterial;
  private dashThrowDir = new THREE.Vector3();

  private glint: THREE.Mesh;
  private glintMat: THREE.MeshBasicMaterial;
  private glintPos = new THREE.Vector3();
  private glintTimer = 0;

  private hand = new THREE.Vector3();
  private tmp1 = new THREE.Vector3();
  private camForward = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private player: PlayerSnapshot) {
    this.figure = new PlayerFigure(scene);
    this.rig = this.figure;
    this.overlay = new SpeedOverlay(scene);
    this.audio = new AudioSystem();
    this.prompt = new ControlPrompt();
    this.dashHud = new DashHud();
    this.navLight = new THREE.PointLight(
      T.navigationLightColor,
      0,
      T.navigationLightDistance,
      2,
    );
    this.navLight.visible = false;
    scene.add(this.navLight);
    this.nightFill = new THREE.HemisphereLight(
      T.nightFillSkyColor,
      T.nightFillGroundColor,
      0,
    );
    this.nightFill.visible = false;
    scene.add(this.nightFill);
    this.streetSkimLight = new THREE.PointLight(
      T.streetSkimLightColor,
      0,
      T.streetSkimLightDistance,
      2,
    );
    this.streetSkimLight.visible = false;
    scene.add(this.streetSkimLight);
    // Ground pool is OFF by default: at skim it filled the street with a hard
    // khaki rectangle rather than reading as light on the road. Kept behind
    // FX_TUNING.streetSkimPool (same retirement pattern as screenStreaks).
    this.streetSkimPoolMat = new THREE.MeshBasicMaterial({
      color: T.streetSkimPoolColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.streetSkimPool = new THREE.Mesh(
      new THREE.PlaneGeometry(T.streetSkimPoolWidth, T.streetSkimPoolLength),
      this.streetSkimPoolMat,
    );
    this.streetSkimPool.visible = false;
    this.streetSkimPool.renderOrder = 2;
    if (T.streetSkimPool) scene.add(this.streetSkimPool);

    // web line: a thin cylinder stretched between grip hand and anchor
    const webGeo = new THREE.CylinderGeometry(T.webRadius, T.webRadius, 1, 5, 1, true);
    webGeo.translate(0, 0.5, 0); // anchor the cylinder at its base so we scale Y from the hand
    // Normal blending, not additive: at a 0.04 m radius an additive strand
    // disappears entirely against a bright sky, which is exactly where the web
    // needs to read. Opaque white holds against sky, facade and night alike.
    this.webMat = new THREE.MeshBasicMaterial({
      color: T.webColor,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.web = new THREE.Mesh(webGeo, this.webMat);
    this.web.renderOrder = 5;
    this.web.visible = false;
    scene.add(this.web);

    // attach/release glint
    const glintGeo = new THREE.SphereGeometry(0.5, 8, 6);
    this.glintMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.glint = new THREE.Mesh(glintGeo, this.glintMat);
    this.glint.renderOrder = 6;
    this.glint.visible = false;
    scene.add(this.glint);

    // Two strands for the ground pull. They share a material (one extra program,
    // two extra draw calls, and only while the move is on screen).
    this.pullWebMat = new THREE.MeshBasicMaterial({
      color: T.webColor, transparent: true, opacity: 0.95, depthWrite: false,
    });
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.CylinderGeometry(T.webRadius, T.webRadius, 1, 5, 1, true);
      geo.translate(0, 0.5, 0);
      const mesh = new THREE.Mesh(geo, this.pullWebMat);
      mesh.renderOrder = 5;
      mesh.visible = false;
      scene.add(mesh);
      this.pullWebs.push(mesh);
    }

    // One transient strand for the dash throw. Same material recipe as the
    // pull webs (normal blend, thin radius) so it reads against sky/facade
    // without inventing a third look. +1 draw call only while visible.
    this.dashThrowMat = new THREE.MeshBasicMaterial({
      color: T.webColor, transparent: true, opacity: 0.95, depthWrite: false,
    });
    {
      const geo = new THREE.CylinderGeometry(T.webRadius, T.webRadius, 1, 5, 1, true);
      geo.translate(0, 0.5, 0);
      this.dashThrow = new THREE.Mesh(geo, this.dashThrowMat);
      this.dashThrow.renderOrder = 5;
      this.dashThrow.visible = false;
      scene.add(this.dashThrow);
    }

    // The game always BOOTS on the procedural figure; the authored skin swaps in
    // whenever it finishes loading. Nothing here blocks the first frame.
    if (this.characterMode === 'model') this.ensureModel();

    // Classic mode's hero is the original hand-built box figure.
    this.unsubscribeClassic = onClassicModeChange((on) => {
      this.applyCharacterMode(on ? 'procedural' : this.preClassicMode);
    });

    this.syncFxDebugApi();
  }

  // ---------------------------------------------------------------------------
  // character mode (procedural boxes <-> authored skinned model)
  //
  // Mirrors CitySystem.setBuildingMode: an authored default in tuning.ts plus an
  // additive runtime switch on window.__GAUNTLET__, so the two can be A/B'd
  // without a rebuild. Purely a rendering choice — the rigs read the same
  // snapshot and the same pose library, and neither writes back to gameplay.
  // ---------------------------------------------------------------------------

  /** Runtime toggle, mirrored onto `window.__GAUNTLET__.setCharacterMode`. */
  private readonly setCharacterMode = (mode: CharacterMode): CharacterMode => {
    const next: CharacterMode = mode === 'model' ? 'model' : 'procedural';
    // An explicit choice is also the choice classic mode hands back to (see
    // `preClassicMode`).
    this.preClassicMode = next;
    return this.applyCharacterMode(next);
  };

  /** The mode switch itself, with no bearing on what classic mode restores. */
  private applyCharacterMode(next: CharacterMode): CharacterMode {
    if (next !== this.characterMode) {
      this.characterMode = next;
      if (next === 'model') this.ensureModel();
    }
    this.selectRig();
    this.syncFxDebugApi();
    return this.characterMode;
  }

  /** Point `rig` at the active representation and hide the other one. */
  private selectRig(): void {
    const useModel = this.characterMode === 'model' && this.model !== null;
    this.rig = useModel ? this.model! : this.figure;
    this.figure.root.visible = !useModel;
    if (this.model) this.model.root.visible = useModel;
  }

  /** Kick off the (async, non-blocking) GLB load exactly once. */
  private ensureModel(): void {
    if (this.modelLoadStarted) return;
    this.modelLoadStarted = true;
    const t0 = performance.now();
    loadCharacterAsset(T.characterModelUrl)
      .then((asset) => {
        this.modelLoadMs = Math.round(performance.now() - t0);
        this.model = new CharacterModel(this.scene, asset);
        this.selectRig();
        this.syncFxDebugApi();
      })
      .catch((err) => {
        // Never throw into the frame loop: the procedural figure is a complete,
        // shipping-quality hero, so a missing asset degrades instead of breaking.
        this.modelLoadFailed = true;
        console.warn('[fx] authored character unavailable, staying on the procedural figure:', err);
        this.syncFxDebugApi();
      });
  }

  /**
   * Attach the FX surface to `window.__GAUNTLET__`, additively — the object is
   * lead-owned and created after the systems are, so the update loop keeps
   * retrying until it exists and then stops (state changes call this directly).
   */
  private syncFxDebugApi(): void {
    if (typeof window === 'undefined') return;
    const api = (window as unknown as { __GAUNTLET__?: FxDebugApi }).__GAUNTLET__;
    if (!api) return;
    this.debugApiAttached = true;
    api.setCharacterMode = this.setCharacterMode;
    api.characterMode = this.characterMode;
    api.characterModelReady = !!this.model;
    api.characterStats = () => ({
      mode: this.characterMode,
      active: this.model && this.rig === this.model ? 'model' : 'procedural',
      modelReady: !!this.model,
      modelFailed: this.modelLoadFailed,
      modelLoadMs: this.modelLoadMs,
      modelTriangles: this.model?.triangles ?? 0,
      modelMeshes: this.model?.meshCount ?? 0,
      poseState: this.poseOverride,
      poseAuthority: this.model ? +this.model.poseAuthority.toFixed(3) : null,
      poseReport: this.model?.poseReport() ?? null,
      rootPitchDeg: this.model?.rootPitchDeg ?? null,
      // The wall-run hip offset is a small translation with two possible
      // directions; a screenshot alone cannot say it went the right way, so the
      // active rig publishes the facade normal it recovered, the side that
      // resolved to, and the shift it actually applied.
      wallRun: this.rig.wallDebug(),
      // Which pose variant this VISIT to the state selected, how far the physics
      // has driven it toward its partner, and the live flip state. "The hero now
      // varies" is not a claim a still frame can settle, so the numbers are
      // published: a critic can capture the same state twice and read two
      // different variant indices, or watch flip.t run 0 -> 1 across a burst.
      motion: this.rig.motionReport(this.posedSnapshot(this.player)),
      motionVariantPin: MotionController.pinned,
      // The cosmetic dash strand, LIVE. `api.dashThrow()` has always exposed the
      // same numbers, but only to a caller who already knew to ask for them: the
      // animation critic's tape recorder sampled `characterStats()` per frame,
      // found no throw direction in it, and had to mark "web throw follows dash
      // direction" BLOCKED rather than guess. It is a claim about a DIRECTION
      // over TIME, so it belongs in the per-frame telemetry, next to the dash
      // pose that is supposed to agree with it. `travelYawDeg` is the direction
      // the body is actually moving, so the agreement is one subtraction away
      // and needs no second sample to check against.
      dashThrow: this.dashThrowReport(),
      clips: this.model && this.rig === this.model ? this.model.clipReport() : null,
      wallRunShiftScale: wallRunDebug.scale,
      // The ankle channel: what the pose asked for, whether the foot bones are
      // actually being driven, and whether the roll is being resolved. `ankle`
      // in poseReport is the proof the bones reached their targets; these are
      // the switches that produced the frame.
      ankle: {
        drive: ankleRollDebug.drive,
        roll: ankleRollDebug.roll,
        /** The rig's own bind ankle, radians — what ANKLE_REST has to match. */
        bind: this.model?.ankleBind ?? null,
        rest: ANKLE_REST,
      },
    });
    // Pin a pose variant for side-by-side capture; null restores seeded
    // selection. Same purpose as setWallRunShiftScale: make a claim about
    // variety inspectable in one session instead of across rebuilds.
    api.setMotionVariant = (i: number | null) => { MotionController.pinned = i; };
    // Force the KIND of the next airborne flip, so a back flip or a barrel roll
    // can be captured without waiting for a tape that happens to produce one.
    api.setMotionFlip = (kind) => {
      MotionController.forcedFlip = (kind ?? null) as FlipKind | null;
    };
    // A/B handle for the wall-run hip offset: 0 disables it, 1 ships it. Lets a
    // critic capture the same wall run with and without it in one session.
    api.setWallRunShiftScale = (s: number) => { wallRunDebug.scale = s; };
    // A/B handle for the ankle: `(0)` restores the undriven, twisted foot and
    // `(1, 0)` drives the foot but leaves the roll as the minimal arc, so the
    // twist and the fix can be captured from one camera in one session.
    api.setAnkleRollScale = (drive: number, roll?: number) => {
      ankleRollDebug.drive = drive;
      ankleRollDebug.roll = roll ?? drive;
    };
    // The two-handed pull is produced by the traversal system; this lets a
    // critic fire the FX + animation on demand without a scripted tape.
    api.triggerGroundPull = () => { this.pullRequest = true; };
    api.setCharacterPoseState = (state) => { this.poseOverride = state; };
    // Read-only probe for the cosmetic dash throw (critics / scratch harness).
    // Same object `characterStats().dashThrow` publishes, so a critic sampling
    // either surface reads identical numbers.
    api.dashThrow = () => this.dashThrowReport();
  }

  /**
   * The live state of the cosmetic dash strand: is it on screen, which way is it
   * pointing, and which way is the body travelling. Published both standalone
   * (`api.dashThrow()`) and inside `characterStats()`, because "the web throw
   * follows the dash direction" is only checkable from a per-frame recording.
   */
  private dashThrowReport(): Record<string, unknown> {
    const v = this.player.velocity;
    return {
      visible: this.dashThrow.visible,
      state: this.player.state,
      stateTime: +this.player.stateTime.toFixed(3),
      length: +this.dashThrow.scale.y.toFixed(3),
      opacity: +this.dashThrowMat.opacity.toFixed(3),
      dir: {
        x: +this.dashThrowDir.x.toFixed(4),
        y: +this.dashThrowDir.y.toFixed(4),
        z: +this.dashThrowDir.z.toFixed(4),
      },
      yawDeg: +(Math.atan2(this.dashThrowDir.x, this.dashThrowDir.z) * 180 / Math.PI).toFixed(2),
      /** Direction of travel, for the comparison the claim is actually about. */
      travelYawDeg: +(Math.atan2(v.x, v.z) * 180 / Math.PI).toFixed(2),
      travelPitchDeg: +(Math.asin(
        Math.max(-1, Math.min(1, v.y / Math.max(1e-3, Math.hypot(v.x, v.y, v.z)))),
      ) * 180 / Math.PI).toFixed(2),
    };
  }

  /**
   * AMBIENT-ONLY mode — the title-screen backdrop (src/ui/MenuBackdrop.ts).
   *
   * The backdrop keeps the world simulating behind the main menu, and it wants
   * exactly two things out of this system: the hero POSED (so he breathes and
   * shifts his weight instead of standing there as a mannequin) and the lights
   * that travel with him. Everything else here belongs to a live RUN — the
   * speed streaks, the wind synth, the control-teaching strip, the web strands —
   * and running any of it on a menu is either noise or, in the strip's case, an
   * actual regression: it would spend its whole lifetime retiring off screen.
   *
   * This is a VIEW switch only. It changes nothing the rig or gameplay reads.
   */
  setAmbientOnly(on: boolean): void {
    if (this.ambientOnly === on) return;
    this.ambientOnly = on;
    this.prompt.setSuspended(on);
    this.dashHud.setSuspended(on);
    // The overlay is speed-driven and the menu hero stands still, so it is
    // already at zero; simply not ticking it is enough.
  }

  update(ctx: UpdateContext): void {
    const p = this.player;
    const dt = ctx.dt;
    inputHandle.player = p;

    // The debug trigger and the real one-shot are the same event downstream.
    const groundPull = p.justGroundPull || this.pullRequest;
    this.pullRequest = false;

    if (!this.debugApiAttached) this.syncFxDebugApi();
    this.rig.update(this.posedSnapshot(p), dt, groundPull);
    this.updateNavigationLight();
    this.updateStreetSkimLight(p);
    if (this.ambientOnly) return;

    this.overlay.update(p, dt);
    this.audio.update(p, dt);
    this.prompt.update(dt);
    this.dashHud.update(p, dt);
    this.updateRefusedCue(p, dt);

    this.updateWeb(p, dt);
    this.updatePullWebs(p, dt, groundPull);
    this.updateDashThrow(p);
    this.updateGlint(dt);
  }

  /**
   * A deliberate web press that found no anchor used to do nothing at all, which
   * is indistinguishable from a dropped input — the player clicks again, and
   * again. This is the smallest honest answer: the crosshair drops in value for
   * a beat and comes back.
   *
   * Deliberately NOT a flash, a bloom, a scale pop or a colour: a refusal is not
   * an event worth decorating, it is a "heard you, nothing there".
   */
  private updateRefusedCue(p: PlayerSnapshot, dt: number): void {
    if (!this.crosshairLookedUp) {
      this.crosshair = document.getElementById('crosshair');
      this.crosshairLookedUp = true;
    }
    const el = this.crosshair;
    if (!el) return;
    if (p.webRefused) this.refusedDim = REFUSED_DIM_TIME;
    if (this.refusedDim <= 0) return;
    this.refusedDim = Math.max(0, this.refusedDim - dt);
    const k = this.refusedDim / REFUSED_DIM_TIME;
    // 0.7 is the resting opacity set in index.html; ease back up to it.
    el.style.opacity = (0.7 - 0.48 * k).toFixed(3);
    if (this.refusedDim <= 0) el.style.opacity = '';
  }

  /** The snapshot the rig poses from — the live one unless a critic pinned a state. */
  private posedSnapshot(p: PlayerSnapshot): PlayerSnapshot {
    if (!this.poseOverride) return p;
    const snap = this.overrideSnap ??= { ...p };
    Object.assign(snap, p);
    snap.state = this.poseOverride;
    return snap;
  }

  private updateNavigationLight(): void {
    const cam = cameraHandle.camera;
    if (!cam) {
      this.navLight.visible = false;
      return;
    }
    const fog = this.scene.fog as THREE.Fog | null;
    const c = fog?.color;
    const lum = c ? 0.299 * c.r + 0.587 * c.g + 0.114 * c.b : 1;
    const night = THREE.MathUtils.clamp((0.62 - lum) / 0.42, 0, 1);
    this.navLight.visible = night > 0.02;
    this.navLight.intensity = T.navigationLightIntensity * night;
    this.nightFill.visible = night > 0.02;
    this.nightFill.intensity = T.nightFillIntensity * night;
    this.camForward.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.navLight.position.copy(cam.position).addScaledVector(this.camForward, 3);
  }

  private updateStreetSkimLight(p: PlayerSnapshot): void {
    const low = THREE.MathUtils.clamp((16 - p.altitude) / 16, 0, 1);
    const fast = THREE.MathUtils.clamp((p.speed - 35) / 45, 0, 1);
    const k = low * fast;
    const planar = Math.hypot(p.velocity.x, p.velocity.z);
    const leadX = planar > 0.1 ? (p.velocity.x / planar) * 18 : 0;
    const leadZ = planar > 0.1 ? (p.velocity.z / planar) * 18 : 0;
    this.streetSkimLight.visible = k > 0.02;
    this.streetSkimLight.intensity = T.streetSkimLightIntensity * k;
    this.streetSkimLight.position.set(p.position.x + leadX, p.position.y + 8, p.position.z + leadZ);
    if (!T.streetSkimPool) return;
    this.streetSkimPool.visible = k > 0.02;
    this.streetSkimPoolMat.opacity = T.streetSkimPoolOpacity * k;
    this.streetSkimPool.position.set(
      p.position.x + leadX * 0.7,
      p.position.y - p.altitude + 0.08,
      p.position.z + leadZ * 0.7,
    );
    const yaw = planar > 0.1 ? Math.atan2(p.velocity.x, p.velocity.z) : 0;
    this.streetSkimQuat.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -yaw));
    this.streetSkimPool.quaternion.copy(this.streetSkimQuat);
  }

  private updateWeb(p: PlayerSnapshot, dt: number): void {
    const attached = p.anchorPosition != null && (p.state === 'SWING' || p.state === 'WEB_ATTACH');

    // grip hand world position (base of the web), from whichever rig is active
    this.rig.root.updateMatrixWorld(true);
    const grip = this.rig.gripL ? this.rig.gripHandL : this.rig.gripHandR;
    this.hand.copy(grip.getWorldPosition(new THREE.Vector3()));

    if (p.justAttached && attached) {
      this.webPhase = 'attaching';
      this.webTimer = T.attachAnimTime;
      this.webAnchor.copy(p.anchorPosition!);
      this.glintPos.copy(p.anchorPosition!);
      this.glintTimer = 0.22;
    }

    if (this.webPhase === 'off') {
      if (attached) {
        this.webPhase = 'attaching';
        this.webTimer = T.attachAnimTime;
        this.webAnchor.copy(p.anchorPosition!);
      } else {
        this.web.visible = false;
        return;
      }
    }

    if (this.webPhase === 'attaching') {
      this.webTimer -= dt;
      const t = 1 - Math.max(0, this.webTimer) / T.attachAnimTime;
      // ease-out: the strand shoots taut from hand to anchor
      this.webAnim = 1 - Math.pow(1 - t, 3);
      if (this.webTimer <= 0) {
        this.webPhase = 'attached';
        this.webAnim = 1;
      }
      // follow a live anchor if it moved during the shoot-out
      if (p.anchorPosition) this.webAnchor.copy(p.anchorPosition);
    } else if (this.webPhase === 'attached') {
      if (!attached) {
        this.webPhase = 'snapping';
        this.webTimer = T.snapAnimTime;
        this.glintPos.copy(this.hand);
        this.glintTimer = 0.16;
      } else {
        this.webAnchor.copy(p.anchorPosition!);
        this.webAnim = 1;
      }
    } else if (this.webPhase === 'snapping') {
      this.webTimer -= dt;
      const t = 1 - Math.max(0, this.webTimer) / T.snapAnimTime;
      this.webAnim = 1 - Math.pow(t, 2); // fast collapse toward the hand
      if (this.webTimer <= 0) {
        this.webPhase = 'off';
        this.webAnim = 0;
        this.web.visible = false;
        return;
      }
    }

    if (this.webAnim <= 0.01) {
      this.web.visible = false;
      return;
    }

    // visible endpoint eases hand -> anchor during attach, anchor -> hand on snap
    const end = this.tmp1.copy(this.webAnchor).lerp(this.hand, 1 - this.webAnim);
    const len = this.hand.distanceTo(end);
    if (len < 0.02) {
      this.web.visible = false;
      return;
    }

    this.web.visible = true;
    this.web.position.copy(this.hand);
    this.webDir.copy(end).sub(this.hand).normalize();
    this.webQuat.setFromUnitVectors(this.webUp, this.webDir);
    this.web.quaternion.copy(this.webQuat);
    this.web.scale.set(1, len, 1);
    this.webMat.opacity = 0.75 + 0.25 * this.webAnim;
  }

  private updateGlint(dt: number): void {
    if (this.glintTimer <= 0) {
      this.glint.visible = false;
      return;
    }
    this.glintTimer -= dt;
    const t = this.glintTimer / 0.22;
    this.glint.visible = true;
    this.glint.position.copy(this.glintPos);
    const s = (1 - t) * T.glintScale + 0.4;
    this.glint.scale.set(s, s, s);
    this.glintMat.opacity = t * 0.9;
  }

  /**
   * The two-handed ground pull: both hands throw at once, so there are two
   * strands. They run on the same clock as the pose overlay in poses.ts, and
   * they anchor to a pair of laterally-separated points ahead of and above the
   * player — separated precisely so the move reads as TWO lines in a single
   * frame rather than one thick one.
   */
  private updatePullWebs(p: PlayerSnapshot, dt: number, groundPull: boolean): void {
    if (groundPull) {
      this.pullClock = 0;
      // Prefer a real anchor if traversal supplied one; otherwise place the pair
      // up and ahead along the facing the player is actually being pulled toward.
      const yaw = this.rig.root.rotation.y;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const cx = p.position.x + fx * T.pullWebForward;
      const cz = p.position.z + fz * T.pullWebForward;
      const cy = p.position.y + T.pullWebHeight;
      const half = T.pullWebSpread * 0.5;
      // right-hand perpendicular of (fx, fz) in the XZ plane
      this.pullAnchors[0].set(cx - fz * half, cy, cz + fx * half);
      this.pullAnchors[1].set(cx + fz * half, cy, cz - fx * half);
      if (p.anchorPosition) {
        for (const a of this.pullAnchors) a.y = Math.max(a.y, p.anchorPosition.y);
      }
      this.glintPos.copy(this.pullAnchors[0]);
      this.glintTimer = 0.2;
    } else if (this.pullClock >= 0) {
      this.pullClock += dt;
    }

    if (this.pullClock < 0 || this.pullClock > PULL_TOTAL) {
      this.pullClock = -1;
      for (const m of this.pullWebs) m.visible = false;
      return;
    }

    const shoot = Math.min(1, this.pullClock / T.pullWebShootTime);
    const grow = 1 - Math.pow(1 - shoot, 3);
    const fade = Math.min(1, (PULL_TOTAL - this.pullClock) / 0.14);
    this.pullWebMat.opacity = 0.95 * fade;
    this.rig.root.updateMatrixWorld(true);

    const hands = [this.rig.gripHandL, this.rig.gripHandR];
    for (let i = 0; i < 2; i++) {
      hands[i].getWorldPosition(this.hand);
      const end = this.tmp1.copy(this.pullAnchors[i]).lerp(this.hand, 1 - grow);
      const len = this.hand.distanceTo(end);
      const mesh = this.pullWebs[i];
      if (len < 0.05) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.copy(this.hand);
      this.webDir.copy(end).sub(this.hand).normalize();
      this.webQuat.setFromUnitVectors(this.webUp, this.webDir);
      mesh.quaternion.copy(this.webQuat);
      mesh.scale.set(1, len, 1);
    }
  }

  /**
   * Cosmetic dash web throw: a single strand shooting straight along the dash
   * direction (normalize(velocity) while DASH — not camera forward, because
   * dash steering follows WASD). Timing is driven by stateTime so it fires on
   * every DASH entry without needing a contract one-shot. Does not touch
   * this.web (swing) or the pull strands.
   */
  private updateDashThrow(p: PlayerSnapshot): void {
    if (p.state !== 'DASH' || p.stateTime >= T.dashThrowTotal) {
      this.dashThrow.visible = false;
      return;
    }

    const spd = Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z);
    if (spd < 0.5) {
      this.dashThrow.visible = false;
      return;
    }
    this.dashThrowDir.set(p.velocity.x / spd, p.velocity.y / spd, p.velocity.z / spd);

    const t = p.stateTime;
    let grow: number;
    if (t < T.dashThrowShootTime) {
      const u = t / T.dashThrowShootTime;
      grow = 1 - Math.pow(1 - u, 3);
    } else if (t < T.dashThrowRetractStart) {
      grow = 1;
    } else {
      const span = T.dashThrowTotal - T.dashThrowRetractStart;
      const u = span > 0 ? (t - T.dashThrowRetractStart) / span : 1;
      grow = Math.max(0, 1 - u * u);
    }
    if (grow <= 0.01) {
      this.dashThrow.visible = false;
      return;
    }

    this.rig.root.updateMatrixWorld(true);
    // Right hand is the throw arm in POSES.DASH.
    this.rig.gripHandR.getWorldPosition(this.hand);
    const tip = this.tmp1.copy(this.hand).addScaledVector(this.dashThrowDir, T.dashThrowLength * grow);
    const len = this.hand.distanceTo(tip);
    if (len < 0.05) {
      this.dashThrow.visible = false;
      return;
    }

    this.dashThrow.visible = true;
    this.dashThrow.position.copy(this.hand);
    this.webDir.copy(tip).sub(this.hand).normalize();
    this.webQuat.setFromUnitVectors(this.webUp, this.webDir);
    this.dashThrow.quaternion.copy(this.webQuat);
    this.dashThrow.scale.set(1, len, 1);
    // Fade on retract so the strand disappears with the snap, not as a hard cut.
    const fade = t >= T.dashThrowRetractStart
      ? Math.max(0, grow)
      : 1;
    this.dashThrowMat.opacity = 0.7 + 0.25 * fade;
  }

  dispose(): void {
    this.unsubscribeClassic?.();
    this.figure.dispose();
    this.model?.dispose();
    for (const m of this.pullWebs) { m.removeFromParent(); m.geometry.dispose(); }
    this.pullWebMat.dispose();
    this.dashThrow.removeFromParent();
    this.dashThrow.geometry.dispose();
    this.dashThrowMat.dispose();
    this.overlay.dispose();
    this.audio.dispose();
    this.prompt.dispose();
    this.dashHud.dispose();
    this.navLight.removeFromParent();
    this.nightFill.removeFromParent();
    this.streetSkimLight.removeFromParent();
    this.streetSkimPool.removeFromParent();
    this.web.geometry.dispose();
    this.webMat.dispose();
    this.glint.geometry.dispose();
    this.glintMat.dispose();
    this.streetSkimPool.geometry.dispose();
    this.streetSkimPoolMat.dispose();
  }
}
