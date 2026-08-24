import type { PlayerSnapshot, TraversalState } from '../contracts';
import { hashCoords, makeRng } from '../contracts';
import { GLOBALS } from '../contracts/globals';
import { FX_TUNING as T } from './tuning';
import {
  advanceRunPhase, copyPose, makePoseBuffer, mixPose, POSES, POSE_VARIANTS, sampleRunCycle,
  type Pose,
} from './poses';

/**
 * OWNED BY: feel-builder.
 *
 * THE MOTION LAYER — what turns "state -> a pose" into "state -> a family of
 * poses, selected and blended over time, with procedural life on top".
 *
 * The pose library (./poses.ts) used to hand each state exactly ONE target, and
 * that is the whole reason the hero could not feel alive: every swing settled
 * into the same silhouette, every fall into the same arrow, and the only thing
 * that ever changed was how fast the body got there. This file adds four things
 * on top of that library, in this order, and both rigs consume the result:
 *
 *   1. VARIATION  — which member of the state's pose family this VISIT starts
 *      from. Chosen once on state entry, deterministically (see DETERMINISM).
 *   2. DRIVE      — a second family member the body moves TOWARD as the physics
 *      changes, so a single visit is a motion and not a still. The partner is
 *      picked by a RULE, never by chance: a swing folds into the nadir tuck as
 *      it accelerates downward and opens into the high arc as it rises.
 *   3. FLIPS AND SELF-ROTATION — whole-body pitch and roll while untethered,
 *      triggered by what the player actually did (launched, dived off a ledge,
 *      steered hard) and always resolved to upright.
 *   4. SECONDARY  — breathing, head look, limb trail, hand settle. Cheap
 *      procedural offsets on the authored targets; no clips, no geometry.
 *
 * BOTH CHARACTER MODES. Everything here produces either a `Pose` (which both
 * rigs already know how to consume) or two scalar body angles (which both rigs
 * apply to their own root pivot), so the procedural box figure and the skinned
 * model get the same motion. The two documented exceptions are in
 * docs/animation/SYSTEM.md: the ENTRY TRANSITION for LANDED is invisible in
 * 'model' mode because the shipped Land clip owns the body there, and head YAW
 * reaches the model through a twist about the neck axis rather than through the
 * direction solver (a yaw about a bone's own axis is not expressible as a
 * direction target).
 *
 * DETERMINISM. Every random choice comes from `makeRng` seeded on
 * `hashCoords(stateOrdinal, visitCount, GLOBALS.worldSeed)`. `visitCount` is how
 * many times this session has ENTERED that state, which is a function of the
 * deterministic simulation, so the same tape on the same seed picks the same
 * variants in the same order — the evidence pipeline's byte-identical
 * regeneration survives. There is no `Math.random()` anywhere in this file, and
 * `randomness` never decides WHETHER something happens, only which of several
 * equally-grounded flavours it happens in.
 */

const TAU = Math.PI * 2;

/** Stable ordinal per state, so the rng seed does not depend on key order. */
const STATE_ORDINAL: Record<TraversalState, number> = {
  IDLE: 0, FALLING: 1, WEB_ATTACH: 2, SWING: 3, RELEASE: 4,
  AIRBORNE: 5, DASH: 6, WALL_RUN: 7, PERCH: 8, LANDED: 9,
};

/** Untethered states: the only ones a flip or a body roll may run in. */
function isAirborneState(s: TraversalState): boolean {
  return s === 'AIRBORNE' || s === 'FALLING' || s === 'RELEASE';
}

/**
 * States that OWN the body's orientation themselves, and therefore refuse any
 * residual flip rotation on top of it.
 *
 * A wall run is not merely "not airborne": it is a surface contact, and the
 * surface — not the somersault the hero arrived on — decides which way up the
 * body is. Iteration 1 gated flips on `!isAirborneState` alone, which let an
 * in-progress flip keep emitting intermediate pitch for the ~0.18 s it took to
 * accelerate to a whole turn. Both rigs added that pitch straight on top of the
 * wall-run tilt, so the animation critic caught the hero running a facade at
 * 36.9, 226.7 and 334.8 degrees of pitch (model) and 204 / 321.5 (procedural).
 *
 * Both rigs ALSO gate on this predicate at the point where they apply the
 * angles, so the rule survives even if this layer ever emits a residual again.
 */
export function isSurfaceContactState(s: TraversalState): boolean {
  return s === 'WALL_RUN' || s === 'LANDED' || s === 'PERCH' || s === 'IDLE';
}

