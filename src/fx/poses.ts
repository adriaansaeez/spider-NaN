import type { PlayerSnapshot, TraversalState } from '../contracts';

/**
 * OWNED BY: feel-builder.
 *
 * The hand-authored pose library, shared by BOTH character representations:
 * the procedural box figure (PlayerFigure) and the authored skinned model
 * (CharacterModel). It was originally inlined in PlayerFigure and was validated
 * by independent critics as state-readable, so the skinned model reuses it
 * verbatim rather than inventing a second, unproven animation set.
 *
 * A pose is a set of JOINT DIRECTIONS, not a set of bone rotations. That is why
 * it can drive two completely different rigs: the box figure applies the eulers
 * directly (its limbs rest pointing -Y), and the skinned model converts each
 * joint's euler into a body-space limb direction and points the corresponding
 * Mixamo bone at it (see CharacterModel.solve).
 */

export interface EulerTarget { x: number; y: number; z: number }

const ZERO: EulerTarget = { x: 0, y: 0, z: 0 };

export interface Pose {
  body: EulerTarget;
  head: EulerTarget;
  shoulderL: EulerTarget;
  elbowL: number;
  shoulderR: EulerTarget;
  elbowR: number;
  hipL: EulerTarget;
  kneeL: number;
  hipR: EulerTarget;
  kneeR: number;
  /**
   * ANKLE — the foot direction (ankle -> toe tip) measured FROM THE SHIN, in the
   * same sign convention as every other `.x` in this file:
   *
   *   0        the foot continues the shin exactly (a fully pointed toe)
   *   positive tips the toe BEHIND the body, i.e. further round in the same
   *            direction hip/knee flex already turn the limb
   *   negative tips the toe in FRONT of the body
   *
   * Optional on purpose. Before this channel existed the ankle was not driven at
   * all, so a pose that does not author feet must keep exactly the silhouette it
   * shipped with: `ankleOf()` below supplies `ANKLE_REST`, the natural standing
   * foot, for every pose that stays silent. Only author a value where the FEET
   * are part of the read.
   */
  ankleL?: number;
  ankleR?: number;
}

/**
 * The foot a pose gets when it does not ask for one: roughly perpendicular to
 * the shin, toe in front, which is where a standing/relaxed foot sits.
 *
 * MEASURED, not guessed: -1.155 rad (-66.2 degrees) is the shipped GLB's OWN
 * bind angle, from LeftLeg->LeftFoot to LeftFoot->LeftToeBase, read out of the
 * running game (`characterStats().ankle.bind` exists so this constant can be
 * checked rather than trusted). Matching the bind is what makes switching the
 * ankle channel on a NO-OP for every state that does not author feet.
 */
export const ANKLE_REST = -1.155;

/** A pose's ankle for one side, with the neutral default applied. */
export function ankleOf(p: Pose, side: 'L' | 'R'): number {
  const v = side === 'L' ? p.ankleL : p.ankleR;
  return v ?? ANKLE_REST;
}

/**
 * All angles are radians and every one of them is expressed in BODY-LOCAL
 * space — the limb pivots are children of the torso, so a pose reads the same
 * however far the torso is pitched.
 *
 *   body.x     0 = upright, +1.57 = torso horizontal head-forward, +3.14 = inverted
 *   limb .x    + tips the limb BEHIND the body (-Z), - tips it in FRONT (+Z)
 *   limb .z    tips the limb sideways; armL/legL sit at -X so their outward
 *              direction is NEGATIVE z, armR/legR's outward is POSITIVE z
 *   elbow/knee + flexes the joint backward
 *
 * These were re-authored in iteration 3: the previous set was tuned by eye
 * against a rig whose limbs were parented to the root instead of the torso, so
 * the numbers were compensating for a bug rather than describing a body.
 * Poses stay deliberately exaggerated so states read as silhouettes.
 */
