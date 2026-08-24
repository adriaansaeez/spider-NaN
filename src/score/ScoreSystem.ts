import type { PlayerSnapshot, System, TraversalState, UpdateContext } from '../contracts';
import { AudioSystem } from '../fx/AudioSystem';
// Read-only: the flip's DURATION is the animation layer's number, not ours, so
// importing it keeps the two in step instead of hard-coding a copy that drifts.
import { FX_TUNING } from '../fx/tuning';
import { resolveTrickName, type TrickName } from '../i18n/i18n';
import { ScoreHud } from './ScoreHud';
import { SCORE_TUNING as T } from './tuning';

/** The four things worth points. Everything else is NONE and earns nothing. */
type Segment = 'NONE' | 'SWING' | 'AIR' | 'DASH' | 'WALL_RUN';

/** What a critic (or the headless harness) can read off `__GAUNTLET__.score()`. */
export interface ScoreReport {
  score: number;
  multiplier: number;
  record: number;
  links: number;
  segment: Segment;
  segmentTime: number;
  /** True while a run is live (points are being earned). */
  running: boolean;
  /** Most recently awarded trick name, or null. */
  lastTrick: string | null;
  /** False in Modo Libre: the system is inert and nothing accrues. */
  enabled: boolean;
  /** Volteretas completed in the air this run. */
  flipsLanded: number;
  /** The flip currently in the air, or null. */
  flipInFlight: string | null;
  /** Total runs banked this session — lets a test assert a reset happened. */
  runsBanked: number;
}

/**
 * OWNER: score-builder. Tony-Hawk-style combo scoring driven entirely by the
 * frozen `PlayerSnapshot` and `ctx.dt`.
 *
 * The model, in one paragraph: while you are doing one of four skilful things
 * (a taut arc, real air time, a web zip, a wall run) you earn points per second,
 * multiplied live. Finishing one of those segments and starting a different one
 * without touching down is a LINK, and each link adds +1 to the multiplier up to
 * x10. Touching the street ends the run and banks it; touching a rooftop only
 * starts a one-second grace, because in this city rooftops are everywhere and
 * treating every roof kiss as a wipeout makes the game punishing rather than
 * generous. See docs/score/SCORING.md.
 *
 * DETERMINISM. Nothing here reads `performance.now()`, `Date`, or `Math.random()`;
 * every timer is integrated from `ctx.dt`, and the HUD's count-up is a pure
 * display filter that never feeds back. The persisted record is display-only and
 * cannot change what a run scores.
 */
export class ScoreSystem implements System {
  private static readonly recordStorageKey = 'gauntlet.bestScore';

  private readonly hud = new ScoreHud();

  /**
   * Modo Arcade on/off. FALSE BY DEFAULT: the game boots into the main menu with
   * no mode chosen yet, and a scorer that runs before the player has picked a
   * mode would be accumulating a run nobody asked for. `MainMenu` turns it on
   * when Modo Arcade is chosen (and for the harness bypass — see docs/ui/MENU.md).
   */
  private enabled = false;
  /** The harness switch (`__GAUNTLET__.setHudVisible`), independent of the mode. */
  private hudAllowed = true;

  private score = 0;
  private record = ScoreSystem.readStoredRecord();
  private links = 0;
  private runsBanked = 0;
  private lastTrick: string | null = null;
  private flipsLanded = 0;

  /**
   * A voltereta the animation layer has started and that has not finished
   * rotating yet. `at` is the segment time it completes at.
   */
  private pendingFlip: { trick: TrickName; points: number; big: boolean; at: number } | null = null;

  private segment: Segment = 'NONE';
  private segmentTime = 0;
  /** Which one-shot tiers the current segment has already paid out. */
  private tierLongSwing = false;
  private tierFullArc = false;
  private tierBigAir = false;
  private tierHangTime = false;

  /** Seconds spent in LANDED on a rooftop; past `rooftopGrace` the run banks. */
  private graceTime = 0;
  private grounded = false;

  private audioAccum = 0;
  private sinceTick = 0;
  private ladderStep = 0;

  constructor(private readonly player: PlayerSnapshot) {
    // Boot hidden: no mode has been chosen yet.
    this.applyHudVisibility();
  }

  // -------------------------------------------------------------------------
  // public surface
  // -------------------------------------------------------------------------