function isRunningState(s: TraversalState, speed: number): boolean {
  return s === 'WALL_RUN' || (s === 'LANDED' && speed > T.characterRunSpeed);
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smoothstep(t: number): number { const u = clamp01(t); return u * u * (3 - 2 * u); }

// ---------------------------------------------------------------------------
// ENTRY TRANSITIONS — short motions the body passes THROUGH on entering a state
//
// Fluidity is not only about blend rates. Two moments in the reference read as
// motions rather than as poses being reached: the WIND-UP before a web is
// thrown (the arm cocks before it snaps out along the line) and the ABSORB when
// a landing is taken (the body compresses, then recovers into the run). Both are
// authored here as a pose the body starts the state IN and leaves over a short
// window, which costs one extra mix and needs no new clip.
// ---------------------------------------------------------------------------

/** WEB_ATTACH wind-up: the throwing arm cocked back, knees loaded. */
const ATTACH_WINDUP: Pose = {
  body: { x: 0.55, y: 0, z: 0 },
  head: { x: -0.2, y: 0, z: 0 },
  shoulderL: { x: 0.85, y: 0, z: -0.42 }, elbowL: 1.75,
  shoulderR: { x: 0.7, y: 0, z: 0.42 }, elbowR: 1.5,
  hipL: { x: -0.5, y: 0, z: -0.14 }, kneeL: 1.05,
  hipR: { x: -0.35, y: 0, z: 0.14 }, kneeR: 0.85,
};

/** LANDED absorb: the compression a landing is taken on, before the run resumes. */
const LAND_ABSORB: Pose = {
  body: { x: 0.55, y: 0, z: 0 },
  head: { x: -0.3, y: 0, z: 0 },
  shoulderL: { x: -0.95, y: 0, z: -0.4 }, elbowL: 0.9,
  shoulderR: { x: -0.95, y: 0, z: 0.4 }, elbowR: 0.9,
  hipL: { x: -0.85, y: 0, z: -0.22 }, kneeL: 1.65,
  hipR: { x: -0.8, y: 0, z: 0.22 }, kneeR: 1.55,
};

/** DASH compression: the beat of load before the burst carries the body away. */
const DASH_LOAD: Pose = {
  body: { x: 1.15, y: 0, z: 0 },
  head: { x: -0.3, y: 0, z: 0 },
  shoulderL: { x: 0.95, y: 0, z: -0.3 }, elbowL: 1.7,
  shoulderR: { x: -0.6, y: 0, z: 0.2 }, elbowR: 1.5,
  hipL: { x: -0.55, y: 0, z: -0.12 }, kneeL: 1.3,
  hipR: { x: -0.45, y: 0, z: 0.12 }, kneeR: 1.2,
};

/**
 * WALL_RUN plant: the body meeting the facade. Knees deeply loaded, both arms
 * reaching into the surface, torso squared up to it.
 *
 * This exists because contact now resolves a flip on the contact frame instead
 * of unwinding it over the next fifth of a second (see FlipController.update).
 * That is the correct orientation rule, and it needs a MOTION at the boundary
 * or the change of up-axis is the only thing the eye is given. A plant is what
 * a body hitting a wall actually does.
 */
const WALL_PLANT: Pose = {
  body: { x: 0.05, y: 0, z: 0 },
  head: { x: -0.35, y: 0, z: 0 },
  shoulderL: { x: -1.85, y: 0, z: -0.34 }, elbowL: 0.7,
  shoulderR: { x: -1.7, y: 0, z: 0.34 }, elbowR: 0.8,
  hipL: { x: -1.25, y: 0, z: -0.16 }, kneeL: 1.95,
  hipR: { x: -1.05, y: 0, z: 0.16 }, kneeR: 1.75,
};

interface EntryTransition { pose: Pose; time: number }

const ENTRY_TRANSITION: Partial<Record<TraversalState, EntryTransition>> = {
  WEB_ATTACH: { pose: ATTACH_WINDUP, time: 0.09 },
  LANDED: { pose: LAND_ABSORB, time: 0.22 },
  DASH: { pose: DASH_LOAD, time: 0.05 },
  WALL_RUN: { pose: WALL_PLANT, time: 0.13 },
};

// ---------------------------------------------------------------------------
// DRIVE RULES — which family member the body moves toward, and how far
// ---------------------------------------------------------------------------

interface Drive { partner: number; strength: number; authority: number }

const NO_DRIVE: Drive = { partner: 0, strength: 0, authority: 0 };
const driveOut: Drive = { partner: 0, strength: 0, authority: 0 };

function driveFor(state: TraversalState, p: PlayerSnapshot): Drive {
  const vy = p.velocity.y;
  const d = driveOut;
  d.authority = T.motionDriveAuthority;
  switch (state) {
    case 'SWING':
      // SWING takes a LOWER authority than every other state, and that is the
      // other half of the swing-variety fix. The three swing siblings are now
      // deliberately far apart in silhouette (ball / scissor / cross, see
      // poses.ts); at the global 0.65 authority a visit starting on any of them
      // spent most of its life two-thirds of the way toward the same partner,
      // which is precisely why the critic's three pinned swing clips looked
      // alike. A smaller fraction of a much larger delta is MORE motion than
      // before and still leaves the starting silhouette recognisable.
      d.authority = T.motionSwingDriveAuthority;
      // Falling through the arc folds the body into the nadir tuck; rising out
      // of it opens into the high arc. Both are OBSERVED members of the SWING
      // family, and which one you get is the pendulum's business, not chance.
      if (vy < 0) { d.partner = 1; d.strength = clamp01(-vy / T.motionSwingTuckVy); }
      else { d.partner = 2; d.strength = clamp01(vy / T.motionSwingArcVy); }
      return d;
    case 'AIRBORNE':
      // A hard dive tucks; a fast flat pass spreads into the glide.
      if (vy < -T.motionAirTuckVy) {
        d.partner = 1;
        d.strength = clamp01((-vy - T.motionAirTuckVy) / T.motionAirTuckVy);
      } else {
        d.partner = 2;
        d.strength = clamp01(p.speed / T.motionAirGlideSpeed);
      }
      return d;
    case 'FALLING':
      // Terminal-ish descent opens the skydive arch; the first beat off a ledge
      // is still the tip-off shape the crouch left behind.
      if (-vy > T.motionFallArchVy) {
        d.partner = 1;
        d.strength = clamp01((-vy - T.motionFallArchVy) / T.motionFallArchVy);
      } else {
        d.partner = 2;
        d.strength = 1 - smoothstep(p.stateTime / 0.5);
      }
      return d;
    case 'RELEASE':
      // The flung-wide instant settles into the swing residual over the state.
      d.partner = 1; d.strength = smoothstep(p.stateTime / 0.25);
      return d;
    case 'WEB_ATTACH': {
      // A high anchor gets the overhead lead; a level one gets the forward lead.
      const up = p.anchorPosition ? p.anchorPosition.y - p.position.y : 8;
      d.partner = up > T.motionAttachHighDy ? 1 : 2;
      d.strength = smoothstep(p.stateTime / 0.18);
      return d;
    }
    case 'DASH':
      d.partner = 1; d.strength = smoothstep(p.stateTime / 0.12);
      return d;
    case 'PERCH':
      d.partner = 1; d.strength = smoothstep(p.stateTime / 1.2);
      return d;
    default:
      return NO_DRIVE;
  }
}

// ---------------------------------------------------------------------------
// BLEND RATES — per state, because states differ in how fast a body may change
// ---------------------------------------------------------------------------

/**
 * Pose blend rate (1/s) per state. `FX_TUNING.poseBlendRate` remains the
 * default and the fallback; these are the deviations, and they exist because a
 * dash and a glide are not allowed to arrive at the same speed. High = snappy
 * (the body is being struck into the pose), low = floaty.
 */
const BLEND_RATE: Partial<Record<TraversalState, number>> = {
  DASH: 24,
  WEB_ATTACH: 20,
  RELEASE: 16,
  SWING: 11,
  AIRBORNE: 9,
  FALLING: 8,
  PERCH: 7,
  IDLE: 6,
};

// ---------------------------------------------------------------------------
// FLIPS AND SELF-ROTATION
// ---------------------------------------------------------------------------

export type FlipKind = 'none' | 'front' | 'back' | 'roll';

/**
 * The flip state machine. It owns two whole-body angles — pitch (a somersault
 * about the body's lateral axis) and roll (self-rotation about the travel axis)
 * — which each rig applies to its own root pivot, ON TOP of the pose. They are
 * not part of the pose because a pose is a set of JOINT directions and a flip is
 * an orientation of the whole body.
 *
 * THE TWO RULES THAT MATTER:
 *
 *  - IT IS A CONSEQUENCE, NOT A DIE ROLL. A flip only starts on entering an
 *    untethered state and only when the motion that got you there justifies one:
 *    launched upward (front), tipped off a ledge with little forward speed
 *    (back), or carrying a hard steer (roll). Altitude gates all three. What the
 *    rng chooses is the FLAVOUR — one turn or two, and whether a somersault
 *    carries a corkscrew — never whether it fires.
 *
 *  - IT ALWAYS RESOLVES UPRIGHT. The angle is `turns · 2π · smoothstep(t)`, so
 *    finishing lands on an exact whole number of turns, which is the identity
 *    rotation; the controller then zeroes the angle with no visible change. If
 *    the state ends early — a web bites, the ground arrives, a facade does —
 *    the flip does not reverse, does not hold and is no longer given a few
 *    frames to catch up: the CONTACT FRAME ITSELF is the whole turn. The hero
 *    cannot enter a swing, a landing or a wall run upside down, and the bound
 *    is zero frames rather than a resolve time.
 */
class FlipController {
  kind: FlipKind = 'none';
  turns = 1;
  /** Progress 0..1 through the flip. */
  t = 1;
  /** +1 / -1 about the flip axis. */
  dir = 1;
  /** Corkscrew: a roll that runs alongside a pitch flip. 0 when there is none. */
  cork = 0;
  /** Smoothed bank from steering — the always-on part of self-rotation. */
  private bank = 0;

  pitch = 0;
  roll = 0;

  /**
   * Decide whether entering this state starts a flip. Physics gates, rng
   * flavours. `forced` is the critic handle (`setMotionFlip`): it overrides
   * WHICH rotation happens so a back flip or a barrel roll can be inspected on
   * demand, and it deliberately does NOT override the altitude gate — the safety
   * rule stays a rule even for evidence capture.
   */
  start(p: PlayerSnapshot, rng: () => number, forced: FlipKind | null): void {
    this.kind = 'none';
    // Never begin a rotation we might not be able to finish before the ground.
    if (p.altitude < T.motionFlipMinAltitude) { this.t = 1; return; }

    const vy = p.velocity.y;
    const h = Math.hypot(p.velocity.x, p.velocity.z);
    if (forced && forced !== 'none') {
      this.kind = forced;
      this.dir = forced === 'back' ? -1 : forced === 'roll' && p.lean < 0 ? -1 : 1;
    } else if (vy > T.motionFlipLaunchVy) {
      this.kind = 'front'; this.dir = 1;
    } else if (vy < -T.motionFlipDiveVy && h < T.motionFlipDiveMaxSpeed) {
      // Tipping off a ledge with little forward speed — the leave-perch dive.
      this.kind = 'back'; this.dir = -1;
    } else if (Math.abs(p.lean) > T.motionFlipRollLean) {
      this.kind = 'roll'; this.dir = p.lean < 0 ? -1 : 1;
    } else {
      this.t = 1;
      return;
    }

    // Flavour. Two turns only when there is room for them, and a corkscrew only
    // on a somersault. Both come off the seeded stream, so a tape replays them.
    const roomy = p.altitude > T.motionFlipDoubleAltitude;
    this.turns = roomy && rng() < 0.5 ? 2 : 1;
    this.cork = this.kind !== 'roll' && roomy && rng() < 0.4 ? (rng() < 0.5 ? -1 : 1) : 0;
    this.t = 0;
  }

  /**
   * Called every frame. `airborne` is false in any state a flip must resolve in.
   *
   * RESOLUTION IS STATE-EXACT, NOT TIME-SMOOTHED. The moment the body stops
   * being untethered the rotation IS the whole turn — the same identity the
   * flip would have reached on its own — and the controller emits zero from
   * that frame on. Iteration 1 instead *accelerated* the remaining turn over
   * `motionFlipResolveTime`, which is a smooth curve through angles the body
   * has no business being at while it is standing on something: the animation
   * critic measured 226.7 degrees of pitch during WALL_RUN. There is no smooth
   * exit from 226 degrees that does not pass through inverted, so the honest
   * fix is not a faster blend, it is arriving upright on the contact frame.
   *
   * The visible cost is one frame of orientation change at a state boundary
   * that is already a hard change of pose — and WALL_RUN now spends its first
   * 0.13 s in a plant/absorb (see ENTRY_TRANSITION) which is exactly what a
   * contact looks like.
   */
  update(p: PlayerSnapshot, dt: number, airborne: boolean): void {
    if (this.kind !== 'none' && this.t < 1 && airborne) {
      this.t = Math.min(1, this.t + dt / Math.max(0.05, T.motionFlipTime * this.turns));
      const a = this.turns * TAU * smoothstep(this.t) * this.dir;
      if (this.kind === 'roll') { this.roll = a; this.pitch = 0; }
      else { this.pitch = a; this.roll = this.cork * this.turns * TAU * smoothstep(this.t); }
      if (this.t >= 1) {
        // A whole number of turns IS the identity rotation, so dropping to zero
        // here changes nothing on screen.
        this.kind = 'none';
        this.pitch = 0;
        this.roll = 0;
      }
    } else {
      // Includes the first non-airborne frame of an in-progress flip: contact
      // completes the turn outright rather than unwinding through it.
      if (this.kind !== 'none') { this.kind = 'none'; this.t = 1; }
      this.pitch = 0;
      this.roll = 0;
    }

    // Always-on self-rotation: the body banks into a steer even when no flip is
    // running. Small, and now HARD-zeroed rather than eased out the moment the
    // body is tethered or on a surface — the comment claimed that already, but
    // the first-order filter still leaked up to `motionBankRad` (17 degrees) of
    // roll into the first frames of a wall run, fighting the wall tilt.
    if (!airborne) {
      this.bank = 0;
    } else {
      const want = Math.max(-1, Math.min(1, p.lean)) * T.motionBankRad;
      this.bank += (want - this.bank) * Math.min(1, T.motionBankRate * dt);
      this.roll += this.bank;
    }
  }

  /** How far from upright the body currently is, degrees. For the report. */
  offUprightDeg(): number {
    const pitchTurn = Math.abs(((this.pitch % TAU) + TAU) % TAU - Math.PI);
    return +(180 - pitchTurn * 180 / Math.PI).toFixed(1);
  }
}

// ---------------------------------------------------------------------------
// SECONDARY MOTION — aliveness at near-zero cost
// ---------------------------------------------------------------------------

/**
 * A one-dimensional spring. Underdamped on purpose: it is what makes a hand
 * ARRIVE at a pose and settle rather than slide into it. Integration is
 * semi-implicit Euler with a clamped step, which is stable at any frame rate we
 * can actually hit.
 */
class Spring1 {
  private x = 0;
  private v = 0;
  private primed = false;

  step(target: number, dt: number, freq: number, damping: number): number {
    if (!this.primed) { this.x = target; this.primed = true; return target; }
    const h = Math.min(dt, 1 / 30);
    const k = freq * freq;
    const c = 2 * damping * freq;
    this.v += (k * (target - this.x) - c * this.v) * h;
    this.x += this.v * h;
    return this.x;
  }
}

export interface MotionSample {
  /** The pose to drive the rig with this frame, variation + secondary included. */
  pose: Pose;
  /** Extra whole-body pitch (rad) about the body's lateral axis. */
  flipPitch: number;
  /** Extra whole-body roll (rad) about the travel axis. */
  flipRoll: number;
  /** Pose blend rate (1/s) for this state and this frame. */
  blendRate: number;
  /** Run-cycle phase, owned here so both rigs advance it identically. */
  runPhase: number;
  /** True while the run cycle is driving the body (ground movement or wall run). */
  running: boolean;
}

export interface MotionReport {
  state: TraversalState;
  /** How many times this session has entered the current state. */
  visit: number;
  /** Which family member this visit started from, and how many there are. */
  variant: number;
  variants: number;
  /** The physics-chosen partner and how far the body has moved toward it. */
  partner: number;
  drive: number;
  entry: number;
  flip: { kind: FlipKind; turns: number; t: number; pitchDeg: number; rollDeg: number; cork: number };
  climb: number;
  headYawDeg: number;
  blendRate: number;
  seed: number;
}

/**
 * One per rig. Fed the snapshot every frame; hands back the pose to drive and
 * the two body angles to apply. Allocation-free after construction.
 */
export class MotionController {
  private prevState: TraversalState | null = null;
  private visits = new Map<TraversalState, number>();
  private variant = 0;
  private flip = new FlipController();
  private breathClock = 0;
  private headYaw = 0;
  private prevYaw = 0;
  private yawRate = 0;
  private climb = 0;
  private springL = new Spring1();
  private springR = new Spring1();
  private runPhase = 0;
  private lastDrive: Drive = { partner: 0, strength: 0, authority: 0 };
  private lastEntry = 0;
  private lastBlend: number = T.poseBlendRate;
  /** Reused shuffle buffer for `pickVariant` — no per-entry allocation. */
  private permBuf: number[] = [];

  private outBuf = makePoseBuffer();

  constructor(private seed: number = GLOBALS.worldSeed) {}

  /**
   * Debug pin, exposed as `__GAUNTLET__.setMotionVariant(i | null)`. Variation is
   * the claim this whole layer makes, and the honest way to show it is the same
   * state captured on each of its variants; this makes that a one-call
   * comparison. null (the default) restores seeded selection.
   */
  static pinned: number | null = null;

  /**
   * Debug handle, exposed as `__GAUNTLET__.setMotionFlip(kind | null)`. Which
   * flip fires is decided by the physics of the entry, so a tape that never
   * releases sideways at altitude will never show a barrel roll — this forces
   * the KIND on the next airborne entry so every rotation the system can produce
   * is inspectable. null (the default) restores the physics decision.
   */
  static forcedFlip: FlipKind | null = null;

  get phase(): number { return this.runPhase; }

  /**
   * Which family member THIS visit starts from — a seeded SHUFFLED CYCLE, not
   * an independent draw per visit.
   *
   * Iteration 1 drew `floor(rng()*n)` fresh on every visit. That is uniform in
   * the limit and completely unreliable in the short run, which is the only run
   * a player ever sees: on the shipped seed the first three SWING visits came
   * out 0, 0, 1, so the animation critic captured three separate tapes in which
   * ordinary swinging never left variant 0 and concluded — correctly — that the
   * family was invisible in normal play.
   *
   * A shuffled cycle fixes the sampling without touching determinism: each
   * block of `n` visits is a seeded permutation of all `n` members, so every
   * sibling is guaranteed to appear within the first `n` visits to the state,
   * while WHICH ORDER they come in still varies per block and per world seed.
   * Same seed, same tape, same sequence — the evidence pipeline still replays.
   */
  private pickVariant(state: TraversalState, visit: number, n: number): number {
    if (n <= 1) return 0;
    const i = Math.max(0, visit - 1);
    const perm = this.permBuf;
    perm.length = 0;
    for (let k = 0; k < n; k += 1) perm.push(k);
    // A separate stream from the visit stream above (+0x51 on the ordinal), so
    // shuffling a block cannot shift the flip flavours a visit draws.
    const prng = makeRng(hashCoords(STATE_ORDINAL[state] + 0x51, Math.floor(i / n), this.seed));
    for (let k = n - 1; k > 0; k -= 1) {
      const j = Math.min(k, Math.floor(prng() * (k + 1)));
      const swap = perm[k]; perm[k] = perm[j]; perm[j] = swap;
    }
    return perm[i % n];
  }

  update(p: PlayerSnapshot, dt: number, yaw: number): MotionSample {
    const state = p.state;
    const entered = state !== this.prevState;
    if (entered) {
      const visit = (this.visits.get(state) ?? 0) + 1;
      this.visits.set(state, visit);
      const rng = makeRng(hashCoords(STATE_ORDINAL[state], visit, this.seed));
      const family = POSE_VARIANTS[state];
      this.variant = family ? this.pickVariant(state, visit, family.length) : 0;
      // The flip decision consumes the SAME stream, after the variant, so the
      // ordering is fixed and a replay reproduces both.
      if (isAirborneState(state) && !isAirborneState(this.prevState ?? 'IDLE')) {
        this.flip.start(p, rng, MotionController.forcedFlip);
      }
      this.prevState = state;
    }

    // --- body rotation layers ------------------------------------------------
    this.flip.update(p, dt, isAirborneState(state));

    // --- the base pose: family member, driven toward its physics partner ------
    this.runPhase = advanceRunPhase(
      this.runPhase, p.speed, dt, T.runCycleRefSpeed, T.runCycleMinHz, T.runCycleMaxHz,
    );
    const running = isRunningState(state, p.speed);
    const out = this.outBuf;
    if (running) {
      copyPose(out, sampleRunCycle(this.runPhase));
      this.lastDrive = NO_DRIVE;
    } else {
      const family = POSE_VARIANTS[state];
      const base = family
        ? family[MotionController.pinned !== null
          ? MotionController.pinned % family.length
          : this.variant]
        // GROUND REST IS `LANDED`, NOT `IDLE`. The traversal state machine never
        // emits `IDLE` (it is only ever read, in TraversalSystem), so standing
        // still is LANDED below the run threshold — and `POSES.LANDED` is a
        // mid-stride RUN key, which is why the critic found the ground idle
        // "quiet and mostly dead": a frozen stride is a mannequin. Resting on
        // LANDED therefore targets the authored IDLE pose, and the idle-life
        // layer below breathes it. See docs/animation/SYSTEM.md.
        : (state === 'LANDED' ? POSES.IDLE : (POSES[state] ?? POSES.AIRBORNE));
      const drive = family ? driveFor(state, p) : NO_DRIVE;
      this.lastDrive = drive;
      if (family && drive.strength > 0.001 && drive.partner !== this.variant) {
        mixPose(
          out, base, family[drive.partner % family.length],
          drive.strength * drive.authority,
        );
      } else {
        copyPose(out, base);
      }
    }

    // --- entry transition: a short motion the body passes THROUGH ------------
    const entry = ENTRY_TRANSITION[state];
    let entryW = 0;
    if (entry && p.stateTime < entry.time) {
      entryW = 1 - smoothstep(p.stateTime / entry.time);
      mixPose(out, out, entry.pose, entryW);
    }
    this.lastEntry = entryW;

    this.applySecondary(out, p, dt, yaw, state, running);

    const blendRate = this.blendRateFor(state, p, running);
    this.lastBlend = blendRate;
    // A surface-contact state owns which way up the body is; see
    // `isSurfaceContactState`. The controller above already resolves a flip on
    // the contact frame, so this is belt-and-braces — and it is what makes the
    // rule true for anything that consumes a MotionSample, present or future.
    const surface = isSurfaceContactState(state);
    return {
      pose: out,
      flipPitch: surface ? 0 : this.flip.pitch,
      flipRoll: surface ? 0 : this.flip.roll,
      blendRate,
      runPhase: this.runPhase,
      running,
    };
  }

  /**
   * The run cycle is filtered much less than a state switch is — a first-order
   * filter attenuates anything periodic, and a 2.9 Hz stride came out at 65% of
   * its authored amplitude at `poseBlendRate` (see FX_TUNING.runBlendRate). Every
   * other state gets its own rate from BLEND_RATE, defaulting to poseBlendRate.
   */
  private blendRateFor(state: TraversalState, p: PlayerSnapshot, running: boolean): number {
    const base = BLEND_RATE[state] ?? T.poseBlendRate;
    if (!running) return base;
    return T.poseBlendRate
      + (T.runBlendRate - T.poseBlendRate) * Math.min(1, p.stateTime / T.runBlendRamp);
  }

  /**
   * Breathing, head look, limb trail, hand settle and the wall-run climb layer,
   * written straight onto the pose buffer this frame owns.
   *
   * All of it is deliberately SMALL. Secondary motion earns its keep by being
   * the difference between a mannequin holding a correct pose and a body holding
   * it; the moment it is large enough to notice on its own it is fighting the
   * authored silhouettes that critics already validated.
   */
  private applySecondary(
    out: Pose, p: PlayerSnapshot, dt: number, yaw: number,
    state: TraversalState, running: boolean,
  ): void {
    this.breathClock += dt;

    // --- yaw rate, for the limb trail ---------------------------------------
    const dYaw = Math.atan2(Math.sin(yaw - this.prevYaw), Math.cos(yaw - this.prevYaw));
    this.prevYaw = yaw;
    const instant = dt > 1e-4 ? dYaw / dt : 0;
    this.yawRate += (instant - this.yawRate) * Math.min(1, T.motionTrailRate * dt);

    // --- breathing and idle life: wherever the body is at rest ---------------
    // INFERRED, not observed: the reference pack has no IDLE frames at all, and
    // its PERCH frames are described as "body nearly stationary".
    //
    // `LANDED` below the run threshold is in here now, because THAT is the game's
    // real ground rest — the state machine never emits `IDLE`. Breathing alone
    // was too small to answer the critic's "quiet and mostly dead", so rest also
    // gets a WEIGHT SHIFT: a slow lateral sway of the torso and hips at an
    // incommensurate frequency to the breath, so the two never phase-lock into
    // one pulse. Both are clock-driven, so they are identical on every replay.
    if (!running && isSurfaceContactState(state) && p.speed < T.characterRunSpeed) {
      const b = Math.sin(this.breathClock * TAU * T.motionBreathHz);
      out.body.x += b * T.motionBreathAmp;
      out.head.x -= b * T.motionBreathAmp * 0.6;
      out.shoulderL.z -= b * T.motionBreathAmp * 1.4;
      out.shoulderR.z += b * T.motionBreathAmp * 1.4;
      if (state !== 'PERCH') {
        const w = Math.sin(this.breathClock * TAU * T.motionIdleShiftHz);
        const wq = Math.sin(this.breathClock * TAU * T.motionIdleShiftHz * 0.5);
        out.body.z += w * T.motionIdleShiftAmp;
        out.head.y += wq * T.motionIdleHeadAmp;
        out.head.z -= w * T.motionIdleShiftAmp * 0.5;
        // the weight goes onto one leg: that knee straightens, the other bends
        out.kneeL += (0.5 + 0.5 * w) * T.motionIdleKneeAmp;
        out.kneeR += (0.5 - 0.5 * w) * T.motionIdleKneeAmp;
        out.hipL.z -= w * T.motionIdleShiftAmp * 0.6;
        out.hipR.z -= w * T.motionIdleShiftAmp * 0.6;
        out.shoulderL.x += wq * T.motionIdleArmAmp;
        out.shoulderR.x -= wq * T.motionIdleArmAmp;
      }
    }

    // --- head look ------------------------------------------------------------
    // Toward the anchor while a line is out (OBSERVED: the head tracks the line
    // in the SWING/WEB_ATTACH frames), and up the facade while climbing.
    let wantYaw = 0;
    if (p.anchorPosition && (state === 'SWING' || state === 'WEB_ATTACH')) {
      const dx = p.anchorPosition.x - p.position.x;
      const dz = p.anchorPosition.z - p.position.z;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      // world -> body space is the INVERSE yaw: R(-yaw)·d
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      wantYaw = Math.max(-T.motionHeadYawMax, Math.min(T.motionHeadYawMax, Math.atan2(lx, lz)));
    }
    this.headYaw += (wantYaw - this.headYaw) * Math.min(1, T.motionHeadRate * dt);
    out.head.y += this.headYaw;

    // --- wall-run climb layer -------------------------------------------------
    // OBSERVED wall runs are lateral sprints along a facade; a near-vertical
    // ascent is the same stride with the body squared up to the wall and the
    // arms reaching, so the climb is a LAYER on the one run cycle rather than a
    // second locomotion animation (the hero has exactly one, and it is the run).
    const wantClimb = state === 'WALL_RUN'
      ? clamp01(p.velocity.y / T.motionClimbRefVy)
      : 0;
    this.climb += (wantClimb - this.climb) * Math.min(1, T.motionClimbRate * dt);
    if (this.climb > 0.001) {
      out.body.x -= T.motionClimbPitch * this.climb;
      out.shoulderL.x -= T.motionClimbReach * this.climb;
      out.shoulderR.x -= T.motionClimbReach * this.climb;
      out.head.x -= T.motionClimbHeadUp * this.climb;
    }

    // --- limb trail + hand settle --------------------------------------------
    // Only while untethered. On the ground the run cycle is the motion and
    // adding lag to it would dilute exactly the animation the owner protected.
    if (!running && isAirborneState(state)) {
      const trail = Math.max(
        -T.motionTrailMax,
        Math.min(T.motionTrailMax, this.yawRate * T.motionTrailGain),
      );
      out.shoulderL.z += trail;
      out.shoulderR.z += trail;
      out.hipL.z += trail * 0.4;
      out.hipR.z += trail * 0.4;
      // The elbows arrive and settle instead of sliding into place.
      out.elbowL = this.springL.step(out.elbowL, dt, T.motionSettleFreq, T.motionSettleDamping);
      out.elbowR = this.springR.step(out.elbowR, dt, T.motionSettleFreq, T.motionSettleDamping);
    } else {
      // Keep the springs primed on the live target so re-entering the air does
      // not fire a wobble from wherever the arm was seconds ago.
      this.springL.step(out.elbowL, dt, T.motionSettleFreq, 1);
      this.springR.step(out.elbowR, dt, T.motionSettleFreq, 1);
    }
  }

  /** Diagnostics for `__GAUNTLET__.characterStats().motion`. */
  report(p: PlayerSnapshot): MotionReport {
    const family = POSE_VARIANTS[p.state];
    return {
      state: p.state,
      visit: this.visits.get(p.state) ?? 0,
      variant: family ? (MotionController.pinned ?? this.variant) % family.length : 0,
      variants: family ? family.length : 1,
      partner: this.lastDrive.partner,
      drive: +this.lastDrive.strength.toFixed(3),
      entry: +this.lastEntry.toFixed(3),
      flip: {
        kind: this.flip.kind,
        turns: this.flip.turns,
        t: +this.flip.t.toFixed(3),
        pitchDeg: +(this.flip.pitch * 180 / Math.PI).toFixed(1),
        rollDeg: +(this.flip.roll * 180 / Math.PI).toFixed(1),
        cork: this.flip.cork,
      },
      climb: +this.climb.toFixed(3),
      headYawDeg: +(this.headYaw * 180 / Math.PI).toFixed(1),
      blendRate: +this.lastBlend.toFixed(2),
      seed: this.seed,
    };
  }
}