export const POSES: Record<TraversalState, Pose> = {
  // upright, arms relaxed at the sides
  IDLE: {
    body: { x: 0.03, y: 0, z: 0 },
    head: ZERO, shoulderL: { x: 0.05, y: 0, z: -0.14 }, elbowL: 0.18,
    shoulderR: { x: 0.05, y: 0, z: 0.14 }, elbowR: 0.18,
    hipL: { x: 0, y: 0, z: -0.04 }, kneeL: 0.05,
    hipR: { x: 0, y: 0, z: 0.04 }, kneeR: 0.05,
  },
  // Mid-stride run, the phase-0 key of the run cycle below. Kept as the LANDED
  // entry so the Record stays total and anything sampling POSES directly still
  // gets a running silhouette, but ground locomotion goes through
  // MotionController (./motion.ts), which returns the ANIMATED run cycle
  // instead of this still.
  LANDED: {
    body: { x: 0.22, y: 0, z: 0 },
    head: { x: -0.12, y: 0, z: 0 },
    shoulderL: { x: -0.55, y: 0, z: -0.18 }, elbowL: 0.85,
    shoulderR: { x: 0.6, y: 0, z: 0.18 }, elbowR: 0.7,
    hipL: { x: -0.5, y: 0, z: -0.05 }, kneeL: 0.55,
    hipR: { x: 0.45, y: 0, z: 0.05 }, kneeR: 0.2,
  },
  // head-first dive: an arrow, arms swept tight to the flanks
  FALLING: {
    body: { x: 1.5, y: 0, z: 0 },
    head: { x: -0.42, y: 0, z: 0 },
    shoulderL: { x: 0.4, y: 0, z: -0.24 }, elbowL: 0.15,
    shoulderR: { x: 0.4, y: 0, z: 0.24 }, elbowR: 0.15,
    hipL: { x: -0.08, y: 0, z: -0.07 }, kneeL: 0.12,
    hipR: { x: -0.08, y: 0, z: 0.07 }, kneeR: 0.12,
  },
  // coiled the instant the line bites: knees drawn up, free arm cocked back
  WEB_ATTACH: {
    body: { x: 0.8, y: 0, z: 0 },
    head: { x: -0.32, y: 0, z: 0 },
    shoulderL: { x: -1.5, y: 0, z: -0.3 }, elbowL: 0.5,
    shoulderR: { x: 0.95, y: 0, z: 0.5 }, elbowR: 0.45,
    hipL: { x: -0.75, y: 0, z: -0.12 }, kneeL: 1.05,
    hipR: { x: -0.6, y: 0, z: 0.12 }, kneeR: 0.9,
  },
  // hanging into the arc: torso pitched forward, legs trailing and split,
  // free arm streaming behind. Grip arm is driven by the anchor quaternion.
  // SWING family member 0 — THE SCISSOR. Re-authored in iteration 2 for
  // silhouette separation (see POSE_VARIANTS below): the legs are thrown into a
  // full split, one driven forward and one trailing hard behind, and the free
  // arm streams back and OUT rather than sitting mirrored against the grip arm.
  // At a 40-80 px hero the read is a long diagonal with a wide V under it.
  SWING: {
    body: { x: 1.1, y: 0, z: 0 },
    head: { x: -0.5, y: 0, z: 0 },
    shoulderL: { x: 1.35, y: 0, z: -0.78 }, elbowL: 0.3,
    shoulderR: { x: 0.95, y: 0, z: 0.4 }, elbowR: 0.6,
    hipL: { x: 1.05, y: 0, z: -0.24 }, kneeL: 0.3,
    hipR: { x: -0.8, y: 0, z: 0.26 }, kneeR: 1.35,
  },
  // let go: arms flung wide and back, legs kicking forward
  RELEASE: {
    body: { x: 0.95, y: 0, z: 0 },
    head: { x: -0.35, y: 0, z: 0 },
    shoulderL: { x: 0.7, y: 0, z: -1.05 }, elbowL: 0.2,
    shoulderR: { x: 0.7, y: 0, z: 1.05 }, elbowR: 0.2,
    hipL: { x: -0.55, y: 0, z: -0.15 }, kneeL: 0.3,
    hipR: { x: -0.55, y: 0, z: 0.15 }, kneeR: 0.3,
  },
  // belly-down glide: the big X
  AIRBORNE: {
    body: { x: 1.55, y: 0, z: 0 },
    head: { x: -0.45, y: 0, z: 0 },
    shoulderL: { x: 0.12, y: 0, z: -1.22 }, elbowL: 0.4,
    shoulderR: { x: 0.12, y: 0, z: 1.22 }, elbowR: 0.4,
    hipL: { x: 0.18, y: 0, z: -0.42 }, kneeL: 0.28,
    hipR: { x: 0.18, y: 0, z: 0.42 }, kneeR: 0.28,
    // THE FEET. Authored here and nowhere else in this file: every other state
    // stays on ANKLE_REST and keeps the silhouette it shipped with. 0 would put
    // the foot exactly along the shin; +0.175 (10 degrees) carries the toe that
    // little bit further round, so at the ankle there is a deliberate break in
    // the line instead of the leg simply continuing into a foot. Chosen against
    // the running game at 0, +-10 and +20 degrees: -10 droops, +20 kicks past
    // the leg into hyperextension, +10 is the diver's pointed toe.
    ankleL: 0.175, ankleR: 0.175,
  },
  // dash throw: right arm locked straight ahead along travel (the web hand),
  // left arm streamed back so the silhouette reads as a one-handed snap throw
  // rather than a symmetric Superman — the cosmetic strand in FxSystem grows
  // from gripHandR along normalize(velocity).
  DASH: {
    body: { x: 1.62, y: 0, z: 0 },
    head: { x: -0.22, y: 0, z: 0 },
    shoulderL: { x: 0.85, y: 0, z: -0.55 }, elbowL: 0.55,
    shoulderR: { x: -1.95, y: 0, z: 0.06 }, elbowR: 0,
    hipL: { x: 0.1, y: 0, z: -0.04 }, kneeL: 0.08,
    hipR: { x: 0.05, y: 0, z: 0.04 }, kneeR: 0.05,
  },
  // near-upright against the facade, one arm reaching, legs in a wide stride
  WALL_RUN: {
    body: { x: 0.25, y: 0, z: 0 },
    head: { x: -0.25, y: 0, z: 0 },
    shoulderL: { x: -1.55, y: 0, z: -0.2 }, elbowL: 0.45,
    shoulderR: { x: 0.9, y: 0, z: 0.28 }, elbowR: 0.3,
    hipL: { x: -0.95, y: 0, z: -0.1 }, kneeL: 1.5,
    hipR: { x: 0.8, y: 0, z: 0.1 }, kneeR: 0.15,
  },
  // compact crouch on a ledge: knees folded under, hands planted forward
  PERCH: {
    body: { x: 0.62, y: 0, z: 0 },
    head: { x: -0.5, y: 0, z: 0 },
    shoulderL: { x: -0.5, y: 0, z: -0.3 }, elbowL: 1.25,
    shoulderR: { x: -0.5, y: 0, z: 0.3 }, elbowR: 1.25,
    hipL: { x: -1.45, y: 0, z: -0.2 }, kneeL: 2.15,
    hipR: { x: -1.45, y: 0, z: 0.2 }, kneeR: 2.15,
  },
};

// ---------------------------------------------------------------------------
// POSE VARIANTS — a FAMILY per state, not one pose per state
//
// `POSES` above holds exactly one target per state, and that single fact is why
// the hero could not feel alive: every swing was the same swing, every fall the
// same fall. Each entry below adds sibling poses for the same state, so a visit
// can start from a different silhouette and MOVE between siblings as the physics
// changes. Selection and blending live in ./motion.ts; this file stays data.
//
// SOURCING. Every variant is traced to a specific claim in
// reference-pack-2/STATES.md, which was classified from real gameplay capture
// (261 frames), and the frames were opened. The tag on each variant says which:
//   OBSERVED  — the pose is described in STATES.md for that state and is visible
//               in frames/<STATE>/.
//   INFERRED  — a plausible in-between the reference does not show directly.
// IDLE has ZERO reference frames and LANDED has zero, so neither gets a variant
// family invented for it: IDLE keeps its single authored pose (plus the breathing
// layer in motion.ts, tagged INFERRED there) and LANDED stays the run cycle.
//
// Index 0 of every family IS the pose in `POSES`, so nothing that reads POSES
// directly changes behaviour and the previously-validated silhouettes survive.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE SWING FAMILY — three SILHOUETTES, not three sets of joint angles
//
// Iteration 1 authored these as three sensible swing poses and the animation
// critic's verdict was that all three read the same in the chase camera. He was
// right, and the reason is a scale argument the numbers hide: at a 40-80 px hero
// the viewer has no access to elbow flexion or a 17-degree difference of torso
// pitch. What survives at that size is the OUTLINE — how much area the body
// covers, whether the limbs project or fold, and whether the shape is symmetric.
//
// So the three members are now separated on exactly that axis, and named for it:
//
//   0 SCISSOR — a long diagonal, legs split wide fore-and-aft, arms asymmetric.
//   1 CANNONBALL — a small dense ball, no limb leaving the body outline.
//   2 LAYOUT — a long straight inverted bar with arms out wide: a cross.
//
// Ball vs bar vs diagonal is a difference you can read from a thumbnail, which
// is the only test that matters here. Nothing about this costs a polygon, a
// texture, a pixel of resolution or a pass of post: it is the same rig in three
// shapes. See also FX_TUNING.motionSwingDriveAuthority, which stops the physics
// drive collapsing all three back into one.
// ---------------------------------------------------------------------------

