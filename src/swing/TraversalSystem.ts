import * as THREE from 'three';
import type {
  Anchor, AnchorQuery, InputSnapshot, PlayerSnapshot, System, TraversalState, UpdateContext,
} from '../contracts';
import { GLOBALS } from '../contracts/globals';
import { SWING_TUNING as T } from './tuning';
import { AnchorPicker } from './anchors';

const UP = new THREE.Vector3(0, 1, 0);

type TraversalDebugApi = Record<string, unknown> & {
  traversalAssistsEnabled?: boolean;
  traversalAssistsOff?: boolean;
  setTraversalAssistsEnabled?: (enabled: boolean) => boolean;
  /** Harness probe: ground-pull anchor availability. See probeGroundPull. */
  probeGroundPull?: (points: GroundPullProbePoint[]) => GroundPullProbeResult[];
  /** Fixed-timestep accounting; see syncTraversalDebugApi. Additive, read-only. */
  traversalDebug?: {
    simTime: number; realTime: number; driftSeconds: number;
    accumulatorSeconds: number; lastSubsteps: number;
    droppedTime: number; droppedSteps: number;
    fixedStep: number; maxSubsteps: number;
    /** Deliberate web presses this run, and how many produced a real rope.
     *  The ratio IS the "clicks that fire nothing" complaint, as a number. */
    webPressAttempts: number; webPressAttached: number;
    /** Seconds left on the dash cooldown, mirrored for headless probes. */
    dashCooldown: number;
  };
};

/** One street position to test a ground web press from. */
export interface GroundPullProbePoint {
  x: number;
  z: number;
  /** Facing, degrees. The ground pull is an aimed move, so this matters. */
  yawDeg: number;
}

/** What a ground web press at that position would do. See probeGroundPull. */
export interface GroundPullProbeResult {
  x: number;
  z: number;
  /** Local surface height — 0 means street, > 0 means we sampled a rooftop. */
  surface: number;
  /** True when a legal anchor exists, i.e. a real attach with a visible rope.
   *  False means the press falls through to the no-anchor recovery. */
  attach: boolean;
  /** Chosen anchor (new gates), when there is one. */
  anchorX: number | null;
  anchorY: number | null;
  anchorZ: number | null;
  lateral: number | null;
  rope: number | null;
  ropeCeiling: number | null;
  /** Best anchor in reach ignoring EVERY height/lateral gate, so a miss can be
   *  read as "nothing tall enough nearby" vs "the gates threw it away". */
  bestAnyY: number | null;
  bestAnyLateral: number | null;
}

/**
 * OWNER: traversal-builder. You own src/swing/ and src/player/.
 *
 * Full traversal loop as a real state machine:
 *   FALLING -> WEB_ATTACH -> SWING -> RELEASE -> AIRBORNE -> WEB_ATTACH (loop)
 * plus DASH (separate targeted impulse) and LANDED (graceful fallback).
 *
 * Design contract (from reference-pack/IMPLEMENTATION_REFERENCE.md):
 *  - GAME FEEL BEATS PHYSICAL ACCURACY. Swings redirect high incoming
 *    velocity, they never wait for a slow pendulum period.
 *  - SWING-001: momentum MUST survive release — release never zeroes velocity.
 *  - SWING-002: while attached the body is constrained to a taut sphere arc.
 *  - SWING-003 is DELIBERATELY SUPERSEDED by docs/SHARED_TARGET.md, which is
 *    lead-owned and overrides per-system rubrics where they conflict. Chasing
 *    "a low nadir near the street" is what produced the measured failure: an
 *    attach at player y=1.60 / anchor y=35.0 / rope=42.26 has a rigid-pendulum
 *    nadir of -7.25 m, so the solver drove the player into the ground clamp and
 *    scraped them along the tarmac, and 42.7% of a run was spent walking. The
 *    arc now lives in the 25-120 m band: the rope is ceilinged so its nadir
 *    cannot fall below T.nadirClearance above the surface, and an anchor that
 *    cannot satisfy that is REFUSED rather than taken as the least-bad option.
 *  - Energy is managed, not merely conserved: a governor holds cruise speed
 *    along the tangent and gravity is reduced on the upswing, so a swing exits
 *    at roughly the speed it entered instead of trading 95% of it for altitude.
 *  - Only talk to the world through the injected AnchorQuery.
 *  - Keep `snapshot` fully populated every frame; camera/FX/HUD read it.
 *  - The player must NEVER be able to reach a state they cannot leave: a
 *    watchdog forces recovery from any sub-0.5 m/s stall.
 */
export class TraversalSystem implements System {
  readonly snapshot: PlayerSnapshot = {
    position: new THREE.Vector3(T.spawnPoint.x, 0, T.spawnPoint.z),
    velocity: new THREE.Vector3(0, 0, 0),
    speed: 0,
    state: 'LANDED',
    stateTime: 0,
    anchorPosition: null,
    ropeLength: 0,
    lean: 0,
    justAttached: false,
    justReleased: false,
    justGroundPull: false,
    altitude: 0,
    webRefused: false,
    dashCooldown: 0,
    dashCooldownTotal: T.dashCooldown,
  };

  /** Effective swing pivot — the anchor may be slid out of the building volume
   *  so the taut arc stays over the street (see resolvePivot). */
  private pivot = new THREE.Vector3();
  private anchor: Anchor | null = null;
  private ropeLength = 0;
  /** Longest rope whose rigid-pendulum nadir (pivot.y - rope) still clears
   *  T.nadirClearance above the surface. The rope is reeled down to this;
   *  it can never be exceeded, so a sub-street nadir is not representable. */
  private ropeCeiling = Infinity;
  /** Highest surface under the current + look-ahead path; see hazardSurface. */
  private hazardY = 0;
  private reattachLock = 0;
  private rescueCooldown = 0;
  private facadeContactActive = false;
  private yaw = 0;
  private picker: AnchorPicker;

  private attachTimer = 0;
  private releaseTimer = 0;
  private dashTimer = 0;
  /** Seconds left before the dash may fire again; mirrored onto the snapshot
   *  for the HUD. Counted from activation, so it is already running during the
   *  dash itself. */
  private dashCooldownTimer = 0;
  private dashDir = new THREE.Vector3();
  private attachQueryTimer = 0;
  private lean = 0;
  private stuckTime = 0;
  private traversalAssistsEnabled = true;
  private swingHasDescended = false;
  private swingCrossedNadir = false;
  private swingPeakPlanar = 0;
  /** True while a player-initiated ground web-pull is still winching the long
   *  street rope down to a legal nadir ceiling. Drives the faster reel rate. */
  /** True while an AIMED (player-pressed) swing is still winching its shot down
   *  to the legal ceiling. Same idea as groundPullReeling, its own rate. */
  /** Deliberate presses seen, and presses that ended in a rope. Diagnostic
   *  only — never read by gameplay. Exposed on __GAUNTLET__.traversalDebug so
   *  "many clicks fire nothing" can be measured instead of argued about. */
  private webPressAttempts = 0;
  private webPressAttached = 0;
  /** One-shot within a frame: `input.swingPressed` stays true for every substep
   *  of that frame, so without this a single click would be counted (and the
   *  aimed query run) up to MAX_SUBSTEPS times. */
  private pressPendingAim = false;
  /** Aim direction for a press. Its own vector rather than the t1..t4 scratch:
   *  the picker holds this across a raycast plus a seven-step sweep, and t3 is
   *  reused by horizForward() inside that window. */
  private readonly aimDir = new THREE.Vector3();
  private pressReeling = false;
  /** True for the whole life of a swing that started as an aimed press, so its
   *  rope floor stays pressMinRope rather than the automatic minRope. */
  private pressSwing = false;
  private groundPullReeling = false;
  /** True for the whole life of a swing that STARTED as a ground pull. Such a
   *  swing hangs off a deliberately lower anchor, so it uses the ground-pull
   *  rope floor and nadir clearance instead of the airborne ones. Without this
   *  the `Math.max(T.minRope, ...)` floor in updateRopeCeiling would force an
   *  18 m rope onto a 13 m anchor and put the nadir 5 m UNDER the road. */
  private groundPullSwing = false;
  /** Rate limit for the LANDED ground-pull anchor query, so holding the web
   *  button while standing somewhere with no anchor does not re-run seven
   *  city queries every frame. */
  private groundPullQueryTimer = 0;
  private wallRunPlaneOffset = 0;
  private wallRunUpBlend = 0;
  private wallRunLostTime = 0;

  private readonly setTraversalAssistsEnabled = (enabled: boolean): boolean => {
    this.traversalAssistsEnabled = enabled;
    this.syncTraversalDebugApi();
    return this.traversalAssistsEnabled;
  };

  // --- fixed-timestep driver state ------------------------------------------
  /**
   * Ceiling on substeps per frame. `GLOBALS.maxDeltaSeconds` (50 ms) is the
   * primary spiral-of-death guard and it is applied upstream in Game.loop, so
   * 6 substeps (= 50 ms of simulation) is exactly enough to consume a fully
   * clamped frame plus its carried remainder. In normal play this clamp NEVER
   * bites; it exists so a caller that hands us an unclamped dt still cannot
   * queue unbounded physics.
   */
  private static readonly MAX_SUBSTEPS = 6;
  /** Leftover simulated time carried to the next frame. */
  private stepAccumulator = 0;
  /** Simulated seconds actually stepped (sum of substeps x fixedStep). */
  private simTime = 0;
  /** Real (clamped) seconds handed to update(). simTime tracks this. */
  private realTime = 0;
  /** Substeps run on the most recent frame. */
  private lastSubsteps = 0;
  /** Simulated time deliberately discarded by the MAX_SUBSTEPS clamp. */
  private droppedTime = 0;
  private droppedSteps = 0;

  // Scratch vectors — no allocation inside the fixed-step loop.
  private readonly t1 = new THREE.Vector3();
  private readonly t2 = new THREE.Vector3();
  private readonly t3 = new THREE.Vector3();
  private readonly t4 = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private readonly facadeContactNormal = new THREE.Vector3();
  private readonly wallRunNormal = new THREE.Vector3();
  private readonly wallRunDir = new THREE.Vector3();

  constructor(private world: AnchorQuery, private input: InputSnapshot) {
    this.picker = new AnchorPicker(world);
    this.spawn();
  }