  report(): ScoreReport {
    return {
      score: Math.round(this.score),
      multiplier: this.multiplier(),
      record: Math.round(this.record),
      links: this.links,
      segment: this.segment,
      segmentTime: +this.segmentTime.toFixed(3),
      running: this.score > 0 && !this.grounded,
      lastTrick: this.lastTrick,
      enabled: this.enabled,
      flipsLanded: this.flipsLanded,
      flipInFlight: this.pendingFlip ? resolveTrickName(this.pendingFlip.trick) : null,
      runsBanked: this.runsBanked,
    };
  }

  /**
   * Arm or disarm the whole system. This is the ONLY thing the mode selection
   * touches — the menu never reaches into the model.
   *
   * Disabling is not "hide the HUD and keep counting": `update()` returns before
   * any accrual, so in Modo Libre no points are earned, no riser fires, and
   * `bank()` is never reached, which is what keeps the stored record Arcade's.
   * Turning it off also clears whatever run was in flight, so re-entering Arcade
   * always starts from zero.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.reset();
    this.applyHudVisibility();
  }

  /** Harness/critic switch. Both HUDs obey it; the mode gate is independent. */
  setHudVisible(v: boolean): void {
    this.hudAllowed = v;
    this.applyHudVisibility();
  }

  /** The HUD is on screen only when the harness allows it AND Arcade is armed. */
  private applyHudVisibility(): void {
    this.hud.setVisible(this.hudAllowed && this.enabled);
  }