/**
 * SWING variant 1 — CANNONBALL (was NADIR TUCK). OBSERVED: "Legs: staggered
 * run-in-air — one knee high toward chest"; prior pack: "SWING NADIR — compact
 * tuck near street; high tension silhouette". This is the bottom of the arc,
 * where the body folds, and it is now folded far enough to change the hero's
 * AREA on screen rather than only his joint angles: knees to the chest, arms
 * wrapped in, nothing projecting.
 */
const SWING_NADIR: Pose = {
  body: { x: 1.6, y: 0, z: 0 },
  head: { x: -0.72, y: 0, z: 0 },
  shoulderL: { x: -0.3, y: 0, z: -0.22 }, elbowL: 2.3,
  shoulderR: { x: -0.3, y: 0, z: 0.22 }, elbowR: 2.3,
  hipL: { x: -1.55, y: 0, z: -0.14 }, kneeL: 2.35,
  hipR: { x: -1.45, y: 0, z: 0.14 }, kneeR: 2.25,
};

/**
 * SWING variant 2 — LAYOUT, inverted (was HIGH ARC). OBSERVED: "Occasional
 * inverted / high-arc poses with web still attached" (STATES.md), and the prior
 * pack's "body often inverted or semi-inverted; legs tucked or split for
 * balance". body.x past 90 degrees is the whole point: the legs come up over the
 * torso. Iteration 2 straightens it into a LINE — legs together and extended,
 * knees nearly locked, arms held out square — so the silhouette is a long bar
 * with a crossbar, the maximum possible contrast against the cannonball.
 */
const SWING_HIGH: Pose = {
  body: { x: 2.5, y: 0, z: 0 },
  head: { x: -0.6, y: 0, z: 0 },
  shoulderL: { x: 0.95, y: 0, z: -1.4 }, elbowL: 0.05,
  shoulderR: { x: 0.95, y: 0, z: 1.4 }, elbowR: 0.05,
  hipL: { x: 0.16, y: 0, z: -0.05 }, kneeL: 0.06,
  hipR: { x: 0.16, y: 0, z: 0.05 }, kneeR: 0.06,
};

/**
 * AIRBORNE variant 1 — TUCK. OBSERVED: "Common tuck: knees to chest, arms out
 * for balance, torso near-horizontal".
 */
const AIR_TUCK: Pose = {
  body: { x: 1.25, y: 0, z: 0 },
  head: { x: -0.4, y: 0, z: 0 },
  shoulderL: { x: 0.25, y: 0, z: -0.85 }, elbowL: 1.1,
  shoulderR: { x: 0.25, y: 0, z: 0.85 }, elbowR: 1.1,
  hipL: { x: -1.05, y: 0, z: -0.3 }, kneeL: 1.9,
  hipR: { x: -1.0, y: 0, z: 0.3 }, kneeR: 1.85,
  // NO pointed toe here, deliberately: this is the knees-to-chest tuck, and the
  // whole point of it is a compact ball with nothing projecting. A diver's foot
  // on a folded leg would put two spikes back out through the outline it exists
  // to keep clean, and it is not what a body does when it curls up. Left on
  // ANKLE_REST, which is what it has always rendered with.
};

/**
 * AIRBORNE variant 2 — WING GLIDE. OBSERVED: "arms abducted, translucent
 * underarm membranes taut, legs trailing slightly bent; body parallel to
 * ground". We render no membranes (retro low-poly identity, no new geometry) —
 * this is the SKELETAL pose of that glide only.
 */
const AIR_WING: Pose = {
  body: { x: 1.6, y: 0, z: 0 },
  head: { x: -0.5, y: 0, z: 0 },
  shoulderL: { x: 0.05, y: 0, z: -1.45 }, elbowL: 0.08,
  shoulderR: { x: 0.05, y: 0, z: 1.45 }, elbowR: 0.08,
  hipL: { x: 0.35, y: 0, z: -0.28 }, kneeL: 0.35,
  hipR: { x: 0.35, y: 0, z: 0.28 }, kneeR: 0.35,
  // The same trailing-leg glide as AIRBORNE, so the same foot.
  ankleL: 0.175, ankleR: 0.175,
};

/**
 * FALLING variant 1 — SKYDIVE ARCH. OBSERVED: "belly-down skydive arch — arms
 * abducted ~T or wide V, legs tucked or trailing with knee flexion".
 */
const FALL_ARCH: Pose = {
  body: { x: 1.6, y: 0, z: 0 },
  head: { x: -0.55, y: 0, z: 0 },
  shoulderL: { x: -0.35, y: 0, z: -1.0 }, elbowL: 0.75,
  shoulderR: { x: -0.35, y: 0, z: 1.0 }, elbowR: 0.75,
  hipL: { x: 0.55, y: 0, z: -0.35 }, kneeL: 0.85,
  hipR: { x: 0.55, y: 0, z: 0.35 }, kneeR: 0.85,
};

/**
 * FALLING variant 2 — TIP-OFF. OBSERVED: "body tips forward off the ledge into a
 * head-down or belly-down descent" — the first beat of a leave-perch dive, before
 * the arch opens. Arms still swept back, legs still folded from the crouch.
 */