  /** Camera yaw is authoritative for aim; the camera system writes it here. */
  setAimYaw(y: number) { this.yaw = y; }

  // -------------------------------------------------------------------------
  // Frame driver
  // -------------------------------------------------------------------------
  update(ctx: UpdateContext): void {
    const s = this.snapshot;
    this.syncTraversalDebugApi();
    s.justAttached = false;
    s.justReleased = false;
    s.justGroundPull = false;
    s.webRefused = false;

    // Immediate press beats the cooldown.
    if (this.input.swingPressed) {
      this.attachQueryTimer = 0;
      this.pressPendingAim = true;
    }

    // --- fixed-timestep accumulator ------------------------------------------
    //
    // This used to be `clamp(Math.round(dt / step), 1, 4)` with NO accumulator:
    // the leftover fraction of a substep was silently discarded or invented every
    // single frame, so simulated time was a rounded function of wall-clock jitter
    // (dt = 20.0 ms simulated 16.7 ms; dt = 21.0 ms simulated 25.0 ms). Two runs
    // never see the same dt sequence, so trajectories diverged for reasons that
    // had nothing to do with the game — and the simulation SPEED itself jittered
    // by up to half a substep per frame. Measured on a 120 Hz display: mean
    // |simulated - real| of 0.30 ms per frame, worst frame 7.03 ms.
    //
    // Now the remainder is carried across frames, so simulated time tracks real
    // time to within one substep (8.33 ms) at all times and to zero net drift
    // over a run.
    const step = GLOBALS.fixedStep;
    this.stepAccumulator += ctx.dt;
    let steps = Math.floor(this.stepAccumulator / step);
    if (steps > TraversalSystem.MAX_SUBSTEPS) {
      // SPIRAL-OF-DEATH GUARD. We deliberately THROW AWAY simulated time here
      // rather than let a slow frame queue more physics than the next frame can
      // afford. The game runs in slow motion for that frame; it does not
      // deadlock. This is a real, intentional loss of simulated time — it is
      // counted in `droppedTime` and published on `__GAUNTLET__.traversalDebug`
      // so a critic can see exactly how much time the clamp ate instead of
      // discovering it as unexplained drift.
      this.droppedTime += (steps - TraversalSystem.MAX_SUBSTEPS) * step;
      this.droppedSteps += steps - TraversalSystem.MAX_SUBSTEPS;
      steps = TraversalSystem.MAX_SUBSTEPS;
      this.stepAccumulator = 0;
    } else {
      this.stepAccumulator -= steps * step;
    }
    this.lastSubsteps = steps;
    this.realTime += ctx.dt;
    this.simTime += steps * step;
    for (let guard = 0; guard < steps; guard++) {
      this.step(step);
    }

    s.dashCooldown = this.dashCooldownTimer;
    s.speed = Math.hypot(s.velocity.x, s.velocity.z);
    s.altitude = Math.max(0, s.position.y - this.world.surfaceHeightAt(s.position.x, s.position.z));
    s.anchorPosition = this.anchor ? this.pivot : null;
    s.ropeLength = this.anchor ? this.ropeLength : 0;
    this.updateLean(ctx.dt);
    s.lean = this.lean;
  }

  private setState(st: TraversalState) {
    if (this.snapshot.state !== st) {
      this.snapshot.state = st;
      this.snapshot.stateTime = 0;
    }
  }

  private step(dt: number) {
    const s = this.snapshot;
    const stateAtStart = s.state;
    this.prevPos.copy(s.position);
    this.updateFacadeContactExit();

    // Ticked here, in the fixed step, rather than in update(): the cooldown is
    // a gameplay budget and must advance on SIMULATED time like everything else,
    // so a replay and a live run count it down identically.
    if (this.dashCooldownTimer > 0) {
      this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - dt);
    }

    // Dash interrupts everything except itself — while it is off cooldown.
    // A press during the cooldown is DROPPED, never queued: the input layer
    // buffers a press for a few frames so a slightly early tap still counts,
    // and queueing it here would turn that buffer into "the dash fires by
    // itself the instant the cooldown expires", which is not what the player
    // asked for.
    if (this.input.dashPressed && s.state !== 'DASH' && this.dashCooldownTimer <= 0) {
      this.startDash();
      return;
    }

    switch (s.state) {
      case 'FALLING':
      case 'AIRBORNE': this.stepAir(dt); break;
      case 'WEB_ATTACH': this.stepAttach(dt); break;
      case 'SWING': this.stepSwing(dt); break;
      case 'RELEASE': this.stepRelease(dt); break;
      case 'DASH': this.stepDash(dt); break;
      case 'WALL_RUN': this.stepWallRun(dt); break;
      case 'LANDED': this.stepLanded(dt); break;
      default: break;
    }

    // Un-stick watchdog: no state except LANDED/PERCH/IDLE/SWING may persist at
    // |v| < threshold. SWING is excluded — a pendulum legitimately slows to a
    // stop at its apex for a moment before swinging back. If the player is
    // ever welded to a facade in any other state, force a recovery instead of
    // leaving them frozen for the rest of the run.
    if (s.state !== 'LANDED' && s.state !== 'PERCH' && s.state !== 'IDLE' && s.state !== 'SWING') {
      const vlen = s.velocity.length();
      if (vlen < T.unstickSpeed) this.stuckTime += dt;
      else this.stuckTime = 0;
      if (this.stuckTime > T.unstickTimeout) {
        this.unstick();
      }
    } else {
      this.stuckTime = 0;
    }