  /** Called from Game.resetWorld(), i.e. `__GAUNTLET__.reset()` and exit-to-menu. */
  reset(): void {
    this.score = 0;
    this.links = 0;
    this.segment = 'NONE';
    this.segmentTime = 0;
    this.graceTime = 0;
    this.grounded = false;
    this.lastTrick = null;
    this.flipsLanded = 0;
    this.pendingFlip = null;
    this.audioAccum = 0;
    this.sinceTick = 0;
    this.ladderStep = 0;
    this.clearTiers();
    this.hud.snap(0);
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------

  update(ctx: UpdateContext): void {
    // Modo Libre: completely inert. Nothing below this line runs.
    if (!this.enabled) return;
    const p = this.player;
    const dt = ctx.dt;
    const next = ScoreSystem.segmentOf(p.state);

    // --- ground contact ------------------------------------------------------
    // The traversal system has exactly one touchdown state (LANDED) for both the
    // street and a rooftop, and never enters PERCH, so the surface height under
    // the player is what separates "you bailed" from "you touched a roof":
    // surfaceY = position.y - altitude, straight off the frozen snapshot.
    if (p.state === 'LANDED' || p.state === 'IDLE') {
      const surfaceY = p.position.y - p.altitude;
      this.closeSegment();
      if (surfaceY < T.rooftopMinHeight) {
        this.bank();
      } else {
        this.graceTime += dt;
        if (this.graceTime >= T.rooftopGrace) this.bank();
      }
      this.grounded = true;
      this.hud.update(dt, this.score, this.multiplier(), this.record, false);
      return;
    }
    this.grounded = false;
    this.graceTime = 0;

    // --- segment bookkeeping -------------------------------------------------
    if (next !== this.segment) {
      this.closeSegment();
      this.segment = next;
      this.segmentTime = 0;
      this.ladderStep = 0;
      if (next === 'DASH') this.award({ base: 'trick.webSlingshot' }, T.trickDash, false);
      if (next === 'WALL_RUN') this.award({ base: 'trick.wallRun' }, T.trickWallRun, false);
      // The animation layer starts a flip on exactly this edge — entering an
      // untethered state from a tethered one — so this is the one frame where
      // there is anything to read.
      if (next === 'AIR') this.watchFlip();
    }
    this.segmentTime += dt;

    // The launch is an edge, not a state, so it is scored where it fires.
    if (p.justGroundPull) this.award({ base: 'trick.launchPull' }, T.trickLaunch, false);

    // --- per-second earnings -------------------------------------------------
    const rate = this.rate(p);
    if (rate > 0) this.add(rate * dt);

    // --- named tiers ---------------------------------------------------------
    if (this.segment === 'SWING') {
      if (!this.tierLongSwing && this.segmentTime >= T.trickLongSwingAt) {
        this.tierLongSwing = true;
        this.award({ base: 'trick.longSwing' }, T.trickLongSwing, false);
      }
      if (!this.tierFullArc && this.segmentTime >= T.trickFullArcAt) {
        this.tierFullArc = true;
        this.award({ base: 'trick.fullArc' }, T.trickFullArc, true);
      }
    } else if (this.segment === 'AIR') {
      // A voltereta pays when the rotation COMPLETES in the air. Contact snaps
      // an unfinished flip upright on the contact frame (FlipController), so a
      // flip you did not leave yourself room for was never fully performed and
      // does not pay — which is exactly the THPS "land it or lose it" bargain.
      const flip = this.pendingFlip;
      if (flip && this.segmentTime >= flip.at) {
        this.pendingFlip = null;
        this.flipsLanded++;
        // A landed flip is a trick in the chain, so it bumps the multiplier the
        // way a completed segment does. Air time with style beats plain hang.
        this.grantLink();
        this.award(flip.trick, flip.points, flip.big);
      }
      if (!this.tierBigAir && this.segmentTime >= T.trickBigAirAt) {
        this.tierBigAir = true;
        this.award({ base: 'trick.bigAir' }, T.trickBigAir, false);
      }
      if (!this.tierHangTime && this.segmentTime >= T.trickHangTimeAt) {
        this.tierHangTime = true;
        this.award({ base: 'trick.hangTime' }, T.trickHangTime, true);
      }
    }

    this.stepAudio(dt);
    this.hud.update(dt, this.score, this.multiplier(), this.record, true);
  }

  dispose(): void {
    this.hud.dispose();
  }

  // -------------------------------------------------------------------------
  // model
  // -------------------------------------------------------------------------

  private multiplier(): number {
    return Math.min(T.maxMultiplier, 1 + this.links);
  }

  private add(base: number): void {
    const gained = base * this.multiplier();
    this.score += gained;
    this.audioAccum += gained;
    if (this.score > this.record) this.record = this.score;
  }

  private award(trick: TrickName, base: number, big: boolean): void {
    const gained = base * this.multiplier();
    this.add(base);
    this.lastTrick = resolveTrickName(trick);
    this.hud.pushTrick(trick, Math.round(gained), big);
    AudioSystem.scoreTrick(big ? 1 : 0, this.multiplier() / T.maxMultiplier);
  }

  /** Points per second for the current segment, before the multiplier. */
  private rate(p: PlayerSnapshot): number {
    switch (this.segment) {
      case 'SWING': {
        const commit = Math.min(1, T.swingCommitFloor + this.segmentTime / T.swingCommitTime);
        const quality = 1
          + T.swingSpeedBonus * Math.min(1, p.speed / T.swingSpeedRef)
          + T.swingRopeBonus * Math.min(1, p.ropeLength / T.swingRopeRef);
        return T.swingRate * commit * quality;
      }
      case 'AIR': {
        const hang = Math.min(T.airHangCap, T.airHangFloor + this.segmentTime / T.airHangTime);
        return T.airRate * hang;
      }
      case 'WALL_RUN':
        return T.wallRunRate;
      // A dash lasts a few tenths of a second; it pays a one-shot instead, so a
      // per-second rate here would only add noise.
      case 'DASH':
      case 'NONE':
      default:
        return 0;
    }
  }

  /**
   * A LINK is a completed segment: you held one of the four scoring actions long
   * enough for it to read as deliberate, and then moved into a different one
   * without touching down. Each link is +1 multiplier, capped at x10, so the
   * canonical swing → release → air → swing chain climbs two per cycle.
   */
  private closeSegment(): void {
    if (this.segment === 'NONE') return;
    const burst = this.segment === 'DASH' || this.segment === 'WALL_RUN';
    const min = burst ? T.linkMinTimeBurst : T.linkMinTime;
    if (this.segmentTime >= min && this.score > 0) this.grantLink();
    this.segment = 'NONE';
    this.segmentTime = 0;
    this.pendingFlip = null;
    this.clearTiers();
  }

  /** One more trick in the chain. The multiplier reads `1 + links`, capped. */
  private grantLink(): void {
    if (this.links < T.maxMultiplier - 1) this.links++;
  }

  // -------------------------------------------------------------------------
  // volteretas
  // -------------------------------------------------------------------------

  /**
   * Read the flip the animation layer just decided on, if any.
   *
   * It deliberately READS the live FlipController through the FX telemetry
   * rather than re-deriving the trigger rule from the snapshot: the rule is
   * `src/fx/motion.ts`'s to own (altitude gate, launch/dive/lean cases, the
   * seeded single-vs-double draw, and the `setMotionFlip` critic override), and
   * a second copy here would eventually pay points for a flip that never played
   * on screen. Cost is one read per air segment, roughly once a second — not a
   * per-frame poll.
   *
   * Every access is optional-chained: if the FX surface is ever absent or
   * reshaped, volteretas simply stop scoring. They never throw.
   */
  private watchFlip(): void {
    this.pendingFlip = null;
    if (typeof window === 'undefined') return;
    const api = (window as unknown as { __GAUNTLET__?: { characterStats?: () => unknown } }).__GAUNTLET__;
    const stats = api?.characterStats?.() as
      { motion?: { flip?: { kind?: string; turns?: number; cork?: number } } } | undefined;
    const flip = stats?.motion?.flip;
    const kind = flip?.kind;
    if (!kind || kind === 'none') return;
    const turns = flip?.turns === 2 ? 2 : 1;
    const cork = flip?.cork ? 1 : 0;

    const baseKey = kind === 'front' ? 'trick.frontFlip' : kind === 'back' ? 'trick.backFlip' : 'trick.corkscrew';
    const trick: TrickName = { base: baseKey };
    if (turns === 2) trick.prefix = 'trick.doublePrefix';
    if (cork) trick.suffix = 'trick.corkscrew';
    const points = (turns === 2 ? T.trickDoubleFlip : T.trickFlip) + cork * T.trickFlipCork;
    this.pendingFlip = {
      trick,
      points,
      big: turns === 2 || cork === 1,
      // FlipController advances t by dt/(motionFlipTime * turns) on exactly the
      // frames this segment is running, so segment time and flip progress share
      // a clock.
      at: FX_TUNING.motionFlipTime * turns,
    };
  }

  private clearTiers(): void {
    this.tierLongSwing = false;
    this.tierFullArc = false;
    this.tierBigAir = false;
    this.tierHangTime = false;
  }

  /** End the run: bank it against the record, then zero everything. */
  private bank(): void {
    if (this.score <= 0) {
      this.links = 0;
      return;
    }
    const total = this.score;
    const stored = ScoreSystem.readStoredRecord();
    const isRecord = total > stored;
    if (isRecord) ScoreSystem.writeStoredRecord(total);
    // Fold `stored` in too, so a record set in another tab (or before this
    // session's ScoreSystem read storage) can never be understated on screen.
    this.record = Math.max(this.record, stored, total);
    this.runsBanked++;
    this.hud.pushBank(total, isRecord);
    AudioSystem.scoreBank(isRecord);
    this.score = 0;
    this.links = 0;
    this.lastTrick = null;
    this.flipsLanded = 0;
    this.pendingFlip = null;
    this.audioAccum = 0;
    this.ladderStep = 0;
  }

  private static segmentOf(state: TraversalState): Segment {
    switch (state) {
      case 'WEB_ATTACH':
      case 'SWING':
        return 'SWING';
      case 'RELEASE':
      case 'AIRBORNE':
      case 'FALLING':
        return 'AIR';
      case 'DASH':
        return 'DASH';
      case 'WALL_RUN':
        return 'WALL_RUN';
      default:
        return 'NONE';
    }
  }

  // -------------------------------------------------------------------------
  // audio — a riser whose pitch climbs with the ladder AND with the multiplier
  // -------------------------------------------------------------------------

  private stepAudio(dt: number): void {
    this.sinceTick += dt;
    if (this.audioAccum < T.tickPoints || this.sinceTick < T.tickMinInterval) return;
    this.audioAccum -= T.tickPoints;
    // Never let a x10 chain bank several ticks' worth and fire them back to back.
    if (this.audioAccum > T.tickPoints * 2) this.audioAccum = T.tickPoints * 2;
    this.sinceTick = 0;
    AudioSystem.scoreTick(this.ladderStep, this.multiplier() / T.maxMultiplier);
    this.ladderStep = (this.ladderStep + 1) % T.tickLadderSteps;
  }

  // -------------------------------------------------------------------------
  // persistence — same guarding as AudioSystem.readStoredVolume()
  // -------------------------------------------------------------------------

  private static readStoredRecord(): number {
    try {
      const raw = localStorage.getItem(ScoreSystem.recordStorageKey);
      if (raw === null) return 0;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) return 0;
      return Math.floor(parsed);
    } catch {
      return 0;
    }
  }

  private static writeStoredRecord(v: number): void {
    try {
      localStorage.setItem(ScoreSystem.recordStorageKey, String(Math.round(v)));
    } catch {
      // Private/embedded contexts have no storage; the in-memory record still works.
    }
  }
}