const FALL_TIP: Pose = {
  body: { x: 1.35, y: 0, z: 0 },
  head: { x: -0.3, y: 0, z: 0 },
  shoulderL: { x: 0.95, y: 0, z: -0.55 }, elbowL: 0.25,
  shoulderR: { x: 0.95, y: 0, z: 0.55 }, elbowR: 0.25,
  hipL: { x: -0.35, y: 0, z: -0.2 }, kneeL: 1.25,
  hipR: { x: -0.35, y: 0, z: 0.2 }, kneeR: 1.25,
};

/**
 * WEB_ATTACH variant 1 — HIGH LEAD. OBSERVED: "Lead arm snaps upward/forward
 * along the line; opposite arm counter-balances (bent, trailing)"; "legs often
 * asymmetric tuck". For a HIGH anchor. The gripping arm is overridden by the
 * anchor solve in both rigs, so what these variants really author is the FREE
 * arm, the legs and the torso.
 */
const ATTACH_HIGH: Pose = {
  body: { x: 0.6, y: 0, z: 0 },
  head: { x: -0.4, y: 0, z: 0 },
  shoulderL: { x: -1.85, y: 0, z: -0.12 }, elbowL: 0.25,
  shoulderR: { x: 1.3, y: 0, z: 0.35 }, elbowR: 0.85,
  hipL: { x: -0.95, y: 0, z: -0.14 }, kneeL: 1.35,
  hipR: { x: 0.35, y: 0, z: 0.14 }, kneeR: 0.25,
};

/**
 * WEB_ATTACH variant 2 — FORWARD LEAD. OBSERVED at `00:97`: "web rising from a
 * rooftop corner while body is already airborne" — the anchor is low/level, so
 * the lead arm goes forward rather than overhead and the torso stays pitched
 * into travel.
 */
const ATTACH_FWD: Pose = {
  body: { x: 1.05, y: 0, z: 0 },
  head: { x: -0.28, y: 0, z: 0 },
  shoulderL: { x: -1.05, y: 0, z: -0.45 }, elbowL: 0.2,
  shoulderR: { x: 0.7, y: 0, z: 0.6 }, elbowR: 0.9,
  hipL: { x: -0.45, y: 0, z: -0.15 }, kneeL: 0.8,
  hipR: { x: -0.2, y: 0, z: 0.15 }, kneeR: 1.4,
};

/**
 * RELEASE variant 1 — SWING RESIDUAL. OBSERVED: "Body still carries swing
 * asymmetry (one arm high/forward residual, staggered legs) rather than a
 * settled skydive arch". POSES.RELEASE is the flung-wide instant; this is the
 * half-second after it, and motion.ts drives from one to the other on stateTime.
 */
const RELEASE_RESIDUAL: Pose = {
  body: { x: 1.1, y: 0, z: 0 },
  head: { x: -0.42, y: 0, z: 0 },
  shoulderL: { x: -1.25, y: 0, z: -0.35 }, elbowL: 0.3,
  shoulderR: { x: 0.85, y: 0, z: 0.5 }, elbowR: 0.5,
  hipL: { x: 0.5, y: 0, z: -0.2 }, kneeL: 0.9,
  hipR: { x: -0.45, y: 0, z: 0.2 }, kneeR: 0.35,
};

/**
 * DASH variant 1 — STREAMED. OBSERVED: "Natural arms tucked; legs streamed
 * together; torso aimed at travel direction". POSES.DASH is the throw instant
 * (the frame the cosmetic strand leaves the hand); this is what the body settles
 * into once the burst is carrying it.
 */
const DASH_STREAM: Pose = {
  body: { x: 1.66, y: 0, z: 0 },
  head: { x: -0.15, y: 0, z: 0 },
  shoulderL: { x: 0.5, y: 0, z: -0.1 }, elbowL: 1.6,
  shoulderR: { x: 0.5, y: 0, z: 0.1 }, elbowR: 1.6,
  hipL: { x: 0.06, y: 0, z: -0.02 }, kneeL: 0.04,
  hipR: { x: 0.06, y: 0, z: 0.02 }, kneeR: 0.04,
};

/**
 * PERCH variant 1 — LOOKOUT. OBSERVED: "Deep crouch… knees pulled high toward
 * the chest; arms tucked between/against the knees; hands near the ledge for
 * balance… head pitched slightly down toward the city". Deeper than variant 0,
 * with one hand planted and the head turned along the skyline.
 */
const PERCH_LOOKOUT: Pose = {
  body: { x: 0.72, y: 0, z: 0 },
  head: { x: -0.6, y: 0.25, z: 0 },
  shoulderL: { x: -0.75, y: 0, z: -0.22 }, elbowL: 1.0,
  shoulderR: { x: -0.35, y: 0, z: 0.34 }, elbowR: 1.6,
  hipL: { x: -1.55, y: 0, z: -0.26 }, kneeL: 2.3,
  hipR: { x: -1.4, y: 0, z: 0.16 }, kneeR: 2.05,
};

/**
 * The variant family per state. Index 0 is always `POSES[state]`.
 *
 * WALL_RUN and LANDED are absent on purpose: both are the RUN CYCLE, which is
 * already a continuous motion rather than a still, and the owner's standing rule
 * is that Run is the only ground locomotion clip. Wall running gets its variation
 * from the climb layer in motion.ts (arms reaching as the ascent steepens), not
 * from a second pose family. IDLE is absent because the reference pack has zero
 * IDLE frames and nothing here is going to be invented and called observed.
 */
export const POSE_VARIANTS: Partial<Record<TraversalState, Pose[]>> = {
  SWING: [POSES.SWING, SWING_NADIR, SWING_HIGH],
  AIRBORNE: [POSES.AIRBORNE, AIR_TUCK, AIR_WING],
  FALLING: [POSES.FALLING, FALL_ARCH, FALL_TIP],
  WEB_ATTACH: [POSES.WEB_ATTACH, ATTACH_HIGH, ATTACH_FWD],
  RELEASE: [POSES.RELEASE, RELEASE_RESIDUAL],
  DASH: [POSES.DASH, DASH_STREAM],
  PERCH: [POSES.PERCH, PERCH_LOOKOUT],
};