    if (s.state === stateAtStart) s.stateTime += dt;
  }

  // -------------------------------------------------------------------------
  // Airborne (FALLING and AIRBORNE share physics; states stay distinct so the
  // machine is readable: FALLING = pre-first-attach, AIRBORNE = post-release)
  // -------------------------------------------------------------------------
  private stepAir(dt: number) {
    const s = this.snapshot;
    const i = this.input;

    s.velocity.y += GLOBALS.gravity * T.gravityScale * dt;

    const drag = i.dive ? T.diveDrag : T.airDrag;
    if (i.dive) {
      // Tuck: trade height for speed.
      s.velocity.y -= T.diveAccel * dt;
      const fwd = this.horizForward();
      s.velocity.addScaledVector(fwd, T.airAccel * 0.8 * this.airAccelFalloff() * dt);
    }

    // Air control fades as planar speed approaches the cap, so airborne
    // speed can't climb without bound.
    const falloff = this.airAccelFalloff();
    const fwd = this.horizForward();
    const right = this.rightOf(fwd);
    s.velocity.addScaledVector(fwd, i.moveY * T.airAccel * falloff * dt);
    // Lateral air control carries the turn, so it gets its own boost: the player
    // rotates their line 50% faster in the air while W thrust is unchanged.
    s.velocity.addScaledVector(right, i.moveX * T.airAccel * T.airTurnBoost * falloff * dt);
    s.velocity.multiplyScalar(Math.max(0, 1 - drag * dt));

    // Airborne half of the speed governor. Acts along the direction of TRAVEL
    // (not camera aim, which may point anywhere), so a swing that exited slow
    // is back at cruise before the next grab instead of arriving low and slow.
    const planar = Math.hypot(s.velocity.x, s.velocity.z);
    if (this.traversalAssistsEnabled && planar < T.cruiseSpeed && i.swing) {
      this.t1.set(s.velocity.x, 0, s.velocity.z);
      if (this.t1.lengthSq() < 1e-4) this.t1.copy(this.horizForward());
      this.t1.normalize();
      const g = Math.min(T.airGovernorAccel, (T.cruiseSpeed - planar) * T.governorGain);
      s.velocity.addScaledVector(this.t1, g * dt);
    }

    this.integrate(dt);
    this.resolveCollision();

    if (this.traversalAssistsEnabled) this.applyCeilingPull(dt);
    // Roof clearance on the ballistic leg. The player is airborne for most of a
    // run; without this the arc between two swings clips tower roofs (measured:
    // frames at 0.0-2.0 m above a rooftop), which is both a collision and an
    // out-of-band altitude. Same shape as the swing's repulsion: a bounded
    // force with a look-ahead, only while the player is actually web-traversing
    // — an unwebbed fall still lands normally.
    if (this.traversalAssistsEnabled && i.swing) this.applyAirClearance(dt);
    if (this.reattachLock > 0) this.reattachLock -= dt;
    if (this.rescueCooldown > 0) this.rescueCooldown -= dt;
    if (this.tryAutoAttach(dt)) return;

    const surf = this.world.surfaceHeightAt(s.position.x, s.position.z);

    // Recovery move. The attach gates are now allowed to REFUSE every anchor
    // (that is the whole point — the alternative is the sub-street nadir that
    // started the vicious cycle). So the player needs a way out that is not
    // "fall to the street and walk": a short emergency web-line lift that puts
    // them back in the band with a rate limit so it can never become a hover.
    if (
      s.velocity.y < 0
      && s.position.y - surf < T.rescueAltitude
      && this.rescueCooldown <= 0
      && i.swing
      && this.traversalAssistsEnabled
    ) {
      s.velocity.y = Math.max(0, s.velocity.y) + T.rescueLiftUp;
      this.rescueCooldown = T.rescueCooldown;
      return;
    }

    // Graceful landing.
    if (s.position.y <= surf + T.standHeight && s.velocity.y <= 0) {
      s.position.y = surf + T.standHeight;
      s.velocity.y = 0;
      s.velocity.x *= T.landDamp;
      s.velocity.z *= T.landDamp;
      this.wallRunExits.landed++;
      this.setState('LANDED');
    }
  }

  // -------------------------------------------------------------------------
  // WEB_ATTACH: the "line goes taut" beat. Constraint is live immediately.
  // -------------------------------------------------------------------------
  private stepAttach(dt: number) {
    const s = this.snapshot;
    this.attachTimer -= dt;

    s.velocity.y += GLOBALS.gravity * T.gravityScale * dt;
    this.updateRope(dt);
    this.applySwingSteering(dt, 0.35);
    this.integrate(dt);
    this.solveConstraint();
    this.resolveCollision();
    this.applyGroundRepulsion(dt);
    if (this.traversalAssistsEnabled) this.applyCeilingPull(dt);
    this.updateSwingReleasePhase();

    if (this.input.swingReleased) { this.release(true); return; }
    if (this.attachTimer <= 0) this.setState('SWING');
  }

  // -------------------------------------------------------------------------
  // SWING: constrained pendulum under a taut web.
  // -------------------------------------------------------------------------
  private stepSwing(dt: number) {
    const s = this.snapshot;

    if (this.input.swingReleased) { this.release(true); return; }
    if (this.input.jumpPressed) { this.apexLaunch(); return; }

    // ENERGY MANAGEMENT, part 1: full gravity on the downswing (that is where
    // the speed comes from), reduced gravity while rising, so the arc does not
    // pay for its altitude entirely out of forward velocity.
    const gScale = s.velocity.y < 0 ? 1 : T.upswingGravity;
    s.velocity.y += GLOBALS.gravity * T.gravityScale * gScale * dt;

    // NADIR RULE + pump, in one winch: the rope is reeled toward the ceiling
    // that keeps the nadir above the street, and further while pumping.
    this.updateRope(dt);

    this.applySwingSteering(dt, 1);
    this.integrate(dt);
    this.solveConstraint();
    this.resolveCollision();
    this.applyGroundRepulsion(dt);
    if (this.traversalAssistsEnabled) this.applyCeilingPull(dt);
    this.updateSwingReleasePhase();

    // PLAYER AUTHORITY OVER THE WEB.
    // While the swing input is held the web NEVER lets go on its own. It does not
    // auto-release at the optimal exit angle and it does not time out, because a
    // strand that detaches and re-attaches under a held button takes the arc away
    // from the player. Holding = attached; releasing the button = the only way to
    // let go (plus the explicit apex launch on jump).
    //
    // The old bounded-swing guard below still exists for the case where the input
    // is NOT held — a web fired by the beginner assist or a buffered press — so a
    // player who never presses anything still cannot dead-hang.
    if (!this.input.swing) {
      if (s.stateTime > T.maxSwingTime) {
        if (Math.hypot(s.velocity.x, s.velocity.z) < T.cruiseSpeed * 0.5) this.apexLaunch();
        else this.release(true);
        return;
      }
      if (this.shouldAutoRelease()) this.release(true);
    }
  }

  /**
   * Highest surface the swing has to clear: under the player now, and under the
   * next lookAhead metres of travel. Rooftops count — the shared bar measures
   * altitude above "the surface below", so an arc that clears the street but
   * skims a tower roof is both out of band and about to collide.
   */
  private hazardSurface(): number {
    const s = this.snapshot;
    let h = this.world.surfaceHeightAt(s.position.x, s.position.z);
    const sp = Math.hypot(s.velocity.x, s.velocity.z);
    if (sp > 1) {
      const nx = s.velocity.x / sp;
      const nz = s.velocity.z / sp;
      for (let d = T.lookAheadStep; d <= T.lookAhead; d += T.lookAheadStep) {
        const hh = this.world.surfaceHeightAt(s.position.x + nx * d, s.position.z + nz * d);
        if (hh > h) h = hh;
      }
    }
    return h;
  }

  /** Longest rope whose nadir still clears the surface, for the current pivot. */
  /** Shortest rope this swing may be reeled to. See groundPullSwing. */
  private get minRopeNow(): number {
    if (this.groundPullSwing) return T.groundPullMinRope;
    if (this.pressSwing) return T.pressMinRope;
    return T.minRope;
  }

  /** Longest rope this swing may hold. An aimed shot is allowed to reach further
   *  than the automatic query does (pressWebRange), and updateRope clamps to
   *  this EVERY step — so without the press case a long aimed rope would be
   *  snapped back to maxWebDistance on the first frame, which is a teleport
   *  toward the anchor by any other name. */
  private get maxRopeNow(): number {
    return this.pressSwing ? T.pressWebRange : T.maxWebDistance;
  }

  /** Headroom the nadir of this swing must keep over the hazard surface. */
  private get nadirClearanceNow(): number {
    return this.groundPullSwing ? T.groundPullNadirClearance : T.nadirClearance;
  }

  private updateRopeCeiling() {
    this.hazardY = this.hazardSurface();
    this.ropeCeiling = Math.max(
      this.minRopeNow,
      this.pivot.y - (this.hazardY + this.nadirClearanceNow),
    );
  }

  /**
   * Winch the rope toward its target at a bounded rate. Two inputs:
   *  - the nadir ceiling (hard: the arc must not bottom out below the street),
   *  - forward input (soft: pumping shortens the rope, which adds energy).
   * Rate-limited, so this is a reel, not a snap — the player is never moved.
   */
  private updateRope(dt: number) {
    this.updateRopeCeiling();
    let target = this.ropeLength;
    const pump = Math.max(0, this.input.moveY);
    if (pump > 0) target *= 1 - T.ropePump * pump * dt;
    if (target > this.ropeCeiling) target = this.ropeCeiling;
    if (target < this.ropeLength) {
      const rate = this.groundPullReeling
        ? T.groundPullReelRate
        : this.pressReeling ? T.pressReelRate : T.reelInRate;
      this.ropeLength = Math.max(target, this.ropeLength - rate * dt);
    }
    this.ropeLength = THREE.MathUtils.clamp(this.ropeLength, this.minRopeNow, this.maxRopeNow);
    if (this.ropeLength <= this.ropeCeiling + 0.05) {
      this.groundPullReeling = false;
      this.pressReeling = false;
    }
  }

  /**
   * Soft ground repulsion. NOT the old positional floor clamp, which pasted the
   * player onto a straight horizontal line at surface + 0.8 m for 39-49% of all
   * swing frames. This is an acceleration blended in below softFloor, so the
   * nadir still emerges from rope length and entry speed; it only exists to
   * catch the case where the surface rises under a swing already in flight.
   */
  private applyGroundRepulsion(dt: number) {
    const s = this.snapshot;
    const alt = s.position.y - this.hazardY;
    if (alt >= T.softFloor) return;
    const k = 1 - Math.max(0, alt) / T.softFloor;
    s.velocity.y += T.groundRepel * k * k * dt;
  }

  /**
   * Roof clearance on the ballistic leg. Bounded as a CLIMB RATE, not an
   * acceleration: clearing a tall roof lifts the player just enough to pass
   * over it and cannot bank energy that would throw them above the band once
   * the obstacle is behind them.
   */
  private applyAirClearance(dt: number) {
    const s = this.snapshot;
    const alt = s.position.y - this.hazardSurface();
    if (alt >= T.airFloor) return;
    const target = T.airFloorLift * (1 - Math.max(0, alt) / T.airFloor);
    if (s.velocity.y < target) {
      s.velocity.y = Math.min(target, s.velocity.y + T.airFloorAccel * dt);
    }
  }

  /** Mirror of the ground repulsion at the top of the band: above the skyline
   *  there is nothing to grab and no corridor to read, so pull back down. */
  private applyCeilingPull(dt: number) {
    const s = this.snapshot;
    const alt = s.position.y - this.world.surfaceHeightAt(s.position.x, s.position.z);
    if (alt <= T.ceilingAltitude) return;
    const k = Math.min(1, (alt - T.ceilingAltitude) / T.ceilingRamp);
    s.velocity.y -= T.ceilingPull * k * dt;
  }

  /**
   * Auto-release for a HELD web — the core of the chain. A held web with no
   * release rule is a single 60-second pendulum (measured on this build before
   * the change: 1 attach, then 90% of the run in one SWING). Release is driven
   * by arc phase: the swing must descend, cross its nadir, and still be close
   * to the best planar speed the arc produced before it exits on the climb.
   */
  private shouldAutoRelease(): boolean {
    const s = this.snapshot;
    // Callers must already have established that the swing input is NOT held —
    // a held web is the player's to release. See stepSwing().
    if (this.input.swing) return false;
    if (!this.swingCrossedNadir) return false;
    if (s.velocity.y <= T.releaseRiseSpeed) return false;
    const planar = Math.hypot(s.velocity.x, s.velocity.z);
    if (this.swingPeakPlanar > 1 && planar < this.swingPeakPlanar * T.releasePeakRatio) return false;
    this.t1.subVectors(s.position, this.pivot);
    const d = this.t1.length();
    if (d < 1e-4) return false;
    // Angle of the rope from straight-down.
    const ang = Math.acos(THREE.MathUtils.clamp(-this.t1.y / d, -1, 1));
    return ang >= T.autoReleaseAngle;
  }

  private updateSwingReleasePhase() {
    const s = this.snapshot;
    const planar = Math.hypot(s.velocity.x, s.velocity.z);
    if (planar > this.swingPeakPlanar) this.swingPeakPlanar = planar;
    if (s.velocity.y < -T.releaseDescendSpeed) this.swingHasDescended = true;
    if (this.swingHasDescended && s.velocity.y > T.releaseRiseSpeed) this.swingCrossedNadir = true;
  }

  /** Steering around the anchor: tangent pump + lateral plane change. */
  private applySwingSteering(dt: number, gain: number) {
    const s = this.snapshot;
    const i = this.input;

    // Rope direction (anchor -> player), for the tangent plane.
    this.t1.subVectors(s.position, this.pivot);
    if (this.t1.lengthSq() < 1e-6) {
      this.t1.copy(this.horizForward());
    }
    this.t1.normalize();

    // Tangent = velocity perpendicular to the rope.
    this.t2.copy(s.velocity).addScaledVector(this.t1, -s.velocity.dot(this.t1));
    const tLen = this.t2.length();
    if (tLen > 1e-3) this.t2.multiplyScalar(1 / tLen);
    else this.t2.copy(this.horizForward());

    // ENERGY MANAGEMENT, part 2: the speed governor. A free pendulum bleeds
    // its tangential energy into altitude and drag and settles into a stall
    // (measured: 42.8 -> 2.2 m/s across one upswing). Feeding back the deficit
    // below cruise along the tangent turns the arc into a stable limit cycle,
    // so the player exits a swing at roughly the speed they entered it.
    const planar = Math.hypot(s.velocity.x, s.velocity.z);
    const deficit = T.cruiseSpeed - planar;
    if (deficit > 0) {
      const a = Math.min(T.governorAccel, deficit * T.governorGain) * gain;
      s.velocity.addScaledVector(this.t2, a * dt);
    }
    // Forward pump along the tangent.
    s.velocity.addScaledVector(this.t2, i.moveY * T.tangentialAccel * gain * dt);
    // Gentle tangential drag so long swings decay instead of running away.
    const vTan = s.velocity.dot(this.t2);
    s.velocity.addScaledVector(this.t2, -vTan * T.swingDrag * dt);

    // Lateral: horizontal, perpendicular to current heading -> carves the plane.
    this.t3.copy(s.velocity);
    this.t3.y = 0;
    if (this.t3.lengthSq() < 1e-4) this.t3.copy(this.horizForward());
    this.t3.normalize();
    this.t4.crossVectors(this.t3, UP).normalize();
    s.velocity.addScaledVector(this.t4, i.moveX * T.lateralAccel * gain * dt);
  }

  /** Taut sphere constraint: project back onto the rope sphere and kill the
   *  outward radial velocity (preserves tangential momentum, no jitter). */
  private solveConstraint() {
    const s = this.snapshot;
    this.t1.subVectors(s.position, this.pivot);
    const dist = this.t1.length();
    if (dist < 1e-6) return;
    this.t1.multiplyScalar(1 / dist);

    if (dist > this.ropeLength) {
      const prePlanar = Math.hypot(s.velocity.x, s.velocity.z);
      const preX = s.velocity.x;
      const preZ = s.velocity.z;
      // Don't force the player into building volume — if the taut point is
      // solid, leave the rope slack instead of fighting the collision.
      this.t2.copy(this.pivot).addScaledVector(this.t1, this.ropeLength);
      if (!this.world.isSolidAt(this.t2)) {
        s.position.copy(this.t2);
      }
      const vrad = s.velocity.dot(this.t1);
      if (vrad > 0) s.velocity.addScaledVector(this.t1, -vrad);
      const afterPlanar = Math.hypot(s.velocity.x, s.velocity.z);
      const minPlanar = Math.max(
        prePlanar * T.facadeMinPlanarKeep,
        prePlanar - T.facadeMaxPlanarLoss,
      );
      if (prePlanar > 1 && afterPlanar < minPlanar) {
        this.t2.set(preX, 0, preZ);
        this.t2.addScaledVector(this.t1, -this.t2.dot(this.t1));
        if (this.t2.lengthSq() < 1e-4) this.t2.set(preX, 0, preZ);
        if (this.t2.lengthSq() > 1e-4) {
          this.t2.normalize();
          const add = minPlanar - afterPlanar;
          s.velocity.addScaledVector(this.t2, add);
          const vrad2 = s.velocity.dot(this.t1);
          if (vrad2 > 0) s.velocity.addScaledVector(this.t1, -vrad2);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // RELEASE: momentum preserved, brief readable beat, then AIRBORNE.
  // -------------------------------------------------------------------------
  private stepRelease(dt: number) {
    const s = this.snapshot;
    this.releaseTimer -= dt;

    s.velocity.y += GLOBALS.gravity * T.gravityScale * dt;
    const falloff = this.airAccelFalloff();
    const fwd = this.horizForward();
    const right = this.rightOf(fwd);
    s.velocity.addScaledVector(fwd, this.input.moveY * T.airAccel * 0.5 * falloff * dt);
    s.velocity.addScaledVector(right, this.input.moveX * T.airAccel * 0.5 * falloff * dt);
    s.velocity.multiplyScalar(Math.max(0, 1 - T.airDrag * dt));

    this.integrate(dt);
    this.resolveCollision();

    if (this.releaseTimer <= 0) {
      this.setState('AIRBORNE');
    }
  }

  // -------------------------------------------------------------------------
  // WALL_RUN: convert airborne facade contact into usable vertical/lateral motion.
  // -------------------------------------------------------------------------
  private stepWallRun(dt: number) {
    const s = this.snapshot;
    const i = this.input;

    if (i.jumpPressed) {
      this.wallRunExits.jump++;
      this.wallRunJump();
      return;
    }
    if (i.swing || i.swingPressed) {
      if (this.tryAutoAttach(dt)) return;
    }

    this.t1.copy(s.position).addScaledVector(this.wallRunNormal, -T.wallRunContactProbe);
    if (!this.world.isSolidAt(this.t1) || s.stateTime > T.wallRunMaxTime) {
      this.exitWallRun(false);
      return;
    }

    // Keep the body on the contact plane, then drive along the direction
    // chosen at entry: head-on hits bias upward, glancing hits bias lateral.
    const drift = s.position.dot(this.wallRunNormal) - this.wallRunPlaneOffset;
    s.position.addScaledVector(this.wallRunNormal, -drift);
    this.prevPos.copy(s.position);

    const normalSpeed = s.velocity.dot(this.wallRunNormal);
    s.velocity.addScaledVector(this.wallRunNormal, -normalSpeed);
    s.velocity.y += GLOBALS.gravity * T.gravityScale * T.wallRunGravityScale * dt;
    s.velocity.addScaledVector(
      this.wallRunDir,
      (T.wallRunAccel + Math.max(0, i.moveY) * T.wallRunInputAccel) * dt,
    );

    this.t2.copy(this.wallRunDir);
    this.t2.y = 0;
    if (this.t2.lengthSq() < 1e-4) this.t2.set(-this.wallRunNormal.z, 0, this.wallRunNormal.x);
    this.t2.normalize();
    s.velocity.addScaledVector(this.t2, i.moveX * T.wallRunLateralAccel * dt);
    s.velocity.multiplyScalar(Math.max(0, 1 - T.wallRunDrag * dt));

    const sp = s.velocity.length();
    if (sp > T.wallRunMaxSpeed) s.velocity.multiplyScalar(T.wallRunMaxSpeed / sp);
    if (sp < T.wallRunExitSpeed && s.stateTime > 0.18) {
      this.wallRunExits.slow++;
      this.exitWallRun(true);
      return;
    }

    this.integrate(dt);
    const postDrift = s.position.dot(this.wallRunNormal) - this.wallRunPlaneOffset;
    s.position.addScaledVector(this.wallRunNormal, -postDrift);

    // CONTACT PERSISTENCE. Measured: 100% of wall runs were ending on a single
    // failed probe, giving 0.06-0.45 s touches instead of runs. Two causes, both
    // real in this city: the facade steps back at a tier/setback, and the pinned
    // plane is captured once at entry so it cannot follow that step.
    //
    // So a miss no longer ends the run immediately. First try to RE-ACQUIRE the
    // surface a little deeper (a setback), and only if that fails too do we
    // start a short coyote window before giving up. The run still ends promptly
    // when the wall genuinely runs out — it just no longer ends on a seam.
    this.t1.copy(s.position).addScaledVector(this.wallRunNormal, -T.wallRunContactProbe);
    if (this.world.isSolidAt(this.t1)) {
      this.wallRunLostTime = 0;
    } else {
      let reacquired = false;
      for (let d = T.wallRunContactProbe * 2; d <= T.wallRunReacquireDepth; d += T.wallRunContactProbe) {
        this.t1.copy(s.position).addScaledVector(this.wallRunNormal, -d);
        if (this.world.isSolidAt(this.t1)) {
          // Follow the surface inward and keep running.
          this.wallRunPlaneOffset -= d - T.wallRunContactProbe;
          s.position.addScaledVector(this.wallRunNormal, -(d - T.wallRunContactProbe));
          this.wallRunLostTime = 0;
          reacquired = true;
          break;
        }
      }
      if (!reacquired) {
        this.wallRunLostTime += dt;
        if (this.wallRunLostTime > T.wallRunCoyoteTime) {
          this.wallRunExits.lostContact++;
          this.exitWallRun(false);
          return;
        }
      }
    }

    if (s.stateTime > T.wallRunMaxTime) {
      this.wallRunExits.timeout++;
      this.exitWallRun(true);
      return;
    }

    const surf = this.world.surfaceHeightAt(s.position.x, s.position.z);
    if (s.position.y <= surf + T.standHeight && s.velocity.y <= 0) {
      s.position.y = surf + T.standHeight;
      s.velocity.y = 0;
      s.velocity.x *= T.landDamp;
      s.velocity.z *= T.landDamp;
      this.setState('LANDED');
    }
  }

  // -------------------------------------------------------------------------
  // DASH: a separate snappy zip along steering (or camera forward), not a
  // pendulum solve. Exit velocity stays on dashDir via dashDecel so the dash
  // actually redirects momentum.
  // -------------------------------------------------------------------------
  private startDash() {
    const s = this.snapshot;
    const i = this.input;
    const fwd = this.horizForward();
    const right = this.rightOf(fwd);

    // Same camera-relative basis as stepAir: W/S → moveY on fwd, A/D → moveX on right.
    const steerMag = Math.hypot(i.moveX, i.moveY);
    const steered = steerMag > 1e-4;
    if (steered) {
      this.t1
        .copy(fwd)
        .multiplyScalar(i.moveY)
        .addScaledVector(right, i.moveX);
      this.t1.y = 0;
      if (this.t1.lengthSq() > 1e-4) this.t1.normalize();
      else this.t1.copy(fwd);
    } else {
      this.t1.copy(fwd);
    }

    // No-input: keep legacy full snap toward any anchor along camera forward.
    // With steering: steering wins outright — no anchor override. A mild on-axis
    // snap was tried and pulled planar aim off the held key by tens of degrees
    // depending on which façade the ray hit; control > zip-assist here.
    if (!steered) {
      const hit = this.world.raycastAnchor(s.position, this.t1, T.dashRange);
      if (hit) {
        this.t2.subVectors(hit.position, s.position);
        if (this.t2.lengthSq() > 1e-4) this.t1.copy(this.t2).normalize();
      }
    } else if (T.dashAnchorSnap > 0) {
      // Optional planar-only assist (off by default via dashAnchorSnap = 0).
      const hit = this.world.raycastAnchor(s.position, this.t1, T.dashRange);
      if (hit) {
        this.t2.subVectors(hit.position, s.position);
        this.t2.y = 0;
        if (this.t2.lengthSq() > 1e-4) {
          this.t2.normalize();
          if (this.t2.dot(this.t1) >= T.dashAnchorAlignMin) {
            this.t1.lerp(this.t2, T.dashAnchorSnap).normalize();
          }
        }
      }
    }

    this.dashDir.copy(this.t1);
    s.velocity.copy(this.dashDir).multiplyScalar(T.dashSpeed);
    this.dashTimer = T.dashTime;
    this.dashCooldownTimer = T.dashCooldown;
    this.detach(false);
    this.clearWallRunContact();
    this.setState('DASH');
  }

  private stepDash(dt: number) {
    const s = this.snapshot;
    this.dashTimer -= dt;

    // Snappy and straight: slight falloff in speed, gravity ignored during zip.
    s.velocity.copy(this.dashDir).multiplyScalar(
      T.dashSpeed * (T.dashDecel + (1 - T.dashDecel) * Math.max(0, this.dashTimer / T.dashTime)),
    );
    this.integrate(dt);
    this.resolveCollision();

    if (this.dashTimer <= 0) {
      this.setState('AIRBORNE');
    }
  }

  // -------------------------------------------------------------------------
  // LANDED: graceful fallback so the loop never dead-ends.
  // -------------------------------------------------------------------------
  private stepLanded(dt: number) {
    const s = this.snapshot;

    const surf = this.world.surfaceHeightAt(s.position.x, s.position.z);
    // If we walked off a roof/edge, fall. Only leave LANDED when clearly above
    // the local surface, not when inside a building footprint.
    if (s.position.y > surf + T.standHeight + 0.5 && !this.world.isSolidAt(s.position)) {
      this.setState('FALLING');
      return;
    }
    // Stay grounded on the current surface; never teleport upward into a
    // building. If a building footprint rises up under us, block instead.
    if (s.position.y <= surf + T.standHeight && !this.world.isSolidAt(s.position)) {
      s.position.y = surf + T.standHeight;
    }

    if (this.input.jumpPressed) {
      s.velocity.y = T.jumpSpeed;
      this.setState('AIRBORNE');
      return;
    }
    if (this.reattachLock > 0) this.reattachLock -= dt;
    this.groundPullQueryTimer -= dt;
    if (this.input.swing || this.input.swingPressed) {
      // Prefer a normal legal attach (e.g. rooftop LANDED) when one exists.
      if (this.tryAutoAttach(dt)) return;
      // Street-level anchors are refused by the airborne nadir/reel gates —
      // that is intentional. The player-initiated two-handed ground web pull
      // is the way out, on its own relaxed groundPull* gates. NEVER fires
      // without web input; NEVER on a timer. Held with nothing in range it
      // re-queries on the normal attach cadence rather than every frame.
      if (this.input.swingPressed || this.groundPullQueryTimer <= 0) {
        this.groundPullQueryTimer = T.attachQueryInterval;
        if (this.tryGroundPull()) return;
      }
    }

    // No web input: stay on the ground indefinitely. That is the behaviour the
    // owner asked for when the auto-launch was removed (commit 6fe420a).

    const fwd = this.horizForward();
    const right = this.rightOf(fwd);
    s.velocity.addScaledVector(fwd, this.input.moveY * T.groundAccel * dt);
    s.velocity.addScaledVector(right, this.input.moveX * T.groundAccel * dt);
    s.velocity.multiplyScalar(Math.max(0, 1 - T.groundDrag * dt));
    s.velocity.y = 0;
    this.prevPos.copy(s.position);
    this.integrate(dt);
    // Walk into a building → slide along the wall instead of teleporting up.
    if (this.world.isSolidAt(s.position)) {
      this.resolveCollision();
      // Keep grounded on the surface we actually stand on.
      const ns = this.world.surfaceHeightAt(s.position.x, s.position.z);
      if (!this.world.isSolidAt(s.position) && ns + T.standHeight < s.position.y + 1) {
        s.position.y = ns + T.standHeight;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Attach / release
  // -------------------------------------------------------------------------
  /**
   * Aimed shot: the player pressed, so the anchor comes from where they are
   * LOOKING, on the relaxed press* gates, and the rope is allowed to start long
   * and be winched down. Returns true when a rope actually exists afterwards.
   *
   * Separate from the automatic path on purpose — see the "aimed press" block
   * in tuning.ts. Nothing here can loosen the held-web attach that carries the
   * swing rhythm.
   */
  private tryAimedAttach(): boolean {
    const s = this.snapshot;
    const alt = s.position.y - this.world.surfaceHeightAt(s.position.x, s.position.z);
    if (alt > T.pressMaxAltitude) return false;
    this.aimDir.copy(this.horizForward());
    const a = this.picker.pickAimed(s.position, this.aimDir, this.input.moveX);
    if (!a) return false;
    return this.beginAttach(a, true);
  }

  /** Returns true when an attach happened this step. */
  private tryAutoAttach(dt: number): boolean {
    const s = this.snapshot;
    if (this.anchor) return false;
    if (!this.input.swing && !this.input.swingPressed) return false;

    // A DELIBERATE PRESS IS NOT THE AUTOMATIC LOOP. It gets the aimed path
    // first, and it clears the reattach lock on the way in: that lock exists to
    // stop the AUTOMATIC re-grab from ratcheting a chain of ever-higher swings,
    // and applying it to a click made the button dead for its whole duration
    // right after every release — one of the two big causes of "muchos clicks
    // sin lanzar ninguna telaraña".
    const pressed = this.input.swingPressed;
    if (pressed && this.pressPendingAim) {
      this.pressPendingAim = false;
      this.webPressAttempts++;
      this.reattachLock = 0;
      if (this.tryAimedAttach()) {
        this.webPressAttached++;
        return true;
      }
    }

    const alt = s.position.y - this.world.surfaceHeightAt(s.position.x, s.position.z);
    // About to run out of sky: take any legal anchor, ignoring the rhythm gates.
    const urgent = s.velocity.y < 0 && alt < T.urgentAttachAltitude;

    if (this.reattachLock > 0 && !urgent) return false;

    // Grab near or after the top of the ballistic arc, never while still
    // rocketing upward out of a release — that is what ratchets a chain.
    if (!pressed && !urgent && s.velocity.y > T.attachMaxUpward) {
      return false;
    }
    // NOTE: there is no minimum-speed veto any more. Iter1 and iter2 both
    // failed on it: it converted a slow patch into a 17.9 s traversal lock-out.
    const altCeil = pressed ? T.pressMaxAltitude : T.attachMaxAltitude;
    if (alt > altCeil) {
      if (pressed) s.webRefused = true;
      return false;
    }

    // Inside the attach window, query on a short cadence so a terminal-speed
    // dive still grabs a web before reaching the facade.
    this.attachQueryTimer -= dt;
    if (this.attachQueryTimer > 0 && !urgent) return false;
    this.attachQueryTimer = T.attachQueryInterval;

    const a = this.picker.pick(s.position, s.velocity, this.input.moveX);
    if (!a || !this.beginAttach(a)) {
      // A press that reaches here has been through the aimed path AND the
      // automatic one and produced nothing. Say so, once, so the feel layer can
      // answer the click — silence is indistinguishable from a dropped input.
      if (pressed) s.webRefused = true;
      return false;
    }
    if (pressed) this.webPressAttached++;
    return true;
  }

  /**
   * Player-initiated two-handed ground web pull. Called only from LANDED while
   * the web input is down. Prefers a real attach to a facade (rope starts at
   * true distance, winched fast to a legal ceiling, velocity yanked along the
   * line — no teleport). Sets justGroundPull on the fire frame for FX/animation.
   *
   * WHAT THIS USED TO DO, AND WHY IT WAS THE BUG. When no anchor qualified it
   * launched the player at recoverLaunchUp (27 m/s) with `this.anchor` still
   * null and set `justGroundPull` anyway — so FX drew no rope, the rig played
   * the two-handed pull over nothing, and ScoreSystem awarded a 'LAUNCH PULL'
   * trick for a web that was never fired. From the street that is what the
   * owner saw: the character levitating with no web and no animation. The
   * intent ("never trap the player") was right; the move was a lie.
   *
   * Now: no anchor means NO WEB. A deliberate press still gets an answer, but
   * it is an ordinary jump — the same jumpSpeed the Space bar uses, a move the
   * animation system already covers — with no justGroundPull, so no rope FX,
   * no pull pose and no trick score. A mere HOLD with nothing in range does
   * nothing at all and leaves the player walking.
   */
  private tryGroundPull(): boolean {
    const s = this.snapshot;
    // Clear any reattach lock — the player is deliberately asking to leave.
    this.reattachLock = 0;

    // Aim, not velocity: standing still, velocity is ~0 and carries no
    // direction at all (see AnchorPicker.pickGroundPull).
    this.aimDir.copy(this.horizForward());
    const a = this.picker.pickGroundPull(s.position, this.aimDir, this.input.moveX);
    if (a && this.beginGroundPullAttach(a)) {
      // tryAutoAttach ran first and may already have flagged this press as
      // refused; a rope now exists, so that flag was premature.
      s.webRefused = false;
      if (this.input.swingPressed) this.webPressAttached++;
      return true;
    }

    if (!this.input.swingPressed) return false;
    s.webRefused = true;
    s.velocity.y = Math.max(s.velocity.y, T.jumpSpeed);
    this.groundPullReeling = false;
    this.groundPullSwing = false;
    this.setState('AIRBORNE');
    return true;
  }

  /**
   * Attach from the street with a long initial rope and an along-line yank.
   * Refuses only when the resolved pivot cannot ever produce a legal nadir;
   * reelBudget is intentionally ignored here.
   */
  private beginGroundPullAttach(a: Anchor): boolean {
    const s = this.snapshot;
    this.anchor = a;
    // Set BEFORE updateRopeCeiling: this swing's rope floor and nadir
    // clearance are the ground-pull ones for its whole life, not just while
    // the fast reel is running.
    this.groundPullSwing = true;
    this.pressSwing = false;
    this.pressReeling = false;
    this.resolvePivot(a, s.position, s.velocity);
    this.updateRopeCeiling();
    this.swingHasDescended = false;
    this.swingCrossedNadir = false;
    this.swingPeakPlanar = Math.hypot(s.velocity.x, s.velocity.z);

    this.t1.subVectors(s.position, this.pivot);
    const dist = this.t1.length();
    // The UNFLOORED ceiling: updateRopeCeiling floors at minRopeNow, so testing
    // this.ropeCeiling against that same floor could never fail. This is the
    // real guard, and it uses hazardSurface (the highest ground under the whole
    // look-ahead path), which the picker's single surfaceHeightAt sample does
    // not — so it still catches an anchor the picker was happy with.
    const rawCeiling = this.pivot.y - (this.hazardY + T.groundPullNadirClearance);
    if (rawCeiling < T.groundPullMinRope || dist < 1e-4) {
      this.anchor = null;
      this.groundPullSwing = false;
      this.pivot.set(0, 0, 0);
      return false;
    }
    // Start at the true distance — no teleport toward the pivot. The fast
    // ground-pull reel + constraint will haul the player up the lines.
    this.ropeLength = THREE.MathUtils.clamp(dist, T.groundPullMinRope, T.maxWebDistance);
    this.groundPullReeling = true;

    this.t1.multiplyScalar(1 / dist); // radial out from pivot
    // Kill outward radial, then yank IN along the web (toward the pivot).
    const vrad = s.velocity.dot(this.t1);
    if (vrad > 0) s.velocity.addScaledVector(this.t1, -vrad);
    s.velocity.addScaledVector(this.t1, -T.groundPullYankAlong);

    // Also the classic up+forward beat so the first frame leaves the street
    // even before the reel has shortened the rope.
    const fwd = this.horizForward();
    if (s.velocity.y < T.recoverLaunchUp) s.velocity.y = T.recoverLaunchUp;
    const planar = Math.hypot(s.velocity.x, s.velocity.z);
    if (planar < T.recoverLaunchFwd) {
      s.velocity.addScaledVector(fwd, T.recoverLaunchFwd - planar);
    }

    // Guarantee tangential swing energy once airborne on the line.
    this.t2.copy(s.velocity).addScaledVector(this.t1, -s.velocity.dot(this.t1));
    const tanLen = this.t2.length();
    if (tanLen < T.minTangentialSpeed) {
      this.t3.set(s.velocity.x, 0, s.velocity.z);
      if (this.t3.lengthSq() < 1e-4) this.t3.copy(fwd);
      this.t3.normalize();
      this.t4.copy(this.t3).addScaledVector(this.t1, -this.t3.dot(this.t1));
      if (this.t4.lengthSq() < 1e-4) this.t4.copy(this.t3);
      this.t4.normalize();
      s.velocity.addScaledVector(this.t4, Math.max(0, T.minTangentialSpeed - tanLen));
    }

    this.picker.remember(a, s.position, fwd);
    this.clearWallRunContact();
    s.justAttached = true;
    s.justGroundPull = true;
    this.attachTimer = T.attachTime;
    this.setState('WEB_ATTACH');
    return true;
  }

  /** Returns false (and attaches nothing) if the resolved pivot cannot carry a
   *  legal arc — refusing is correct, the caller has a recovery move.
   *
   *  `aimed` = this anchor came from the player's own click (pickAimed), not
   *  from the automatic loop. It swaps the reel-budget refusal for the same
   *  raw-ceiling test the ground pull uses and winches the excess at
   *  pressReelRate instead. The nadir rule is untouched either way. */
  private beginAttach(a: Anchor, aimed = false): boolean {
    const s = this.snapshot;
    this.anchor = a;
    // A normal airborne attach is never a ground pull, whatever the last one
    // was: this swing uses the airborne rope floor and nadir clearance.
    this.groundPullSwing = false;
    this.pressSwing = aimed;
    this.pressReeling = false;
    this.resolvePivot(a, s.position, s.velocity);
    this.updateRopeCeiling();
    this.swingHasDescended = false;
    this.swingCrossedNadir = false;
    this.swingPeakPlanar = Math.hypot(s.velocity.x, s.velocity.z);

    this.t1.subVectors(s.position, this.pivot);
    const dist = this.t1.length();
    // Final nadir gate, on the RESOLVED pivot rather than the raw anchor. The
    // rope starts at the true distance — the player is never pulled toward the
    // anchor (no-teleport, a passing row we must not regress) — and is reeled
    // down to the ceiling during the downswing. If that reel is too big to
    // finish in time, this anchor cannot produce a legal arc: refuse it.
    if (aimed) {
      // The UNFLOORED ceiling, exactly as beginGroundPullAttach tests it:
      // updateRopeCeiling floors at minRopeNow, so comparing this.ropeCeiling
      // against that same floor could never fail. hazardY is the highest ground
      // under the whole look-ahead path, so this still catches an anchor the
      // picker's single surface sample was happy with.
      const rawCeiling = this.pivot.y - (this.hazardY + T.nadirClearance);
      if (rawCeiling < T.pressMinRope || dist < 1e-4) {
        this.anchor = null;
        this.pressSwing = false;
        this.pivot.set(0, 0, 0);
        return false;
      }
      // Excess over the ceiling is winched down at pressReelRate rather than
      // being a reason to refuse the player's own shot.
      this.pressReeling = dist > this.ropeCeiling;
      this.ropeLength = THREE.MathUtils.clamp(dist, T.pressMinRope, T.pressWebRange);
    } else if (dist - this.ropeCeiling > T.reelBudget || dist > this.ropeCeiling * T.maxReelRatio) {
      this.anchor = null;
      this.pivot.set(0, 0, 0);
      return false;
    } else {
      this.ropeLength = THREE.MathUtils.clamp(dist, T.minRope, T.maxWebDistance);
    }

    // Engage the taut constraint immediately: kill outward radial velocity so
    // the web redirects the existing momentum instead of the player flying
    // through it (SWING-002, ANCHOR-002).
    if (this.t1.lengthSq() > 1e-6) {
      this.t1.normalize();
      const vrad = s.velocity.dot(this.t1);
      if (vrad > 0) s.velocity.addScaledVector(this.t1, -vrad);
    }

    // Guarantee a lively start: if tangential speed is below the floor (a
    // head-on slam or near-vertical grab leaves ~0), inject speed along the
    // player's actual horizontal travel direction (not camera aim), projected
    // onto the tangent plane so the swing always launches with real momentum.
    this.t2.copy(s.velocity).addScaledVector(this.t1, -s.velocity.dot(this.t1));
    const tanLen = this.t2.length();
    if (tanLen < T.minTangentialSpeed) {
      this.t3.set(s.velocity.x, 0, s.velocity.z);
      if (this.t3.lengthSq() < 1e-4) this.t3.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.t3.normalize();
      this.t4.copy(this.t3).addScaledVector(this.t1, -this.t3.dot(this.t1));
      if (this.t4.lengthSq() < 1e-4) this.t4.copy(this.t3);
      this.t4.normalize();
      s.velocity.addScaledVector(this.t4, Math.max(0, T.minTangentialSpeed - tanLen));
    }

    const fwd = this.horizForward();
    this.picker.remember(a, s.position, fwd);
    this.clearWallRunContact();
    s.justAttached = true;
    this.attachTimer = T.attachTime;
    this.setState('WEB_ATTACH');
    return true;
  }

  /**
   * Resolve the effective swing pivot. The city places anchors at building
   * top-centre; swinging around that point would drag the player across the
   * roof and clip the volume. Slide the pivot horizontally toward the player
   * until the rope has a real lateral offset (a swing plane over the street)
   * or we reach the building's near edge.
   */
  private resolvePivot(a: Anchor, player: THREE.Vector3, vel: THREE.Vector3) {
    this.pivot.copy(a.position);

    // Horizontal direction from the anchor toward the player.
    this.t1.copy(player).sub(a.position);
    this.t1.y = 0;
    if (this.t1.lengthSq() < 1e-4) {
      this.t1.copy(vel);
      this.t1.y = 0;
    }
    if (this.t1.lengthSq() < 1e-4) this.t1.set(1, 0, 0);
    this.t1.normalize();

    const lat = Math.hypot(player.x - a.position.x, player.z - a.position.z);
    const dist = Math.max(0, lat - T.minAnchorLateral);

    // Probe along the way; stop at the first non-solid spot (the facade edge).
    const step = 1.5;
    let best = a.position;
    for (let d = step; d <= dist + step; d += step) {
      this.t2.copy(a.position).addScaledVector(this.t1, d);
      if (!this.world.isSolidAt(this.t2)) {
        best = this.t2;
        break;
      }
    }
    this.pivot.copy(best);
  }

  private release(boost: boolean) {
    const s = this.snapshot;
    this.detach(true);
    if (boost) {
      this.t1.set(s.velocity.x, 0, s.velocity.z);
      if (this.t1.lengthSq() > 1e-3) this.t1.normalize();
      else this.t1.copy(this.horizForward());
      s.velocity.addScaledVector(this.t1, T.releaseBoost);
      if (s.velocity.y > T.releaseMaxUp) s.velocity.y = T.releaseMaxUp;
    }
    this.releaseTimer = T.releaseTime;
    this.reattachLock = T.reattachLock;
    this.setState('RELEASE');
  }

  /** Apex jump / launch: leave the web with a strong up-and-forward impulse. */
  private apexLaunch() {
    const s = this.snapshot;
    s.velocity.y += T.launchBoostUp;

    // Launch along the horizontal travel direction for a flowing jump.
    this.t1.copy(s.velocity);
    this.t1.y = 0;
    if (this.t1.lengthSq() < 1e-4) this.t1.copy(this.horizForward());
    this.t1.normalize();
    s.velocity.addScaledVector(this.t1, T.launchBoostFwd);

    this.detach(true);
    this.setState('AIRBORNE');
  }

  private detach(emitReleased: boolean) {
    if (this.anchor) {
      this.anchor = null;
      this.pivot.set(0, 0, 0);
      this.ropeLength = 0;
      this.swingHasDescended = false;
      this.swingCrossedNadir = false;
      this.swingPeakPlanar = 0;
      this.groundPullReeling = false;
      this.groundPullSwing = false;
      this.pressReeling = false;
      this.pressSwing = false;
      this.snapshot.anchorPosition = null;
      if (emitReleased) this.snapshot.justReleased = true;
    }
  }

  // -------------------------------------------------------------------------
  // Un-stick recovery
  // -------------------------------------------------------------------------
  /** Forced recovery from a stall: drop any web, restore gravity-driven fall,
   *  and push the player outward along the contacted surface so they can never
   *  be permanently welded to a facade. */
  private unstick() {
    const s = this.snapshot;
    this.stuckTime = 0;
    this.detach(false);
    this.clearWallRunContact();
    this.setState('FALLING');

    // Find the outward direction by probing the four horizontal faces + up.
    const eps = 0.1;
    let nx = 0;
    let nz = 0;
    this.t1.set(s.position.x + eps, s.position.y, s.position.z);
    if (this.world.isSolidAt(this.t1)) nx = -1;
    this.t1.set(s.position.x - eps, s.position.y, s.position.z);
    if (this.world.isSolidAt(this.t1)) nx = 1;
    this.t1.set(s.position.x, s.position.y, s.position.z + eps);
    if (this.world.isSolidAt(this.t1)) nz = -1;
    this.t1.set(s.position.x, s.position.y, s.position.z - eps);
    if (this.world.isSolidAt(this.t1)) nz = 1;

    s.velocity.set(
      nx * T.unstickPush,
      Math.max(2, s.velocity.y + T.unstickPush * 0.5),
      nz * T.unstickPush,
    );
    if (nx === 0 && nz === 0) {
      // Not against a wall — push up (e.g. stuck in a corner / below a ledge).
      s.velocity.set(0, Math.max(4, T.unstickPush * 0.6), 0);
    }
  }

  // -------------------------------------------------------------------------
  // Integration / collision / lean
  // -------------------------------------------------------------------------
  private airAccelFalloff(): number {
    const sp = Math.hypot(this.snapshot.velocity.x, this.snapshot.velocity.z);
    return THREE.MathUtils.clamp(1 - sp / T.maxAirSpeed, 0, 1);
  }

  private integrate(dt: number) {
    const s = this.snapshot;
    if (s.state !== 'DASH') {
      // Planar cap (FEEL_SPEC dive/canyon 28-55 m/s). Dash is exempt — it has
      // its own impulse and must stay snappy.
      const hp = Math.hypot(s.velocity.x, s.velocity.z);
      if (hp > T.maxAirSpeed) {
        const k = T.maxAirSpeed / hp;
        s.velocity.x *= k;
        s.velocity.z *= k;
      }
      const sp = s.velocity.length();
      if (sp > T.maxTotalSpeed) s.velocity.multiplyScalar(T.maxTotalSpeed / sp);
    }
    if (s.velocity.y < -T.maxFallSpeed) s.velocity.y = -T.maxFallSpeed;
    s.position.addScaledVector(s.velocity, dt);
  }

  /**
   * Prevent tunnelling and, critically, cancel ONLY the velocity component
   * INTO the contacted face, leaving the tangential slide and gravity intact.
   *
   * The face is identified by sampling surfaceHeightAt a small epsilon around
   * the contact point: a wall shows a tall surface just beyond the contact in
   * ±x/±z (while directly below the player is 0 — so it is NOT mistaken for a
   * floor), whereas standing on a roof shows a tall surface directly below.
   * This avoids the classic false-floor weld at walls.
   */
  /**
   * Prevent tunnelling and, critically, cancel ONLY the velocity component
   * INTO the contacted face, and snap ONLY that axis' position to the face —
   * the tangential axes keep their integrated motion so the player SLIDES
   * along a facade instead of welding to it. Gravity is preserved unless the
   * floor itself was hit.
   *
   * Faces are identified by sampling surfaceHeightAt a small epsilon beyond
   * the contact in ±x/±z (a wall) and directly below (a floor). This avoids
   * the classic false-floor weld at walls.
   */
  private resolveCollision() {
    const s = this.snapshot;
    if (!this.world.isSolidAt(s.position)) return;

    // Integrated (solid) position before resolution.
    const ix = s.position.x;
    const iy = s.position.y;
    const iz = s.position.z;

    // Bisect to the contact point along the substep delta.
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      this.t3.lerpVectors(this.prevPos, s.position, mid);
      if (this.world.isSolidAt(this.t3)) hi = mid;
      else lo = mid;
    }
    this.t3.lerpVectors(this.prevPos, s.position, lo * 0.999);
    const cx = this.t3.x;
    const cy = this.t3.y;
    const cz = this.t3.z;

    // Deeply embedded (the segment back to prevPos was also inside). Surface to
    // the roof so the player can never be stuck inside solid space.
    if (this.world.isSolidAt(this.t3)) {
      const roof = this.world.surfaceHeightAt(this.t3.x, this.t3.z);
      s.position.set(this.t3.x, roof + 0.6, this.t3.z);
      if (s.velocity.y < 0) s.velocity.y = 0;
      return;
    }

    const eps = 0.3;
    const py = cy;

    // Detect which faces exist beyond the contact.
    const hxP = this.world.surfaceHeightAt(cx + eps, cz);
    const hxM = this.world.surfaceHeightAt(cx - eps, cz);
    const hzP = this.world.surfaceHeightAt(cx, cz + eps);
    const hzM = this.world.surfaceHeightAt(cx, cz - eps);
    const below = this.world.surfaceHeightAt(cx, cz);

    const wallXp = hxP > py + 0.5;
    const wallXm = hxM > py + 0.5;
    const wallZp = hzP > py + 0.5;
    const wallZm = hzM > py + 0.5;
    const floor = py - below < 0.8;

    // Pick ONE facade plane for this fixed step. Corner probes often report
    // both X and Z walls; cancelling both axes is the annihilation bug.
    let hitX = false;
    let hitZ = false;
    if (wallXp && s.velocity.x > 0) hitX = true;
    else if (wallXm && s.velocity.x < 0) hitX = true;
    if (wallZp && s.velocity.z > 0) hitZ = true;
    else if (wallZm && s.velocity.z < 0) hitZ = true;
    if (!hitX && !hitZ) {
      hitX = wallXp || wallXm;
      hitZ = wallZp || wallZm;
    }
    if (hitX && hitZ) {
      // Keep the larger tangential component alive. A perfect corner hit still
      // gets a slide direction below instead of becoming a zero-velocity weld.
      if (Math.abs(s.velocity.x) >= Math.abs(s.velocity.z)) hitZ = false;
      else hitX = false;
    }

    const preX = s.velocity.x;
    const preY = s.velocity.y;
    const preZ = s.velocity.z;

    // Snap only the contacted wall axis to the face and cancel only the normal
    // velocity. Tangential axes keep their integrated position (slide).
    let nx = cx;
    let ny = iy;
    let nz = cz;
    let normalX = 0;
    let normalZ = 0;
    if (hitX) {
      if (wallXp && (!wallXm || preX >= 0)) normalX = -1;
      else if (wallXm) normalX = 1;
      else normalX = preX >= 0 ? -1 : 1;
      nx = cx + normalX * T.facadeContactMargin;
    } else {
      nx = ix;
    }
    if (hitZ) {
      if (wallZp && (!wallZm || preZ >= 0)) normalZ = -1;
      else if (wallZm) normalZ = 1;
      else normalZ = preZ >= 0 ? -1 : 1;
      nz = cz + normalZ * T.facadeContactMargin;
    } else {
      nz = iz;
    }
    if (floor) {
      ny = cy;
    }
    s.position.set(nx, ny, nz);

    if (hitX || hitZ) {
      this.t1.set(normalX, 0, normalZ).normalize();
      if (this.shouldStartWallRun(floor) && this.startWallRun(this.t1, preX, preY, preZ)) {
        if (this.world.isSolidAt(s.position)) {
          s.position.set(
            cx + this.wallRunNormal.x * T.facadeContactMargin,
            ny,
            cz + this.wallRunNormal.z * T.facadeContactMargin,
          );
          this.wallRunPlaneOffset = s.position.dot(this.wallRunNormal);
        }
        return;
      }
      const persistedContact = this.facadeContactActive
        && this.t1.dot(this.facadeContactNormal) >= T.facadeSameNormalDot;

      s.velocity.set(preX, floor && preY < 0 ? 0 : preY, preZ);
      const incomingNormal = s.velocity.dot(this.t1);
      if (incomingNormal < 0) {
        // Project onto the wall plane: remove only velocity INTO the facade.
        s.velocity.addScaledVector(this.t1, -incomingNormal);
      }
      if (!persistedContact) {
        // One restitution loss on contact entry. Sustained contact only keeps
        // projecting into the plane until the body has actually cleared it.
        s.velocity.x *= T.facadeSlideDamping;
        s.velocity.z *= T.facadeSlideDamping;
      }

      const exitSpeed = persistedContact
        ? T.facadeExitSpeed
        : Math.min(
          T.facadeExitMaxSpeed,
          Math.max(T.facadeExitSpeed, Math.max(0, -incomingNormal) * T.facadeNormalRestitution),
        );
      const outward = s.velocity.dot(this.t1);
      if (outward < exitSpeed) {
        s.velocity.addScaledVector(this.t1, exitSpeed - outward);
      }
      this.facadeContactNormal.copy(this.t1);
      this.facadeContactActive = true;

      // If preserving the tangential position still leaves us barely inside a
      // corner, fall back to the swept contact point instead of staying solid.
      if (this.world.isSolidAt(s.position)) {
        s.position.set(cx + this.t1.x * T.facadeContactMargin, ny, cz + this.t1.z * T.facadeContactMargin);
      }
    } else if (floor && s.velocity.y < 0) {
      s.velocity.y = 0;
    }
  }

  private updateFacadeContactExit() {
    if (!this.facadeContactActive) return;
    const s = this.snapshot;
    this.t1.copy(s.position).addScaledVector(this.facadeContactNormal, -T.facadeExitClearance);
    if (!this.world.isSolidAt(this.t1)) this.facadeContactActive = false;
  }

  private shouldStartWallRun(floor: boolean): boolean {
    const s = this.snapshot;
    return !floor
      && !this.anchor
      && (s.state === 'AIRBORNE' || s.state === 'FALLING' || s.state === 'RELEASE');
  }

  private startWallRun(normal: THREE.Vector3, preX: number, preY: number, preZ: number): boolean {
    const s = this.snapshot;
    const prePlanar = Math.hypot(preX, preZ);
    if (prePlanar < 8 && preY < -4) return false;

    this.wallRunNormal.copy(normal).normalize();
    const normalPlanar = preX * this.wallRunNormal.x + preZ * this.wallRunNormal.z;
    const incoming = Math.max(0, -normalPlanar);
    const tanX = preX - this.wallRunNormal.x * normalPlanar;
    const tanZ = preZ - this.wallRunNormal.z * normalPlanar;
    const tangentSpeed = Math.hypot(tanX, tanZ);
    const totalApproach = incoming + tangentSpeed;
    this.wallRunUpBlend = totalApproach > 1e-3
      ? THREE.MathUtils.clamp(incoming / totalApproach, 0, 1)
      : 0;

    if (tangentSpeed > 1e-3) {
      this.wallRunDir.set(tanX / tangentSpeed, 0, tanZ / tangentSpeed);
    } else {
      this.t2.copy(this.horizForward());
      this.t2.y = 0;
      this.t2.addScaledVector(this.wallRunNormal, -this.t2.dot(this.wallRunNormal));
      if (this.t2.lengthSq() < 1e-4) this.t2.set(-this.wallRunNormal.z, 0, this.wallRunNormal.x);
      this.wallRunDir.copy(this.t2.normalize());
    }

    const sideWeight = Math.max(1 - this.wallRunUpBlend, T.wallRunSideFloor);
    this.wallRunDir.multiplyScalar(sideWeight).addScaledVector(UP, this.wallRunUpBlend).normalize();
    const speed = THREE.MathUtils.clamp(
      Math.max(T.wallRunMinSpeed, prePlanar * T.wallRunSpeedKeep),
      T.wallRunMinSpeed,
      T.wallRunMaxSpeed,
    );
    s.velocity.copy(this.wallRunDir).multiplyScalar(speed);
    this.detach(false);
    this.wallRunPlaneOffset = s.position.dot(this.wallRunNormal);
    this.facadeContactNormal.copy(this.wallRunNormal);
    this.facadeContactActive = true;
    this.setState('WALL_RUN');
    return true;
  }

  private exitWallRun(pushAway: boolean) {
    const s = this.snapshot;
    if (pushAway) {
      const outward = s.velocity.dot(this.wallRunNormal);
      if (outward < T.wallRunExitPush) {
        s.velocity.addScaledVector(this.wallRunNormal, T.wallRunExitPush - outward);
      }
    }
    this.clearWallRunContact();
    this.setState('AIRBORNE');
  }

  private wallRunJump() {
    const s = this.snapshot;
    this.t1.copy(this.wallRunNormal).multiplyScalar(T.wallJumpAway);
    this.t1.addScaledVector(this.wallRunDir, Math.max(T.wallJumpAlong, s.velocity.dot(this.wallRunDir)));
    this.t1.addScaledVector(UP, T.wallJumpUp);
    s.velocity.copy(this.t1);
    this.clearWallRunContact();
    this.setState('AIRBORNE');
  }

  private clearWallRunContact() {
    this.facadeContactActive = false;
    this.facadeContactNormal.set(0, 0, 0);
    this.wallRunNormal.set(0, 0, 0);
    this.wallRunDir.set(0, 0, 0);
    this.wallRunPlaneOffset = 0;
    this.wallRunUpBlend = 0;
  }

  private updateLean(dt: number) {
    const s = this.snapshot;
    let target = 0;
    if (s.state === 'SWING' || s.state === 'WEB_ATTACH') {
      const right = this.rightOf(this.horizForward());
      const latVel = s.velocity.dot(right);
      target = THREE.MathUtils.clamp(latVel / T.leanSpeed, -1, 1) * T.leanSwing;
    } else if (s.state === 'AIRBORNE' || s.state === 'RELEASE' || s.state === 'WALL_RUN') {
      const right = this.rightOf(this.horizForward());
      const latVel = s.velocity.dot(right);
      target = THREE.MathUtils.clamp(latVel / T.leanSpeed, -1, 1) * T.leanAir;
    }
    this.lean += (target - this.lean) * Math.min(1, T.leanSmoothing * dt);
  }

  private horizForward(): THREE.Vector3 {
    return this.t3.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
  }

  private rightOf(fwd: THREE.Vector3): THREE.Vector3 {
    return this.t4.set(-fwd.z, 0, fwd.x);
  }

  reset() {
    this.spawn();
    this.anchor = null;
    this.pivot.set(0, 0, 0);
    this.ropeLength = 0;
    this.attachTimer = 0;
    this.releaseTimer = 0;
    this.dashTimer = 0;
    this.dashCooldownTimer = 0;
    this.attachQueryTimer = 0;
    this.lean = 0;
    this.stuckTime = 0;
    this.ropeCeiling = Infinity;
    this.reattachLock = 0;
    this.rescueCooldown = 0;
    this.facadeContactActive = false;
    this.facadeContactNormal.set(0, 0, 0);
    this.wallRunNormal.set(0, 0, 0);
    this.wallRunDir.set(0, 0, 0);
    this.wallRunPlaneOffset = 0;
    this.wallRunUpBlend = 0;
    this.swingHasDescended = false;
    this.swingCrossedNadir = false;
    this.swingPeakPlanar = 0;
    this.groundPullReeling = false;
    this.groundPullSwing = false;
    this.pressReeling = false;
    this.pressSwing = false;
    this.groundPullQueryTimer = 0;
    this.pressPendingAim = false;
    this.webPressAttempts = 0;
    this.webPressAttached = 0;
    this.picker.reset();
    // A replay must start from an empty accumulator, otherwise run N inherits
    // run N-1's leftover fraction of a substep and the first frame after reset
    // steps a different number of times.
    this.stepAccumulator = 0;
    this.simTime = 0;
    this.realTime = 0;
    this.lastSubsteps = 0;
    this.droppedTime = 0;
    this.droppedSteps = 0;
    this.setState('LANDED');
    this.syncTraversalDebugApi();
  }

  /** Place the player STANDING on the local surface at the spawn point — the
   *  run starts on the street grass, ready for the first web press or a jump,
   *  rather than airborne at cruise altitude. Height comes from the world query
   *  (surface + stand height) so a changing city layout cannot trap the player
   *  inside a building, and initial velocity is zero. Getting up into the air
   *  is the job of the ground-pull / jump path, not of the spawn. */
  private spawn() {
    const s = this.snapshot;
    const x = T.spawnPoint.x;
    const z = T.spawnPoint.z;
    const top = this.world.surfaceHeightAt(x, z);
    const y = top + T.standHeight;
    s.position.set(x, y, z);
    s.velocity.set(0, 0, 0);
  }

  /**
   * HARNESS PROBE — no gameplay path calls this.
   *
   * "Would a ground web press here attach, or fall through to the recovery?"
   * asked at an arbitrary street position without moving or simulating the
   * player. The acceptance metric for the low-altitude web press is the
   * FALLBACK RATE over a few hundred street positions, and there is no other
   * way to get it: driving a tape to each position costs seconds per sample and
   * perturbs the very state being measured.
   *
   * Read-only: it never touches picker alternation state, the snapshot, or the
   * anchor. The caller must have streamed the city around these points first
   * (`setPlayerPosition` does that synchronously).
   */
  private readonly probeGroundPull = (
    points: GroundPullProbePoint[],
  ): GroundPullProbeResult[] => {
    const origin = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    return points.map((p) => {
      const surface = this.world.surfaceHeightAt(p.x, p.z);
      origin.set(p.x, surface + T.standHeight, p.z);
      const yaw = (p.yawDeg * Math.PI) / 180;
      fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
      const a = this.picker.pickGroundPull(origin, fwd, 0);
      // Gate-free reach query swept over the full compass, so a miss can be
      // attributed: nothing tall in range at all, or something in range that
      // the gates rejected.
      let any: Anchor | null = null;
      const dir = new THREE.Vector3();
      for (let k = 0; k < 8; k++) {
        const th = (k * Math.PI) / 4;
        dir.set(Math.sin(th), 0, Math.cos(th));
        const c = this.world.findSwingAnchor({
          origin, velocity: dir, lateralBias: 0,
          maxDistance: T.maxWebDistance, minHeightAbove: 0,
        });
        if (c && (!any || c.position.y > any.position.y)) any = c;
      }
      const rope = a ? a.position.distanceTo(origin) : null;
      return {
        x: p.x, z: p.z, surface,
        attach: !!a,
        anchorX: a ? a.position.x : null,
        anchorY: a ? a.position.y : null,
        anchorZ: a ? a.position.z : null,
        lateral: a ? Math.hypot(a.position.x - p.x, a.position.z - p.z) : null,
        rope,
        ropeCeiling: a ? a.position.y - (surface + T.nadirClearance) : null,
        bestAnyY: any ? any.position.y : null,
        bestAnyLateral: any ? Math.hypot(any.position.x - p.x, any.position.z - p.z) : null,
      };
    });
  };

  private syncTraversalDebugApi() {
    if (typeof window === 'undefined') return;
    const api = (window as unknown as { __GAUNTLET__?: TraversalDebugApi }).__GAUNTLET__;
    if (!api) return;
    api.setTraversalAssistsEnabled = this.setTraversalAssistsEnabled;
    api.traversalAssistsEnabled = this.traversalAssistsEnabled;
    api.traversalAssistsOff = !this.traversalAssistsEnabled;
    // Diagnostic: why wall runs end. Wall runs were measuring 0.01-0.44 s
    // (touches, not runs) and guessing at the cause was not working.
    api.wallRunExits = this.wallRunExits;
    api.probeGroundPull = this.probeGroundPull;
    // Fixed-timestep accounting. `simTime` minus `realTime` is the whole story:
    // it must stay within one substep, and `droppedTime` explains any gap the
    // spiral guard deliberately created.
    api.traversalDebug = {
      simTime: this.simTime,
      realTime: this.realTime,
      driftSeconds: this.simTime - this.realTime,
      accumulatorSeconds: this.stepAccumulator,
      lastSubsteps: this.lastSubsteps,
      droppedTime: this.droppedTime,
      droppedSteps: this.droppedSteps,
      fixedStep: GLOBALS.fixedStep,
      maxSubsteps: TraversalSystem.MAX_SUBSTEPS,
      webPressAttempts: this.webPressAttempts,
      webPressAttached: this.webPressAttached,
      dashCooldown: this.dashCooldownTimer,
    };
  }

  /** Counts of each wall-run exit path, for diagnosis. */
  private wallRunExits: Record<string, number> = {
    jump: 0, web: 0, dash: 0, slow: 0, lostContact: 0, landed: 0, timeout: 0,
  };
}
