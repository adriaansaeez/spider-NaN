import { MathUtils, Vector3 } from 'three';
import type { Anchor, AnchorQuery } from '../contracts';
import { SWING_TUNING as T } from './tuning';

/**
 * OWNED BY: traversal-builder.
 *
 * Anchor selection strategy. The city owns the query; this module decides how
 * to bias it so the swings it returns are good, not just valid:
 *  - prefer anchors that are NEAR and LATERAL (8-26 m facade beside the
 *    corridor), NOT a distant tower top 90-120 m down-corridor — a long rope
 *    to a far anchor reads as a slingshot instead of a pendulum
 *  - alternate left/right so the player zig-zags down an avenue
 *  - avoid re-picking the same structure it just used
 *  - keep the query cheap (the city grid does the heavy lifting).
 */
export class AnchorPicker {
  /** structureIds used in the last few swings, to avoid re-picking them. */
  private recent: number[] = [];
  /** Side of the last swing: -1 = left, +1 = right. */
  private lastSide = 1;
  /** Scratch query direction for the ground-pull aim sweep. No allocation. */
  private readonly sweepDir = new Vector3();

  constructor(private readonly world: AnchorQuery) {}

  reset() {
    this.recent.length = 0;
    this.lastSide = 1;
  }

  /** Horizontal dir of travel, to classify anchor side. */
  private sideOfTravel(a: Anchor, origin: Vector3, fwd: Vector3): number {
    const dx = a.position.x - origin.x;
    const dz = a.position.z - origin.z;
    const along = dx * fwd.x + dz * fwd.z;
    const lat = dx * -fwd.z + dz * fwd.x;
    // Prefer clear lateral anchors; if the anchor is basically ahead, keep side.
    if (Math.abs(lat) < Math.abs(along) * 0.2) return this.lastSide;
    return lat >= 0 ? 1 : -1;
  }

  /**
   * Score a candidate anchor, REJECTING (-Infinity) anything that cannot
   * produce a legal arc.
   *
   * The iteration-2 build scored the predicted nadir but never rejected on it,
   * which the integration critic showed cannot work: once the player is at
   * y = 1.6 m, *every* reachable anchor yields a negative nadir, because the
   * rope is necessarily longer than the anchor is high. Ranking cannot save
   * that — the candidate set has to be allowed to come back EMPTY so the
   * traversal system can refuse to attach and use a recovery move instead.
   *
   * A candidate is legal only if:
   *   - it is high enough that a rope reaching the nadir clearance is still
   *     longer than minRope, and
   *   - the rope we would actually start with (the current distance — we never
   *     teleport the player toward the anchor) is within reeling distance of
   *     that ceiling.
   */
  private score(a: Anchor, origin: Vector3): number {
    const lat = Math.hypot(a.position.x - origin.x, a.position.z - origin.z);
    if (lat < T.minAnchorLateral) return -Infinity;
    if (lat > T.maxAnchorLateral) return -Infinity;

    const above = a.position.y - origin.y;
    if (above < T.minAnchorHeightAbove) return -Infinity;

    const surface = this.world.surfaceHeightAt(origin.x, origin.z);
    // Longest rope whose rigid-pendulum nadir still clears the street.
    const ropeCeiling = a.position.y - (surface + T.nadirClearance);
    if (ropeCeiling < T.minRope) return -Infinity;

    const rope = a.position.distanceTo(origin);
    if (rope > T.maxWebDistance) return -Infinity;
    // Anything longer than this cannot be reeled down to the ceiling before the
    // player reaches the bottom of the arc, so the nadir would still be illegal.
    if (rope - ropeCeiling > T.reelBudget) return -Infinity;
    if (rope > ropeCeiling * T.maxReelRatio) return -Infinity;

    const nadir = a.position.y - Math.min(rope, ropeCeiling);
    // The band has a top too: an anchor whose arc never descends into the
    // corridor parks the player above where anchors are legal, and the loop
    // starves for lack of anything to grab next.
    if (nadir > surface + T.nadirMax) return -Infinity;
    const nadirScore = 1 - Math.min(1, Math.abs(nadir - (surface + T.nadirTarget)) / 45);
    const latScore = 1 - Math.min(1, Math.abs(lat - T.idealLateral) / T.idealLateral);
    // Prefer an anchor we barely have to reel: less winching, more pendulum.
    const reel = Math.max(0, rope - ropeCeiling) / Math.max(1, ropeCeiling);
    const reelScore = 1 - Math.min(1, reel);
    return nadirScore * 1.4 + latScore * 0.7 + reelScore * 0.9;
  }