// ---------------------------------------------------------------------------
// THE RUN CYCLE — the hero's ONE locomotion animation
//
// Owner rule: the character runs, and only runs. There is no walk, and nothing
// on the ground may degrade into something that READS as a walk. Two things
// used to break that rule and both are fixed here and at the two call sites:
//
//  1. LANDED was a STILL pose. A frozen mid-stride does not read as running at
//     all — at best it reads as a mannequin being slid along the street. So
//     ground locomotion is now a real cycle, sampled from a phase clock.
//  2. A cycle whose rate follows speed all the way down turns into a walk on
//     its own, because a run played slowly IS a walk. `advanceRunPhase` clamps
//     the stride rate to a floor well above walking cadence, so slowing down
//     shortens the stride, never the character's intent.
//
// The same cycle drives WALL_RUN: the owner asked for the same run animation on
// the facade, with the hips shifted toward the wall. The hip shift is not part
// of the pose (a pose is joint DIRECTIONS, and a hip shift is a TRANSLATION) —
// each rig applies it itself, off `wallSideOf` below.
// ---------------------------------------------------------------------------

/** Hip/leg swing amplitude, radians. A run is a big-amplitude gait. */
const RUN_HIP_SWING = 0.86;
const RUN_KNEE_BASE = 0.22;
/** Extra knee fold on the trailing leg — the heel-up recovery that says "run". */
const RUN_KNEE_FOLD = 1.45;
const RUN_ARM_SWING = 0.92;
const RUN_ELBOW_BASE = 1.12;
const RUN_ELBOW_PUMP = 0.34;
/** Forward lean. More than a walk's; a sprint drives from a pitched torso. */
const RUN_BODY_PITCH = 0.3;
const RUN_BODY_PITCH_BOB = 0.05;
const RUN_HEAD_PITCH = -0.2;
/** Constant lateral splay, so the limbs clear the torso. */
const RUN_LEG_SPLAY = 0.05;
const RUN_ARM_SPLAY = 0.16;

/** Vertical bob of the whole body over one stride, metres. */
const RUN_BOB = 0.055;

/** Reused output buffer — sampling the cycle must not allocate per frame. */
const runOut: Pose = {
  body: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0, z: 0 },
  shoulderL: { x: 0, y: 0, z: 0 }, elbowL: 0,
  shoulderR: { x: 0, y: 0, z: 0 }, elbowR: 0,
  hipL: { x: 0, y: 0, z: 0 }, kneeL: 0,
  hipR: { x: 0, y: 0, z: 0 }, kneeR: 0,
};

/**
 * The run cycle at `phase` (in turns; only the fraction matters).
 *
 * Sign conventions are the library's: limb `.x` positive tips the limb BEHIND
 * the body, negative in FRONT. So `hipL.x = -A·sin` puts the left leg forward
 * on the first half of the stride, and the arms take the opposite sign, which
 * is the contralateral swing every gait has.
 */
export function sampleRunCycle(phase: number): Pose {
  const a = phase * Math.PI * 2;
  const s = Math.sin(a);
  const out = runOut;

  out.body.x = RUN_BODY_PITCH + RUN_BODY_PITCH_BOB * Math.cos(a * 2);
  out.body.y = 0;
  out.body.z = 0;
  out.head.x = RUN_HEAD_PITCH;
  out.head.y = 0;
  out.head.z = 0;

  // legs: opposed, knee folded on whichever leg is trailing
  out.hipL.x = -RUN_HIP_SWING * s;
  out.hipL.y = 0;
  out.hipL.z = -RUN_LEG_SPLAY;
  out.kneeL = RUN_KNEE_BASE + RUN_KNEE_FOLD * (0.5 - 0.5 * s);
  out.hipR.x = RUN_HIP_SWING * s;
  out.hipR.y = 0;
  out.hipR.z = RUN_LEG_SPLAY;
  out.kneeR = RUN_KNEE_BASE + RUN_KNEE_FOLD * (0.5 + 0.5 * s);

  // arms: contralateral to the legs, elbows held high and pumping
  out.shoulderL.x = RUN_ARM_SWING * s;
  out.shoulderL.y = 0;
  out.shoulderL.z = -RUN_ARM_SPLAY;
  out.elbowL = RUN_ELBOW_BASE + RUN_ELBOW_PUMP * s;
  out.shoulderR.x = -RUN_ARM_SWING * s;
  out.shoulderR.y = 0;
  out.shoulderR.z = RUN_ARM_SPLAY;
  out.elbowR = RUN_ELBOW_BASE - RUN_ELBOW_PUMP * s;

  return out;
}

/** Vertical bob of the body at `phase`, metres. Two beats per stride. */
export function runBob(phase: number): number {
  return RUN_BOB * (0.5 - 0.5 * Math.cos(phase * Math.PI * 4));
}

/**
 * Advance the run phase clock. `hz` is the stride rate, which follows ground
 * speed between a FLOOR and a ceiling — the floor is the whole point: below it
 * the cycle would read as a walk, which the hero does not do.
 */
export function advanceRunPhase(
  phase: number, speed: number, dt: number,
  refSpeed: number, minHz: number, maxHz: number,
): number {
  const hz = Math.min(maxHz, Math.max(minHz, (speed / Math.max(0.001, refSpeed)) * maxHz));
  return (phase + hz * dt) % 1;
}

// ---------------------------------------------------------------------------
// WHICH SIDE IS THE WALL ON
//
// Derived from the SURFACE the body is running on, never from camera yaw. The
// camera can be looking anywhere while the body runs along a facade, and the
// camera-relative `lean` the traversal system publishes measures 0.02..0.15
// through a real wall run — it carries no side information at all.
//
// The frozen PlayerSnapshot does not publish the facade normal, so `WallTracker`
// RECOVERS it from the snapshot's own motion. Two facts make that exact enough:
//
//   1. WHILE running, the traversal system zeroes velocity's component along the
//      wall normal every frame. So the horizontal velocity lies IN the wall
//      plane and its horizontal perpendicular IS the normal's axis — direction
//      known, sign not.
//   2. AT ENTRY, the run only started because the body was flying INTO the
//      facade. The last horizontal velocity before contact therefore points
//      inward, which settles the sign: the outward normal is the candidate axis
//      whose dot with that incoming velocity is negative.
//
// The two inputs degrade in opposite directions and cover for each other: a
// glancing hit gives a strong tangential velocity (fact 1 is sharp) and a
// head-on hit — the kind that produces a vertical climb, where the horizontal
// velocity nearly vanishes — gives an incoming vector that IS the inward normal
// to within a few degrees, so fact 2 alone carries it.
//
// If the traversal system ever publishes an exact `wallNormal`, it is read as an
// OPTIONAL snapshot extension and supersedes the estimate with no other change.
// ---------------------------------------------------------------------------

