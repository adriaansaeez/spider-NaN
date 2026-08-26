/**
 * FROZEN CONTRACTS — owned by the lead agent.
 *
 * Builders MUST NOT edit this file. It is the only coupling point between the
 * independently-improvable systems (city, swing/player, camera/fx/input).
 * If you need a change here, send an `ask` to the coordinator instead of editing.
 *
 * Design rule (from spiderman-gauntlet-bibliografia-recursos.md):
 *   the city module owns SPACE and ANCHOR POINTS; the swing module decides
 *   HOW TO MOVE through that space. They talk only through AnchorQuery.
 */
import type { Vector3 } from 'three';

// ---------------------------------------------------------------------------
// City -> Swing
// ---------------------------------------------------------------------------

/** A point on world geometry that a web can attach to. */
export interface Anchor {
  /** World position of the attach point. */
  readonly position: Vector3;
  /** Outward surface normal at the attach point (unit length). */
  readonly normal: Vector3;
  /** Stable id, unique per anchor for the lifetime of its chunk. */
  readonly id: number;
  /** Which structure it belongs to; lets the swing side avoid re-picking a building. */
  readonly structureId: number;
}

export interface AnchorQueryParams {
  /** Player position. */
  origin: Vector3;
  /** Player velocity; used to bias anchors ahead of travel. */
  velocity: Vector3;
  /** Desired lateral bias: -1 hard left, 0 neutral, +1 hard right. */
  lateralBias: number;
  /** Max distance to consider. */
  maxDistance: number;
  /** Anchors below origin.y + minHeightAbove are rejected. */
  minHeightAbove: number;
}

/**
 * The ONLY interface the traversal system may use to learn about the world.
 * Implemented by the city module. Must be cheap enough to call every frame:
 * narrow with a spatial/grid query BEFORE any Raycaster fallback.
 */
export interface AnchorQuery {
  /** Best candidate for an automatic swing attach, or null if none. */
  findSwingAnchor(params: AnchorQueryParams): Anchor | null;
  /** Nearest valid anchor along a ray — used by the targeted dash/zip. */
  raycastAnchor(origin: Vector3, direction: Vector3, maxDistance: number): Anchor | null;
  /** Ground/rooftop height under a world XZ, for nadir clamping and landing. */
  surfaceHeightAt(x: number, z: number): number;
  /** Cheap solid test so traversal can avoid tunnelling through buildings. */
  isSolidAt(point: Vector3): boolean;
}

// ---------------------------------------------------------------------------
// Shared player state — written by swing/player, read by camera/fx/HUD
// ---------------------------------------------------------------------------

export type TraversalState =
  | 'IDLE'
  | 'FALLING'
  | 'WEB_ATTACH'
  | 'SWING'
  | 'RELEASE'
  | 'AIRBORNE'
  | 'DASH'
  | 'WALL_RUN'
  | 'PERCH'
  | 'LANDED';

export interface PlayerSnapshot {
  position: Vector3;
  velocity: Vector3;
  /** Horizontal speed, m/s. Camera/FX drive FOV + blur from this. */
  speed: number;
  state: TraversalState;
  /** Seconds spent in the current state. */
  stateTime: number;
  /** Attach point while SWING/WEB_ATTACH, else null. */
  anchorPosition: Vector3 | null;
  /** Current rope length while swinging, else 0. */
  ropeLength: number;
  /** Signed lean, -1..1, for camera roll and animation. */
  lean: number;
  /** True on the frame a web attaches — one-shot for FX/audio. */
  justAttached: boolean;
  /** True on the frame a web releases — one-shot for FX/audio. */
  justReleased: boolean;
  /** True on the frame the player yanks themselves off the ground with a
   *  two-handed web pull. One-shot, for FX/animation/audio. Set by the
   *  traversal system, consumed by the feel layer. */
  justGroundPull: boolean;
  /** Height above the surface directly below; drives ground-proximity speed cues. */
  altitude: number;
  /** True on the frame a deliberate web press found NO legal anchor. One-shot.
   *  A press that fires nothing used to be indistinguishable from a dropped
   *  input; the feel layer answers this so a click always reads as heard. */
  webRefused: boolean;
  /** Seconds remaining on the dash cooldown; 0 = dash available. Counted from
   *  ACTIVATION, so it is already ticking during the dash itself. */
  dashCooldown: number;
  /** Full length (s) of that cooldown, so a HUD can draw a ratio without
   *  importing swing tuning. Constant at runtime. */
  dashCooldownTotal: number;
}

// ---------------------------------------------------------------------------
// Input — written by input, read by swing/player and camera
// ---------------------------------------------------------------------------

export interface InputSnapshot {
  /** -1..1 strafe/lateral steer. */
  moveX: number;
  /** -1..1 forward/back steer. */
  moveY: number;
  /** Camera look delta this frame, radians. */
  lookX: number;
  lookY: number;
  /** Held: fire/hold web. */
  swing: boolean;
  /** Edge: web fired this frame. */
  swingPressed: boolean;
  /** Edge: web released this frame. */
  swingReleased: boolean;
  /** Edge: targeted dash / zip. */
  dashPressed: boolean;
  /** Held: tuck/dive to accelerate. */
  dive: boolean;
  /** Edge: jump / launch off the swing apex. */
  jumpPressed: boolean;
}

// ---------------------------------------------------------------------------
// Per-frame system interfaces
// ---------------------------------------------------------------------------

export interface UpdateContext {
  /** Clamped delta seconds (never above TUNABLES.maxDeltaSeconds). */
  dt: number;
  /** Seconds since start. */
  elapsed: number;
  /** Fixed-step substep index, for systems that need determinism. */
  frame: number;
}

export interface System {
  update(ctx: UpdateContext): void;
  dispose?(): void;
}

// ---------------------------------------------------------------------------
// Determinism — procedural generation must be reproducible from a seed
// ---------------------------------------------------------------------------

/** mulberry32. Deterministic, fast, seedable. Use this everywhere; never Math.random(). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash for chunk coords -> seed, so chunks regenerate identically. */
export function hashCoords(x: number, z: number, seed: number): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (z | 0), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