  /**
   * Query for the best swing anchor given player state and steer input.
   * Returns null when no acceptable anchor exists. Never throws.
   */
  pick(
    origin: Vector3,
    velocity: Vector3,
    steer: number,
  ): Anchor | null {
    // Bias by steer, plus alternate against the last swing's side.
    const biasBase = MathUtils.clamp(
      steer + this.lastSide * -T.alternationBias,
      -1,
      1,
    );
    let best: Anchor | null = null;
    let bestScore = -Infinity;
    // Same, but ignoring the "don't re-pick the last structure" preference.
    let fallback: Anchor | null = null;
    let fallbackScore = -Infinity;
    for (let i = 0; i <= T.maxAnchorRetries; i++) {
      // Explore biases around the player's steer; alternate when repeating.
      const bias =
        i === 0 ? biasBase : (i % 2 === 1 ? 1 : -1) * T.alternationBias * (1 + i * 0.4);
      const a = this.query(origin, velocity, MathUtils.clamp(bias, -1, 1));
      if (!a) continue;
      const sc = this.score(a, origin);
      if (sc === -Infinity) continue;
      if (sc > fallbackScore) { fallbackScore = sc; fallback = a; }
      if (this.recent.includes(a.structureId)) continue;
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
    // Alternation is a PREFERENCE, not a veto. Returning null because the only
    // legal anchor happens to be the one we just used drops the player out of
    // the loop — the exact starvation that ends in a landing.
    return best ?? fallback;
  }

  private query(
    origin: Vector3,
    velocity: Vector3,
    lateralBias: number,
    minRope: number = T.minRope,
    nadirClearance: number = T.nadirClearance,
  ): Anchor | null {
    // Raise the city's own height filter so it never even offers an anchor too
    // low to hang a legal arc from. This is the cheapest place to enforce the
    // nadir rule — it shrinks the candidate set before any scoring.
    const surface = this.world.surfaceHeightAt(origin.x, origin.z);
    const needAbove = surface + nadirClearance + minRope - origin.y;
    return this.world.findSwingAnchor({
      origin,
      velocity,
      lateralBias,
      maxDistance: T.maxWebDistance,
      minHeightAbove: Math.max(T.minAnchorHeightAbove, needAbove),
    });
  }

  /**
   * Ground-pull candidates: tall enough to hang a legal nadir once the rope is
   * winched, even when the CURRENT distance would fail the normal reelBudget
   * gate (every street-level grab does — that is why tryAutoAttach returns
   * empty from LANDED). Lateral / height / reach gates still apply; only the
   * "can we reel this before the bottom of the arc" refusal is relaxed,
   * because the ground-pull path reels at groundPullReelRate and yanks along
   * the line instead of waiting for a downswing.
   *
   * `forward` is the player's AIM, not their velocity — see the note inside.
   */
  pickGroundPull(
    origin: Vector3,
    forward: Vector3,
    steer: number,
  ): Anchor | null {
    const biasBase = MathUtils.clamp(
      steer + this.lastSide * -T.alternationBias,
      -1,
      1,
    );
    let best: Anchor | null = null;
    let bestScore = -Infinity;
    // AIM, not velocity. The city's query keeps only anchors in the forward
    // hemisphere of the direction it is handed, and from LANDED the player's
    // velocity is ~0, which the city resolves to a fixed -Z — so a standing
    // player used to web whatever happened to lie north of them, whatever they
    // were looking at. Each retry sweeps the query direction further off the
    // aim, so "nothing in front of me" stops meaning "no web".
    const sweep = T.groundPullAimSweepDeg;
    for (let i = 0; i <= T.maxAnchorRetries; i++) {
      const offDeg = sweep[i % sweep.length];
      const off = (offDeg * Math.PI) / 180;
      const cos = Math.cos(off);
      const sin = Math.sin(off);
      this.sweepDir.set(
        forward.x * cos + forward.z * sin,
        0,
        -forward.x * sin + forward.z * cos,
      );
      const a = this.query(
        origin, this.sweepDir, MathUtils.clamp(biasBase, -1, 1),
        T.groundPullMinRope, T.groundPullNadirClearance,
      );
      if (!a) continue;
      let sc = this.scoreGroundPull(a, origin);
      if (sc === -Infinity) continue;
      // Turning away from what you are looking at costs score, so the aimed
      // building always wins when it is legal.
      sc -= (Math.abs(offDeg) / 180) * T.groundPullAimPenalty;
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
    return best;
  }

  /** Relaxed score for a street-level two-handed yank — see pickGroundPull.
   *
   *  Gates on groundPull* rather than the airborne numbers, so making a low
   *  facade usable from the street cannot loosen mid-air anchor selection. */
  private scoreGroundPull(a: Anchor, origin: Vector3): number {
    const lat = Math.hypot(a.position.x - origin.x, a.position.z - origin.z);
    if (lat < T.groundPullMinLateral) return -Infinity;
    if (lat > T.maxAnchorLateral) return -Infinity;

    const above = a.position.y - origin.y;
    if (above < T.minAnchorHeightAbove) return -Infinity;

    const surface = this.world.surfaceHeightAt(origin.x, origin.z);
    const ropeCeiling = a.position.y - (surface + T.groundPullNadirClearance);
    if (ropeCeiling < T.groundPullMinRope) return -Infinity;

    const rope = a.position.distanceTo(origin);
    if (rope > T.maxWebDistance) return -Infinity;

    // Prefer tall, mid-lateral facades: more headroom for the yank, more arc.
    const heightScore = Math.min(1, above / 60);
    const latScore = 1 - Math.min(1, Math.abs(lat - T.idealLateral) / T.idealLateral);
    return heightScore * 1.6 + latScore * 0.8;
  }

  /** Remember an attached anchor and classify its side for alternation. */
  remember(a: Anchor, origin: Vector3, fwd: Vector3) {
    this.recent.push(a.structureId);
    if (this.recent.length > T.recentStructures) this.recent.shift();
    this.lastSide = this.sideOfTravel(a, origin, fwd);
  }
}