/** Optional snapshot extension: the exact facade normal, if it is ever published. */
export interface WallContact {
  /** Outward normal of the facade being run on; null unless WALL_RUN. */
  wallNormal?: { x: number; y: number; z: number } | null;
}

export type WallAwareSnapshot = PlayerSnapshot & WallContact;

/**
 * Debug A/B handle for the wall-run hip offset, exposed as
 * `__GAUNTLET__.setWallRunShiftScale(0|1)`. The offset is small by design, so
 * the honest way to show it is the same wall run captured with it off and on;
 * this makes that a one-call comparison instead of a rebuild. Ships at 1.
 */
export const wallRunDebug = { scale: 1 };

/**
 * A/B handle for the ankle work, mirrored onto
 * `__GAUNTLET__.setAnkleRollScale(0|1)`.
 *
 *   `drive` 0 leaves the foot bones exactly as they were before this channel
 *           existed — undriven, taking whatever the shipped clip and the
 *           accumulated leg rotation hand them. That is the BEFORE picture.
 *   `roll`  0 aims the foot at its authored direction but leaves the roll about
 *           that direction as the minimal arc, which is the twist itself.
 *
 * Both ship at 1. They exist because "the ankle is no longer twisted" is a
 * claim about two frames of the same build, and without a switch the only way
 * to produce the other frame is to rebuild.
 */
export const ankleRollDebug = { drive: 1, roll: 1 };

/** Horizontal speed below which a velocity carries no usable direction. */
const WALL_DIR_EPS = 1.5;
/**
 * Horizontal speed (m/s) above which the in-plane velocity's perpendicular is
 * the better estimate of the facade's axis than the approach vector is.
 *
 * THE SWITCH IS ON SPEED, NOT ON AGREEMENT between the two estimates. An earlier
 * version fell back to the approach vector whenever the two disagreed, on the
 * theory that disagreement meant noise. That is exactly backwards: a GLANCING
 * hit has an approach nearly parallel to the wall, so the two legitimately
 * disagree and the perpendicular is the good one. Measured in the running game,
 * a 34 m/s lateral run tripped that fallback on a dot product of 0.249 and
 * placed the wall 76 degrees off, turning the body — and the hips — the wrong
 * way for the whole run.
 */
const WALL_AXIS_MIN_SPEED = 6;

/**
 * Recovers and holds the outward horizontal normal of the facade being run on.
 * One instance per rig; fed the snapshot every frame, including the frames
 * BEFORE the wall run, which is where the sign comes from.
 */
export class WallTracker {
  /** Outward normal, horizontal and unit length. Null when not wall running. */
  private nx = 0;
  private nz = 0;
  private has = false;
  /** Last horizontal velocity seen off the wall — the approach that hit it. */
  private inX = 0;
  private inZ = 0;
  /** Set once per run: the plane does not turn under the player mid-run. */
  private locked = false;

  update(p: WallAwareSnapshot): void {
    if (p.state !== 'WALL_RUN') {
      const len = Math.hypot(p.velocity.x, p.velocity.z);
      if (len > WALL_DIR_EPS) { this.inX = p.velocity.x / len; this.inZ = p.velocity.z / len; }
      this.has = false;
      this.locked = false;
      return;
    }

    // Exact, if the contract ever carries it.
    const exact = p.wallNormal;
    if (exact) {
      const len = Math.hypot(exact.x, exact.z);
      if (len > 1e-4) { this.nx = exact.x / len; this.nz = exact.z / len; this.has = true; return; }
    }

    if (this.locked) return;
    if (this.inX === 0 && this.inZ === 0) return;

    const vLen = Math.hypot(p.velocity.x, p.velocity.z);
    let ax: number;
    let az: number;
    if (vLen >= WALL_AXIS_MIN_SPEED) {
      // Lateral enough to trust fact 1: the horizontal perpendicular of the
      // in-plane velocity is the facade's axis, to within the accuracy of the
      // velocity itself. The approach only settles which way along it is out.
      ax = p.velocity.z / vLen;
      az = -p.velocity.x / vLen;
      const d = ax * this.inX + az * this.inZ;
      if (d > 0) { ax = -ax; az = -az; }
      // Degenerate only if the approach were exactly parallel to the facade,
      // which cannot have produced a contact. Fall back rather than guess.
      if (Math.abs(d) < 1e-3) { ax = -this.inX; az = -this.inZ; }
    } else {
      // Near-vertical climb: too little horizontal velocity for the axis to
      // mean anything, and a climb comes from a head-on hit, so the approach IS
      // the inward normal to within a few degrees.
      ax = -this.inX;
      az = -this.inZ;
    }
    this.nx = ax;
    this.nz = az;
    this.has = true;
    this.locked = true;
  }

  /**
   * Ease `current` toward `target` the short way round a circle. Entering a
   * wall run can turn the body up to 90 degrees, and setting that in one frame
   * is a visible snap; wall runs are short, so the rate is high.
   */
  static easeYaw(current: number, target: number, dt: number, rate: number): number {
    const d = Math.atan2(Math.sin(target - current), Math.cos(target - current));
    return current + d * Math.min(1, rate * dt);
  }

  /** True when a facade normal is available this frame. */
  get valid(): boolean { return this.has; }
  get x(): number { return this.nx; }
  get z(): number { return this.nz; }

  /**
   * THE TARGET yaw the body should face while wall running: ALONG the facade, in the
   * direction of travel. Without this a climb keeps whatever yaw the approach
   * left behind — pointing straight into the wall — and "shift the hips toward
   * the wall" would shift them forward instead of sideways.
   *
   * Returns null when there is no facade to read, leaving facing to the caller.
   */
  yaw(p: PlayerSnapshot, prevYaw: number): number | null {
    if (!this.has) return null;
    // horizontal tangent of the wall plane: UP x normal
    const tx = this.nz;
    const tz = -this.nx;
    // run along whichever tangent direction travel is going; on a pure vertical
    // climb horizontal velocity vanishes, so keep the tangent we were already on
    let along = p.velocity.x * tx + p.velocity.z * tz;
    if (Math.abs(along) < 0.35) along = Math.sin(prevYaw) * tx + Math.cos(prevYaw) * tz;
    const sign = along < 0 ? -1 : 1;
    return Math.atan2(tx * sign, tz * sign);
  }

