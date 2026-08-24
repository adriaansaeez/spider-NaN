/** OWNED BY: feel-builder. Only the feel builder edits this file. */
export const FX_TUNING = {
  // --- web line ---
  /**
   * World radius of the web strand (m). 0.22 was an over-correction from an
   * earlier "hairline" complaint and rendered as a solid white beam tens of
   * pixels wide. The reference is a thin taut strand: 0.04 m gives ~8 px near
   * the hand at 1080p and tapers with distance, which reads without dominating.
   */
  webRadius: 0.04,
  webColor: 0xffffff,
  /** Seconds for the web to shoot out on attach. */
  attachAnimTime: 0.1,
  /** Seconds for the web to snap back on release. */
  snapAnimTime: 0.09,
  /** Glint flash at the anchor on attach. */
  glintScale: 1.8,

  // --- player figure ---
  figureColors: {
    suit: 0xe0282c,
    suitDark: 0x8f1d1f,
    limb: 0x243a86,
    mask: 0xf4f4f4,
  },
  /** Rotation blend rate (1/s); state transitions morph, not pop. */
  poseBlendRate: 12,

  // --- character representation -------------------------------------------
  /**
   * Which hero the game renders. Both are first-class and gameplay is identical
   * either way — this is purely which rig the pose library drives:
   *   'procedural' — the hand-built box figure in PlayerFigure.ts. Zero load
   *                  cost, and the rig the game always BOOTS on.
   *   'model'      — the authored skinned hero in public/assets/character.glb,
   *                  using its four shipped clips (Idle/Jump/Land/Run) where
   *                  they apply and the pose library everywhere else.
   * Loading is async: 'model' swaps in when the GLB arrives and falls back to
   * 'procedural' with one warning if it does not. Flip at runtime with
   * `__GAUNTLET__.setCharacterMode('procedural'|'model')` — same pattern as the
   * city's `setBuildingMode`.
   */
  characterMode: 'model' as 'procedural' | 'model',
  /** Shipped by tools/build-assets.mjs (`npm run assets`). */
  characterModelUrl: 'assets/character.glb',
  /**
   * Ground speed (m/s) above which the hero is MOVING rather than standing.
   * There is no band above this that plays anything other than the run: the
   * character runs or he stands, he never walks. Deliberately low — 1.5 left a
   * slow-shuffle band where the model held Idle while visibly sliding forward.
   */
  characterRunSpeed: 0.6,

  // --- the run cycle (procedural rig) and the Run clip (model rig) ----------
  /**
   * Ground speed (m/s) at which the stride reaches its maximum rate. Beyond it
   * the cycle stops speeding up and the character simply covers more ground.
   */
  runCycleRefSpeed: 11,
  /**
   * Stride-rate FLOOR (strides/s). THIS is what stops the run degrading into a
   * walk: a run cycle played slowly is, visually, a walk. At low ground speed
   * the stride keeps its cadence and only the travel shortens.
   */
  runCycleMinHz: 1.5,
  /** Stride-rate ceiling (strides/s) at and above `runCycleRefSpeed`. */
  runCycleMaxHz: 2.9,
  /** Same floor/ceiling applied to the authored Run clip's playback rate. */
  runClipMinRate: 0.95,
  runClipMaxRate: 1.7,
  /**
   * Pose blend rate (1/s) while the run cycle is driving the procedural rig.
   * `poseBlendRate` exists to stop STATE SWITCHES popping, and as a first-order
   * filter it also attenuates anything periodic: measured in the running game,
   * a 2.9 Hz stride came out at 65% of its authored amplitude. The cycle is
   * already smooth by construction and needs no filtering, so it gets a much
   * higher rate (~88% amplitude retained at 2.9 Hz).
   */
  runBlendRate: 34,
  /**
   * Seconds over which the rate ramps from `poseBlendRate` up to
   * `runBlendRate` on entering a running state. Entering LANDED from AIRBORNE
   * moves the torso ~1.25 rad, and snapping that at the high rate pops; kept
   * short because wall runs only last 0.2-0.8 s.
   */
  runBlendRamp: 0.15,
  /** Cross-fade between shipped clips, seconds. */
  characterClipFade: 0.15,
  /** How long the shipped Jump clip owns the body after leaving the ground. */
  characterJumpTime: 0.34,
  /** How long the shipped Land clip owns the body after touching down. */
  characterLandTime: 0.45,
  /**
   * Shorter Land when the hero touches down still MOVING. The full 0.45 s clip
   * is a stop-and-absorb; playing it while sprinting away from the impact is
   * most of a second of not-running, which is exactly the thing the owner said
   * must never happen. A landing at speed gets a beat of absorb and hands the
   * body straight back to the run.
   */
  characterLandTimeMoving: 0.14,

  // --- motion layer (src/fx/motion.ts) --------------------------------------
  //
  // Variation, flips and secondary motion. Everything here is a THRESHOLD ON
  // REAL MOTION or an amplitude — nothing here is a probability that decides
  // whether something happens, because the owner's ask was that the hero read as
  // alive, not as random. The one place chance appears at all is the FLAVOUR of
  // a flip (one turn or two, corkscrew or not) and it is drawn from a seeded rng
  // so a tape replays identically.

  /**
   * How much authority the physics-chosen partner pose has over the variant the
   * visit started from. Below 1 on purpose: at 1 the drive would erase the
   * variation (every descending swing would converge on the same nadir tuck),
   * and the whole point is that two swings should not look the same.
   */
  motionDriveAuthority: 0.65,
  /**
   * The same authority, for SWING only, and deliberately much lower.
   *
   * SWING is the state the player spends most of their screen time in, and the
   * animation critic's verdict on it was that three PINNED swing variants were
   * "visually near-identical at normal chase-camera scale". Half of that was the
   * poses (now re-authored as three separated silhouettes — see poses.ts) and
   * half was this number: at 0.65, a visit starting on ANY sibling spent most of
   * its arc two-thirds of the way toward whichever partner the vertical speed
   * chose, so all three converged on the same two shapes. 0.3 of the new, much
   * wider sibling spacing is more travel than 0.65 of the old spacing was, and
   * it leaves the silhouette the visit started on still legible at 40-80 px.
   */
  motionSwingDriveAuthority: 0.3,
  /** Downward speed (m/s) at which a swing has fully folded into the nadir tuck. */
  motionSwingTuckVy: 18,
  /** Upward speed (m/s) at which a swing has fully opened into the high arc. */
  motionSwingArcVy: 16,
  /** Downward speed (m/s) past which an airborne pass starts tucking. */
  motionAirTuckVy: 7,
  /** Horizontal speed (m/s) at which the airborne glide spread is fully open. */
  motionAirGlideSpeed: 42,
  /** Descent (m/s) past which FALLING opens into the belly-down skydive arch. */
  motionFallArchVy: 12,
  /** Anchor height above the player (m) that counts as an OVERHEAD attach. */
  motionAttachHighDy: 6,

  /**
   * How much of the pose's torso pitch the MODEL rig carries as a whole-body
   * rotation instead of as spine bend. Only the model rig uses it: the
   * procedural figure hangs its limbs off the torso group, so its torso pitch
   * already moves the whole body. 0 reproduces the old model behaviour (spine
   * only, legs hanging straight down through a 1.15 rad swing pose); 1 would put
   * the entire pitch on the rig and leave the spine perfectly straight, which
   * loses the curl the pose library authors into a tuck.
   */
  motionBodyPitchToRoot: 0.65,

  // --- airborne flips and self-rotation ------------------------------------
  /** Seconds for ONE turn. Two-turn flips get twice this. */
  motionFlipTime: 0.62,
  /**
   * REMOVED in animation iteration 2 (`motionFlipResolveTime`, was 0.18 s).
   *
   * It was the ceiling on accelerating a cut-short flip to a whole turn, and a
   * ceiling was the wrong shape of guarantee: over those 0.18 s the hero was
   * still emitting real pitch, so the animation critic measured a wall run being
   * performed at 226.7 degrees of it. There is no smooth exit from 226 degrees
   * that avoids inverted, so contact now resolves the turn on the contact frame
   * itself and the resolve window is zero. See FlipController.update.
   */
  /** Upward speed (m/s) on entering the air that reads as a LAUNCH -> front flip. */
  motionFlipLaunchVy: 6,
  /** Downward speed (m/s) that reads as tipping off a ledge -> back flip. */
  motionFlipDiveVy: 3,
  /** …but only below this horizontal speed. A fast dive is a dive, not a tumble. */
  motionFlipDiveMaxSpeed: 12,
  /** |lean| on entering the air that reads as a hard steer -> barrel roll. */
  motionFlipRollLean: 0.45,
  /** Never START a rotation below this altitude (m). Nothing flips into a landing. */
  motionFlipMinAltitude: 22,
  /** Altitude (m) above which a flip may be a double, or carry a corkscrew. */
  motionFlipDoubleAltitude: 55,
  /** Always-on bank into a steer while airborne, radians at |lean| = 1. */
  motionBankRad: 0.3,
  motionBankRate: 4,

  // --- secondary motion -----------------------------------------------------
  /** Breaths per second at rest, and the torso amplitude in radians. */
  motionBreathHz: 0.28,
  motionBreathAmp: 0.022,
  /**
   * IDLE LIFE — the weight shift under the breath, at ground rest.
   *
   * Ground rest is `LANDED` below `characterRunSpeed`; the state machine never
   * emits `IDLE` (documented in docs/animation/SYSTEM.md). The critic called the
   * ground idle "quiet and mostly dead", and breathing alone earns that: 0.022
   * rad of torso pitch is invisible at gameplay scale. So rest also sways — the
   * weight moves from one leg to the other, that knee straightens, the shoulders
   * counter-rotate and the head drifts. `Hz` is deliberately NOT a multiple of
   * `motionBreathHz`, so the two layers never phase-lock into a single pulse.
   */
  motionIdleShiftHz: 0.17,
  motionIdleShiftAmp: 0.06,
  motionIdleKneeAmp: 0.16,
  motionIdleArmAmp: 0.1,
  motionIdleHeadAmp: 0.22,
  /**
   * Model mode only: the Idle CLIP owns every joint there (pose authority is 0
   * while a shipped clip plays), so the same aliveness has to arrive as a
   * whole-body offset instead. Radians of sway / nod on the rig group.
   */
  motionIdleBodySwayRad: 0.035,
  motionIdleBodyNodRad: 0.018,
  /** Head look toward the anchor: clamp (rad) and how fast the head turns (1/s). */
  motionHeadYawMax: 0.7,
  motionHeadRate: 5,
  /** Limb trail: seconds^-1 smoothing of yaw rate, gain (rad per rad/s), clamp (rad). */
  motionTrailRate: 8,
  motionTrailGain: 0.05,
  motionTrailMax: 0.28,
  /** Hand settle spring: natural frequency (rad/s) and damping ratio (<1 overshoots). */
  motionSettleFreq: 16,
  motionSettleDamping: 0.45,
  /** Wall-run climb layer: the ascent rate (m/s) at which it is fully applied… */
  motionClimbRefVy: 12,
  motionClimbRate: 8,
  /** …and what it does: square the torso up to the wall, arms reach, head up. */
  motionClimbPitch: 0.3,
  motionClimbReach: 0.55,
  motionClimbHeadUp: 0.25,

  // --- wall run ------------------------------------------------------------
  /**
   * How far the hips shift TOWARD the facade during a wall run, metres. The
   * owner's word was "ligeramente": enough that the body settles into the
   * surface it is running along instead of looking like it is running on flat
   * ground in mid-air, not enough to pull the figure off its own feet.
   */
  wallRunHipShift: 0.14,
  /**
   * Small torso tilt toward the wall, radians, applied with the hip shift. The
   * shift alone slides the whole body sideways; the tilt is what makes it read
   * as leaning INTO the surface.
   */
  wallRunTorsoTilt: 0.16,
  /** Rate (1/s) the hip offset eases in and out, so entering a wall run morphs. */
  wallRunShiftRate: 11,
  /**
   * Rate (1/s) the body turns onto the facade tangent when a wall run starts.
   * High, because a wall run only lasts 0.2-0.8 s, but not instant: the turn can
   * be a full 90 degrees and setting it in one frame reads as a snap.
   */
  wallRunYawRate: 16,
  /** Rate (1/s) the authored pose takes over from a shipped clip and back. */
  characterPoseFadeRate: 9,

  // --- two-handed ground web pull ------------------------------------------
  /** Both strands shoot out over this many seconds. */
  pullWebShootTime: 0.1,
  /** Lateral separation of the two anchor points (m). Two lines, not one. */
  pullWebSpread: 3.4,
  /** Height above the player the pull anchors sit (m). */
  pullWebHeight: 17,
  /** How far in front of the player the pull anchors sit (m). */
  pullWebForward: 5,

  // --- dash web throw (cosmetic only; does not feed dash physics) ----------
  /**
   * How far the throw tip travels from the hand along dash velocity (m).
   * Short on purpose: this is a snap throw, not a swing rope.
   */
  dashThrowLength: 16,
  /** Seconds for the strand to shoot out to full length. */
  dashThrowShootTime: 0.055,
  /** stateTime at which retract begins (must be >= dashThrowShootTime). */
  dashThrowRetractStart: 0.1,
  /** stateTime at which the strand is fully gone (must fit inside a ~0.3 s dash). */
  dashThrowTotal: 0.22,

  // --- speed streaks overlay ---
  /** Full-screen diagonal streak quad. OFF: it washed the frame at speed and
   *  read as a lens artefact. FOV, distance, proximity and wisps still sell speed. */
  screenStreaks: false,
  /** Max overlay opacity at full speed (kept low — critique P0). */
  streakOpacity: 0.13,
  /** Overlay opacity contributed by ground proximity (skim). */
  proximityOpacity: 0.14,
  /** Distance in front of the camera the overlay quad sits. */
  overlayDist: 1,
  /** World speed (m/s) at which the disabled full-screen overlay saturates.
   *  Re-scaled x0.75 to match the swing system's global time dilation (was 110). */
  overlaySpeedRef: 82.5,
  /** Dive speed (m/s) at which the overlay's dive rings saturate.
   *  Re-scaled x0.75 to match the swing system's global time dilation (was 85). */
  overlayDiveRef: 63.75,
  /** Wisps around the camera, drawn as world-space line streaks along the
   *  airflow. The old GL points rasterised as axis-aligned squares, so this
   *  effect now uses LineSegments: one streak per wisp, aligned to -velocity. */
  wispCount: 26,
  wispSpread: 14,
  /** Seconds of travel a streak's length represents: length = speed * this.
   *  Length stretches with speed — a constant-length streak is the giveaway
   *  that an effect is fake. */
  streakSeconds: 0.16,
  /** Streak length floor (m). Keeps slow streaks from collapsing into dots. */
  streakMinLength: 3,
  /** Streak length ceiling (m). Stops streaks from crossing the whole frame. */
  streakMaxLength: 12,
  /** World speed (m/s) above which streaks appear at all — ZERO at rest.
   *  Re-scaled x0.75 to match the swing system's global time dilation (was 12). */
  wispGateSpeed: 9,
  /** World speed (m/s) at which streak opacity reaches full intensity.
   *  Re-scaled x0.75 to match the swing system's global time dilation (was 90). */
  wispOpacityRefSpeed: 67.5,
  wispOpacity: 0.32,

  // --- night readability ---------------------------------------------------
  /** Small camera-local light used only to keep near night facades readable. */
  navigationLightColor: 0xbfd4ff,
  navigationLightIntensity: 1.15,
  navigationLightDistance: 42,
  nightFillSkyColor: 0x9fb8d6,
  nightFillGroundColor: 0x5d6674,
  nightFillIntensity: 0.62,

  // --- low-pass street contrast -------------------------------------------
  /** Warm, cheap local fill that ramps in only for fast low street passes. */
  streetSkimLightColor: 0xffdf9f,
  streetSkimLightIntensity: 5.5,
  streetSkimLightDistance: 58,
  /** Ground pool quad under the hero. OFF: at skim it read as a hard-edged
   *  yellowish rectangle on the street (24×46 m MeshBasicMaterial), not as
   *  light falloff. The PointLight above still warms the pass; FOV / proximity
   *  / wisps still sell speed. Kept behind a flag rather than deleted. */
  streetSkimPool: false,
  streetSkimPoolColor: 0xc8b172,
  streetSkimPoolOpacity: 0.32,
  streetSkimPoolWidth: 24,
  streetSkimPoolLength: 46,

  // --- voice lines (feel-builder) --------------------------------------------
  /** Seconds between random voice lines while the game is running. */
  voiceInterval: 20,
} as const;
