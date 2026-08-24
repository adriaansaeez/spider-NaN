/**
 * OWNER: score-builder. Every number the scoring model uses, in one place.
 * All rates are POINTS PER SECOND BEFORE the multiplier; all times are seconds.
 */
export const SCORE_TUNING = {
  // --- per-second earners ---------------------------------------------------
  /** Base rate while the web is taut (WEB_ATTACH + SWING count as one arc). */
  swingRate: 55,
  /** Commitment ramp: a tap earns 25% of the rate, a 1.4 s arc earns 100%. */
  swingCommitTime: 1.4,
  swingCommitFloor: 0.25,
  /** Quality bonus from how fast and how long the arc is (1.0 .. 1.4). */
  swingSpeedRef: 70,
  swingSpeedBonus: 0.25,
  swingRopeRef: 60,
  swingRopeBonus: 0.15,

  /** Base rate in the air after a release (AIRBORNE / FALLING / RELEASE). */
  airRate: 40,
  /** Hang ramp: 0.5x at the instant of release, 2.0x once you have hung 2.4 s. */
  airHangTime: 1.6,
  airHangFloor: 0.5,
  airHangCap: 2.0,

  /** Wall run is short and deliberate; flat rate. */
  wallRunRate: 70,

  // --- named one-shot tricks ------------------------------------------------
  trickLaunch: 300,      // justGroundPull — the two-handed yank off the ground
  trickDash: 250,        // entering DASH
  trickWallRun: 200,     // entering WALL_RUN
  trickLongSwing: 400,   // arc held this long
  trickLongSwingAt: 2.5,
  trickFullArc: 800,
  trickFullArcAt: 4.5,
  trickBigAir: 500,
  trickBigAirAt: 2.5,
  trickHangTime: 1000,
  trickHangTimeAt: 4.0,

  /**
   * Volteretas. The flip DECISION lives in the animation layer
   * (`src/fx/motion.ts` FlipController) and is gated on altitude, so a double
   * only ever happens above 55 m and a corkscrew rides on top of a somersault.
   * Points follow that risk. A flip is only paid when the rotation actually
   * COMPLETES in the air — see ScoreSystem.
   */
  trickFlip: 350,
  trickDoubleFlip: 900,
  /** Extra for a somersault that carries a corkscrew. */
  trickFlipCork: 250,

  // --- chaining -------------------------------------------------------------
  /** A finished segment must have lasted this long to count as a link. */
  linkMinTime: 0.5,
  /** …except DASH / WALL_RUN, which are deliberate acts even when brief. */
  linkMinTimeBurst: 0.15,
  /** multiplier = 1 + links, clamped here. */
  maxMultiplier: 10,

  // --- landing --------------------------------------------------------------
  /** Surfaces at or above this height count as a rooftop, not the street. */
  rooftopMinHeight: 8,
  /** How long you may stand on a rooftop before the run is banked. */
  rooftopGrace: 1.0,

  // --- audio ----------------------------------------------------------------
  /** Points that must accrue before the riser ticks once. */
  tickPoints: 260,
  /** Hard floor on the gap between ticks, so a x10 chain cannot machine-gun. */
  tickMinInterval: 0.13,
  /** Ladder length before the riser wraps back to the bottom of the scale. */
  tickLadderSteps: 10,

  // --- hud ------------------------------------------------------------------
  /** Exponential rate of the count-up roll (per second). */
  countUpRate: 9,
  /** Minimum roll speed in points/sec, so big numbers never crawl in. */
  countUpFloor: 900,
  /** Only touch the DOM every Nth frame (Hud.update uses 10). */
  domEveryNFrames: 4,
} as const;