  /**
   * Which side of the body the wall is on: +1 = the character's right, -1 = its
   * left, 0 = unknown, in which case no hip offset is applied at all.
   *
   * PASS THE TARGET YAW, not the eased one. Facing the tangent puts the wall at
   * exactly +/-90 degrees, which is the sign boundary: reading the side off a
   * facing that is still turning onto the tangent makes it flicker across that
   * boundary and the hips jitter left/right for the length of the turn.
   */
  side(yaw: number): number {
    if (!this.has) return 0;
    // body right in world space, for a facing of (sin yaw, 0, cos yaw)
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    // the wall lies OPPOSITE its outward normal, so the sign flips
    const d = -(this.nx * rx + this.nz * rz);
    if (Math.abs(d) < 1e-3) return 0;
    return d < 0 ? -1 : 1;
  }
}

// ---------------------------------------------------------------------------
// GROUND WEB PULL — a state the TraversalState union does not have
//
// The two-handed yank that pulls the player off the street is a one-shot MOVE,
// not a state: `PlayerSnapshot.justGroundPull` is true for exactly one frame and
// the state machine is already somewhere else (AIRBORNE / FALLING) by the time
// the body is actually moving. So it is authored as a short OVERLAY timeline
// that runs on its own clock on top of whatever pose the state asks for, and
// fades out.
//
// Three keys, chosen so the move reads in a single frame anywhere in its span:
//   COIL  both hands cocked at the chest, knees loaded — the wind-up
//   THROW both arms fired up and forward together, still on the ground. THIS is
//         the frame that says "two webs", and both arms doing the same thing at
//         once is what distinguishes it from WEB_ATTACH (one arm up, one back).
//   YANK  arms locked overhead, body stretched long, legs trailing — being
//         hauled upward. Nothing else in the library puts both arms overhead.
// ---------------------------------------------------------------------------

const PULL_COIL: Pose = {
  body: { x: 0.34, y: 0, z: 0 },
  head: { x: -0.3, y: 0, z: 0 },
  shoulderL: { x: -1.15, y: 0, z: -0.16 }, elbowL: 1.9,
  shoulderR: { x: -1.15, y: 0, z: 0.16 }, elbowR: 1.9,
  hipL: { x: -0.62, y: 0, z: -0.16 }, kneeL: 1.3,
  hipR: { x: -0.62, y: 0, z: 0.16 }, kneeR: 1.3,
};

const PULL_THROW: Pose = {
  body: { x: 0.1, y: 0, z: 0 },
  head: { x: -0.55, y: 0, z: 0 },
  shoulderL: { x: -2.45, y: 0, z: -0.34 }, elbowL: 0.3,
  shoulderR: { x: -2.45, y: 0, z: 0.34 }, elbowR: 0.3,
  hipL: { x: -0.3, y: 0, z: -0.12 }, kneeL: 0.7,
  hipR: { x: -0.3, y: 0, z: 0.12 }, kneeR: 0.7,
};

const PULL_YANK: Pose = {
  body: { x: -0.14, y: 0, z: 0 },
  head: { x: -0.34, y: 0, z: 0 },
  shoulderL: { x: -3.02, y: 0, z: -0.13 }, elbowL: 0.06,
  shoulderR: { x: -3.02, y: 0, z: 0.13 }, elbowR: 0.06,
  hipL: { x: 0.42, y: 0, z: -0.09 }, kneeL: 0.62,
  hipR: { x: 0.52, y: 0, z: 0.09 }, kneeR: 0.34,
};

/** Seconds each ground-pull key holds until the next one. */
export const PULL_COIL_TIME = 0.09;
export const PULL_THROW_TIME = 0.16;
export const PULL_YANK_TIME = 0.4;
/** Total life of the overlay, including the fade back into the state pose. */
export const PULL_TOTAL = PULL_COIL_TIME + PULL_THROW_TIME + PULL_YANK_TIME;
/** Seconds the overlay spends fading out at the end of PULL_YANK_TIME. */
const PULL_FADE = 0.22;

/** Reused output buffer — sampling the overlay must not allocate per frame. */
const scratchPose: Pose = {
  body: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0, z: 0 },
  shoulderL: { x: 0, y: 0, z: 0 }, elbowL: 0,
  shoulderR: { x: 0, y: 0, z: 0 }, elbowR: 0,
  hipL: { x: 0, y: 0, z: 0 }, kneeL: 0,
  hipR: { x: 0, y: 0, z: 0 }, kneeR: 0,
};

export function lerpE(out: EulerTarget, a: EulerTarget, b: EulerTarget, t: number): void {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
}

/** An all-zero pose buffer. Callers own their buffers; nothing here allocates per frame. */
export function makePoseBuffer(): Pose {
  return {
    body: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0, z: 0 },
    shoulderL: { x: 0, y: 0, z: 0 }, elbowL: 0,
    shoulderR: { x: 0, y: 0, z: 0 }, elbowR: 0,
    hipL: { x: 0, y: 0, z: 0 }, kneeL: 0,
    hipR: { x: 0, y: 0, z: 0 }, kneeR: 0,
    ankleL: ANKLE_REST, ankleR: ANKLE_REST,
  };
}

/** `out = a`, field by field. Never returns a shared library pose to a mutator. */
export function copyPose(out: Pose, a: Pose): Pose {
  return mixPose(out, a, a, 0);
}

export function mixPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  lerpE(out.body, a.body, b.body, t);
  lerpE(out.head, a.head, b.head, t);
  lerpE(out.shoulderL, a.shoulderL, b.shoulderL, t);
  lerpE(out.shoulderR, a.shoulderR, b.shoulderR, t);
  lerpE(out.hipL, a.hipL, b.hipL, t);
  lerpE(out.hipR, a.hipR, b.hipR, t);
  out.elbowL = a.elbowL + (b.elbowL - a.elbowL) * t;
  out.elbowR = a.elbowR + (b.elbowR - a.elbowR) * t;
  out.kneeL = a.kneeL + (b.kneeL - a.kneeL) * t;
  out.kneeR = a.kneeR + (b.kneeR - a.kneeR) * t;
  // Ankles resolve through `ankleOf` on the way in, so a pose that never
  // authored feet blends from the same neutral both rigs use rather than from
  // an undefined that would read as 0 (a fully pointed toe) halfway through.
  const al = ankleOf(a, 'L'); const bl = ankleOf(b, 'L');
  const ar = ankleOf(a, 'R'); const br = ankleOf(b, 'R');
  out.ankleL = al + (bl - al) * t;
  out.ankleR = ar + (br - ar) * t;
  return out;
}

