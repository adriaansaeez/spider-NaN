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
    maxDistance: number = T.maxWebDistance,
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
      maxDistance,
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
    // The crosshair first, exactly as pickAimed does it: if the player is
    // standing on the street pointing at a tower, that tower is the answer and
    // no sweep or score should be able to talk them out of it.
    // maxWebDistance, not pressWebRange: scoreGroundPull refuses anything longer
    // anyway, so a longer ray would only cost steps to find a rejected anchor.
    const hit = this.world.raycastAnchor(origin, forward, T.maxWebDistance);
    if (hit && hit.structureId >= 0 && this.scoreGroundPull(hit, origin) > -Infinity) return hit;
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

  // ---------------------------------------------------------------------
  // Aimed press: the player's own shot
  // ---------------------------------------------------------------------

  /**
   * Anchor for a DELIBERATE web press, resolved from where the player is
   * LOOKING rather than where they are travelling.
   *
   * The automatic path (`pick`) hands the city the player's VELOCITY, and the
   * city keeps only anchors in the forward hemisphere of whatever direction it
   * is given — correct for a held web that should grab ahead of travel, and
   * exactly wrong for a click, which is a statement about a specific building.
   * Aiming at a façade and getting a web fired somewhere else (or nowhere) is
   * what the owner reported as "muchos clicks sin lanzar ninguna telaraña".
   *
   * Two stages, cheapest and most literal first:
   *  1. The crosshair itself. `raycastAnchor` down the aim ray — if the player
   *     is pointing at something webbable, that IS the answer, and no scoring
   *     heuristic gets to overrule it.
   *  2. A narrow cone sweep for the near miss, ranked by how far off the aim
   *     each candidate sits, so a shot that grazes past a corner still fires at
   *     the building the player clearly meant.
   *
   * Returns null only when nothing in the cone can hang a legal arc at all.
   */
  pickAimed(origin: Vector3, aim: Vector3, steer: number): Anchor | null {
    // 1. What the crosshair is actually on.
    // structureId < 0 is the city's "the ray hit bare ground, not a building"
    // result. It is not something a web can hang from, so it never counts as a
    // crosshair hit — otherwise aiming at the road would return a legal-looking
    // anchor at street level.
    const hit = this.world.raycastAnchor(origin, aim, T.pressWebRange);
    if (hit && hit.structureId >= 0 && this.scoreAimed(hit, origin) > -Infinity) return hit;

    // 2. Near miss. Never re-uses `pick`'s alternation memory: alternation
    // exists to make the AUTOMATIC loop zig-zag down an avenue, and applying it
    // to a manual shot would silently steer the player's own aim.
    const biasBase = MathUtils.clamp(steer, -1, 1);
    let best: Anchor | null = null;
    let bestScore = -Infinity;
    const sweep = T.pressAimSweepDeg;
    for (let i = 0; i <= T.maxAnchorRetries; i++) {
      const offDeg = sweep[i % sweep.length];
      const off = (offDeg * Math.PI) / 180;
      const cos = Math.cos(off);
      const sin = Math.sin(off);
      this.sweepDir.set(
        aim.x * cos + aim.z * sin,
        0,
        -aim.x * sin + aim.z * cos,
      );
      const a = this.query(
        origin, this.sweepDir, biasBase,
        T.pressMinRope, T.nadirClearance, T.pressWebRange,
      );
      if (!a) continue;
      let sc = this.scoreAimed(a, origin);
      if (sc === -Infinity) continue;
      sc -= (Math.abs(offDeg) / 180) * T.pressAimPenalty;
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
    return best;
  }

  /**
   * Gate + score for an aimed shot. Deliberately fewer refusals than `score`:
   * a press is the player asking, so this rejects only what is physically
   * unswingable, never what is merely un-ideal.
   *
   * DROPPED here (all present in the automatic `score`):
   *  - `minAnchorLateral` 24 m -> `pressMinLateral` 6 m. The façade you are
   *    standing beside and pointing at is the shot, not an error.
   *  - `maxAnchorLateral`. Reach is bounded by `pressWebRange` in 3D; a second
   *    planar cap on top of it only ever rejects a long shot the player aimed.
   *  - `reelBudget` / `maxReelRatio`. A long rope is not illegal, it is a rope
   *    with excess to winch — `pressReelRate` in TraversalSystem hauls it down
   *    before the nadir instead of refusing the anchor.
   *  - `nadirMax`. An arc that stays high is the player's choice to make.
   *
   * KEPT, and not negotiable: the rope ceiling must still be able to hold the
   * nadir above the street (`nadirClearance`). That is the one gate whose
   * absence puts the body through the tarmac, so an anchor too low to hang a
   * legal arc from is still refused outright.
   */
  private scoreAimed(a: Anchor, origin: Vector3): number {
    const lat = Math.hypot(a.position.x - origin.x, a.position.z - origin.z);
    if (lat < T.pressMinLateral) return -Infinity;

    const above = a.position.y - origin.y;
    if (above < T.minAnchorHeightAbove) return -Infinity;

    const rope = a.position.distanceTo(origin);
    if (rope > T.pressWebRange) return -Infinity;

    const surface = this.world.surfaceHeightAt(origin.x, origin.z);
    const ropeCeiling = a.position.y - (surface + T.nadirClearance);
    if (ropeCeiling < T.pressMinRope) return -Infinity;

    // Everything below is preference only, and it is weak on purpose: on an
    // aimed shot the aim penalty in pickAimed should dominate, so the building
    // the player pointed at wins over a "better" arc off to one side.
    const nadir = a.position.y - Math.min(rope, ropeCeiling);
    const nadirScore = 1 - Math.min(1, Math.abs(nadir - (surface + T.nadirTarget)) / 60);
    const latScore = 1 - Math.min(1, Math.abs(lat - T.idealLateral) / (T.idealLateral * 2));
    return nadirScore * 0.6 + latScore * 0.4;
  }

  /** Remember an attached anchor and classify its side for alternation. */
  remember(a: Anchor, origin: Vector3, fwd: Vector3) {
    this.recent.push(a.structureId);
    if (this.recent.length > T.recentStructures) this.recent.shift();
    this.lastSide = this.sideOfTravel(a, origin, fwd);
  }
}