export interface PullSample {
  /** The overlay pose at this instant. */
  pose: Pose;
  /** 0..1 authority the overlay has over the state pose. */
  weight: number;
}

/**
 * Sample the ground-pull overlay `t` seconds after the pull fired. Returns null
 * once the overlay is finished, which is the caller's cue to stop mixing it in.
 * Shared by both rigs so the move looks the same in either character mode.
 */
export function sampleGroundPull(t: number): PullSample | null {
  if (t < 0 || t >= PULL_TOTAL) return null;
  let pose: Pose;
  if (t < PULL_COIL_TIME) {
    // snap into the coil rather than easing: the wind-up should feel struck
    pose = mixPose(scratchPose, PULL_COIL, PULL_THROW, Math.pow(t / PULL_COIL_TIME, 2));
  } else if (t < PULL_COIL_TIME + PULL_THROW_TIME) {
    const u = (t - PULL_COIL_TIME) / PULL_THROW_TIME;
    pose = mixPose(scratchPose, PULL_THROW, PULL_YANK, u * u * (3 - 2 * u));
  } else {
    pose = mixPose(scratchPose, PULL_YANK, PULL_YANK, 0);
  }
  const remaining = PULL_TOTAL - t;
  const weight = remaining < PULL_FADE ? remaining / PULL_FADE : 1;
  return { pose, weight };
}

/** Second buffer: `sampleGroundPull` owns the first one and is still live here. */
const overlayOut: Pose = {
  body: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0, z: 0 },
  shoulderL: { x: 0, y: 0, z: 0 }, elbowL: 0,
  shoulderR: { x: 0, y: 0, z: 0 }, elbowR: 0,
  hipL: { x: 0, y: 0, z: 0 }, kneeL: 0,
  hipR: { x: 0, y: 0, z: 0 }, kneeR: 0,
};

/** Mix an overlay pose over a state pose with the overlay's authority `w`. */
export function applyOverlay(base: Pose, overlay: Pose, w: number): Pose {
  if (w <= 0) return base;
  if (w >= 1) return overlay;
  return mixPose(overlayOut, base, overlay, w);
}

/**
 * Advance a rig's ground-pull clock and return the pose to actually use this
 * frame. `clock` is < 0 when no pull is running. Both rigs share this so the
 * move is timed identically in either character mode.
 */
export function tickGroundPull(
  clock: number, justGroundPull: boolean, dt: number, statePose: Pose,
): { clock: number; pose: Pose; weight: number } {
  let t = justGroundPull ? 0 : clock < 0 ? -1 : clock + dt;
  const sample = t >= 0 ? sampleGroundPull(t) : null;
  if (!sample) {
    t = -1;
    return { clock: t, pose: statePose, weight: 0 };
  }
  return { clock: t, pose: applyOverlay(statePose, sample.pose, sample.weight), weight: sample.weight };
}

// ---------------------------------------------------------------------------

/**
 * What FxSystem needs from a character representation. Both PlayerFigure (the
 * procedural boxes) and CharacterModel (the authored skin) implement it, so the
 * web line, the ground-pull strands and everything else in FxSystem work
 * identically whichever mode is selected.
 */
export interface CharacterRig {
  /** Scene node for the whole character; FxSystem reads its world matrix. */
  readonly root: import('three').Object3D;
  /** Which hand is holding the swing line this frame. */
  readonly gripL: boolean;
  readonly gripR: boolean;
  /** Web-line origins, in the rig's own space. */
  readonly gripHandL: import('three').Object3D;
  readonly gripHandR: import('three').Object3D;
  /**
   * `groundPull` is true for exactly the frame the two-handed pull fires. It is
   * passed explicitly rather than read off the snapshot so FxSystem can also
   * trigger the move from its debug API without writing to another system's
   * snapshot object.
   */
  update(p: PlayerSnapshot, dt: number, groundPull: boolean): void;
  /**
   * Wall-run diagnostics, surfaced through `__GAUNTLET__.characterStats()`.
   * The hip offset is a small translation and it points one of two ways; eyeing
   * a screenshot cannot tell you it went the RIGHT way, so both rigs publish
   * the recovered normal, the side it resolved to and the shift actually
   * applied, and a critic can check them against the geometry.
   */
  wallDebug(): WallDebug;
  /**
   * Motion-layer diagnostics, surfaced through `__GAUNTLET__.characterStats()`.
   * "The hero now varies" is a claim about which of several poses was selected
   * and how far the physics has driven it — none of which a still frame can
   * show — so both rigs publish the visit count, the chosen variant, the drive
   * partner and strength, and the live flip state. A critic can pin a variant,
   * capture, and check the numbers against what it is looking at.
   */
  motionReport(p: PlayerSnapshot): import('./motion').MotionReport;
  dispose(): void;
}

export interface WallDebug {
  /**
   * The pose ACTUALLY on the rig this frame, in radians: hip swing, knee flex
   * and torso pitch. A run is a claim about limbs moving, and the only way to
   * check it without eyeballing a 40-pixel figure is to read the numbers out of
   * the running game across consecutive frames and watch them cycle.
   */
  hipLx: number;
  hipRx: number;
  kneeL: number;
  kneeR: number;
  bodyX: number;
  /**
   * The ankle actually applied this frame, radians, in the `Pose.ankleL`
   * convention (0 = the foot continues the shin, + = toe further behind).
   * Additive: published for the same reason the hip and knee are — the feet are
   * a claim about a joint angle, and a 40-pixel figure cannot settle it.
   */
  ankleL: number;
  ankleR: number;
  /** +1 = wall on the character's right, -1 = left, 0 = unknown. */
  side: number;
  /** Smoothed signed shift, -1..1. Multiply by `wallRunHipShift` for metres. */
  shift: number;
  /** Recovered outward facade normal, horizontal. */
  nx: number;
  nz: number;
  /** Whether a facade normal was available at all this frame. */
  valid: boolean;
  /** Body facing, degrees. */
  yawDeg: number;
  /** Run-cycle phase, 0..1. */
  phase: number;
}
