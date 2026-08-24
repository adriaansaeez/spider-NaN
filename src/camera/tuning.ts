/** OWNED BY: feel-builder. Only the feel builder edits this file. */
export const CAMERA_TUNING = {
  baseFov: 70,
  /** FEEL_SPEC FOV ceiling — hard clamp, never exceed. */
  maxFov: 88,
  /** FOV speed curve from FEEL_SPEC.md: fov += clamp(speed*0.45, 0, 20). */
  speedFovGain: 0.45,
  maxSpeedFovGain: 16,
  /** Horizontal speed (m/s) at which the speed factor saturates (for shake/distance). */
  speedForMaxFov: 110,
  /** Extra FOV added by a steep dive. */
  diveFovGain: 4,
  /** Vertical descent speed (m/s) at which the dive term saturates. */
  diveSpeedForMax: 45,
  /** Extra downward pitch at a full dive. */
  divePitchGain: 0.3,
  /** Distance (m) at which ground proximity starts registering. */
  proximityRange: 18,
  /** Extra FOV when skimming close to the ground. */
  proximityFovGain: 2,
  /** Slightly lift the low-pass view so nadirs frame the lit corridor, not only asphalt. */
  proximityPitchGain: -0.14,

  /**
   * Chase distance at rest, m. Spec is 8/10/13; iteration 2 pulled this to 3.8
   * to make a 1.5x-scaled hero readable, which broke scale against the city's
   * 3.5 m storey. The hero is back at human scale (1.0), so the distance goes
   * back toward spec: a 1.86 m figure at 6 m through a 70 deg FOV fills ~22% of
   * frame height, which reads clearly without dominating the composition.
   */
  /** Zoom. The owner asked for "50% more base zoom on the character": the hero
   *  should read 1.5x larger at the base framing, so the boom is DIVIDED by 1.5
   *  (0.60 -> 0.40). It multiplies the boom LENGTH only; the height term is
   *  derived from `distRaw` in CameraSystem, so this knob stays independent of
   *  heightScale and pulling in never lifts or drops the rig (measured: mean
   *  camera height above the player 4.12 m before, 4.07 m after).
   *  The per-state `stateZoom` multipliers ride on top of this, so the dynamic
   *  zooms scale with the new base instead of being flattened by it.
   *
   *  MEASURED CAVEAT, so nobody re-derives it: this knob alone does NOT deliver
   *  a 1.5x hero. It scales the HORIZONTAL leg of the boom (~6 m), while the
   *  vertical leg ((sin(pitch)*distRaw + heightOffset) * heightScale, ~4 m) is
   *  untouched by design, so the total camera->player distance only fell from
   *  8.03 m to 7.23 m: SWING 1.09x, AIRBORNE 1.11x, DASH 1.12x, LANDED 1.22x,
   *  FALLING 1.34x, WALL_RUN 1.35x apparent size. A true 1.5x needs the WHOLE
   *  boom vector divided by 1.5 (this knob AND heightScale 1.5 -> 1.0), which
   *  necessarily lowers the rig — a uniform zoom cannot preserve rig height.
   *  That trade is the owner's call, not this file's. */
  distanceScale: 0.4,
  baseDistance: 6.0,
  /** Extra distance pulled back at full speed. Kept modest: the FOV curve
   *  already widens by up to 16 deg at speed, and pulling the boom as well
   *  compounds into a hero too small to read. */
  extraDistance: 1.2,
  /** Fixed vertical lift above the player, m. */
  heightOffset: 1.0,
  /** Multiplier on the camera's total vertical offset above the look target.
   *  1.5 = the rig sits 50% higher than the tuned baseline. Deliberately NOT
   *  touched by the base-zoom change: distanceScale shortens the boom, this sets
   *  the rig's elevation, and the two must stay independent (CameraSystem builds
   *  the height term from `distRaw`, the un-zoomed length). Verified after the
   *  zoom change: mean camera height above the player 4.12 m -> 4.07 m. */
  heightScale: 1.5,
  /** Clearance the camera keeps above the surface below it (m). */
  groundClearance: 2.2,
  /** Largest vertical lift the ground-clearance clamp may apply in one frame's
   *  target (m). Beyond this the XZ is inside a tall footprint and the boom
   *  sweep, not the clamp, is the right tool — otherwise the camera would
   *  teleport to a rooftop 100 m up. */
  maxGroundLift: 7,

  /** Critically-damped spring stiffness for position. */
  positionOmega: 22,
  /** Spring stiffness for the look target (raised to cut lag that ate the lead). */
  lookOmega: 22,
  /** Spring stiffness for FOV. */
  fovOmega: 4.5,
  /** Spring stiffness for roll. */
  rollOmega: 5.0,
  /** Spring stiffness for the camera pitch (state morphs, no cuts). */
  pitchOmega: 3.4,
  /** How strongly the camera yaw drifts toward the velocity heading when idle-looking. */
  yawDriftRate: 2.2,
  /** Upward bias added to the look target so the player sits below center. */
  lookUpBias: -2.8,
  // NO SHAKE KNOB. There used to be a `shakeAmount` here driving a
  // frame-indexed sin/cos wobble on the final camera position; it produced a
  // ~3.7-frame-period, 0.02 wu buzz that got louder with speed and changed
  // pitch with the refresh rate. Removed at the owner's request — the mechanism
  // is gone from CameraSystem, not merely zeroed. If camera weight is ever
  // wanted again it belongs in the springs, not in a post-spring offset.

  /** Seconds of velocity to lead the look target by (FEEL_SPEC 0.55s). */
  lookAhead: 0.5,
  /** Max world-units the look lead can reach (raised; lead is time-based now). */
  maxLookLead: 72,
  /** Floor on the look lead so the camera never stares at the player's feet. */
  minLookLead: 4,
  /** Velocity feedforward (seconds) cancelling position-spring lag at speed. */
  positionFeedforward: 0.03,
  /** Fraction of vertical velocity allowed into chase-position feedforward. */
  positionFeedforwardVertical: 0.08,
  maxPositionFeedforward: 6,

  /** Bank-into-swing roll per unit of lean at speed (spec +/-3deg standard). */
  swingRoll: 0.07,
  /** Max total roll magnitude (radians) — keep subtle. */
  maxRoll: 0.08,

  /** FOV punch (deg) that fires the instant a web attaches. */
  attachFovKick: 3,
  /** FOV kick decay rate (1/s). */
  fovKickDecay: 8,

  /** Collision sweep step and skin width, metres. */
  collisionStep: 0.8,
  collisionSkin: 0.6,

  // --- framing search (integration critique blocker 3) --------------------
  /**
   * The iteration-2 sweep prevented *penetration* but had no notion of
   * *framing*: it was content to sit 0.6 m from a facade with the whole world
   * occluded (65% of traversal frames, 88% at night). The search below picks a
   * boom direction that keeps BOTH the player and the corridor ahead visible,
   * preferring the smallest deviation from the director's chosen angle.
   */
  /** Yaw offsets tried, radians (0 first = the director's angle). */
  framingYaws: [0, 0.32, -0.32, 0.66, -0.66, 1.05, -1.05] as const,
  /** Extra boom elevation tried, radians. Raising the boom is how the camera
   *  gets a clear high line down the corridor instead of a wall. */
  framingPitches: [0, 0.22, 0.48, 0.8, 1.12] as const,
  /** Cost per radian of yaw deviation from the director's angle. */
  yawPenalty: 0.42,
  /** Cost per radian of extra boom elevation (cheaper than yawing: lifting the
   *  camera keeps the travel heading centred, which is what the reference does). */
  pitchPenalty: 0.2,
  /** How far ahead of the camera the corridor-openness probe marches (m). */
  corridorProbe: 45,
  /** Step for the corridor probe (m) — coarse on purpose, it is a visibility
   *  heuristic, not a collision test. */
  corridorStep: 4.5,
  /** Sideways probes, so a facade filling half the frame off-axis is scored as
   *  the bad shot it is — the centre probe alone cannot see it. */
  sideAngle: 0.5,
  sideProbe: 22,
  sideStep: 5.5,
  /** Weight of "the boom reached its full length" in the framing score. */
  reachWeight: 1.0,
  /** Weight of "the view ahead is open" in the framing score, split between the
   *  view axis and the two flanks. */
  openWeight: 1.35,
  centreShare: 0.6,
  /** Score at/above which the first candidate is accepted without searching
   *  (the common case: nothing is in the way, cost ~8 solid tests). */
  framingGoodEnough: 2.25,
  /** Shortest boom the search will accept before falling back to best-effort. */
  minBoom: 1.8,
  /** How fast the chosen framing offsets blend in (1/s). Low enough that a
   *  candidate switch can never produce a rotation jump. */
  framingOmega: 4.5,
  /** Hard ceiling on state pitch + framing lift (radians, ~69 deg). Past this
   *  the boom swings over the player's head: cos(pitch) changes sign and puts
   *  the camera in FRONT of them, and lookAt goes degenerate against world up,
   *  which shows up as a 180 deg roll flip. */
  maxBoomPitch: 1.2,
  /** Steepest the final view direction may be (|dir.y|). Guards the same
   *  lookAt degeneracy from the other side: a vertical dive drags the look
   *  target straight down even when the boom itself is well behaved. */
  maxLookSlope: 0.965,

  /**
   * Largest angle (as a fraction of the half-FOV) the look target may sit off
   * the direction to the player. This is what stops the velocity lead from
   * walking the player out of frame entirely (critique: D_player_absent).
   */
  maxOffAxisFrac: 0.12,

  /**
   * How much of the velocity's VERTICAL component feeds the look lead, per
   * state. Dives want the full downward lead; swings want the corridor level so
   * the camera doesn't nose down at the nadir (critique: SWING pitch too steep).
   */
  leadVertical: {
    IDLE: 0.1, LANDED: 0.1, FALLING: 0.35, WEB_ATTACH: 0.05, SWING: 0.05,
    RELEASE: 0.18, AIRBORNE: 0.18, DASH: 0.35, WALL_RUN: 0.1, PERCH: 0.05,
  } as const,

  /**
   * Per-state ZOOM targets, multiplied onto `distanceScale` only — never onto
   * `distRaw`. That is the whole point of the split: `state[].dist` is the
   * authored boom length and DOES feed the height term, so putting the
   * breathing there would rock the rig up and down every swing. Zoom lives
   * here instead and moves the camera along the boom without touching its
   * elevation, exactly as distanceScale/heightScale were meant to work.
   *
   * The rhythm the owner asked for: the camera eases OUT 20% while swinging
   * and IN 10% while airborne/falling, so a swing -> release -> fall -> reattach
   * cycle breathes between roughly -10% and +20% around the default framing.
   * WEB_ATTACH and RELEASE are short bridging states; they carry intermediate
   * values so the ease keeps travelling the same direction through them
   * instead of reversing for a few frames. DASH matches AIRBORNE (a dash is a
   * burst mid-flight — pulling out for it would break the rhythm). WALL_RUN
   * (state dist 0.72) and PERCH (1.25) keep their authored framings and take a
   * neutral 1.0 zoom, so the new default rescales them without redesigning them.
   */
  stateZoom: {
    IDLE: 1.0, LANDED: 1.0, FALLING: 0.9, WEB_ATTACH: 1.1, SWING: 1.2,
    RELEASE: 1.05, AIRBORNE: 0.9, DASH: 0.9, WALL_RUN: 1.0, PERCH: 1.0,
  } as const,
  /**
   * How fast the zoom eases toward the current state's target (1/s), as an
   * exponential follow like the pitch/FOV/roll smoothers above. 2.2 gives a
   * ~0.45 s time constant: 63% of the travel in 0.45 s and ~90% in 1.0 s.
   * Swing chains land every 1.5-4 s, so a full breath completes comfortably
   * inside one link while still being far too slow to read as a step.
   */
  zoomOmega: 2.2,

  /** Per-state camera modifiers.
   * pitch: camera elevation above the player's horizontal plane (radians).
   *   +ve = camera above, view pitched down; -ve = camera below, view up.
   * fov: added to the FOV curve. dist: chase-distance multiplier.
   * omega: calm factor (lower = slower, for perch near-static).
   */
  state: {
    IDLE:       { pitch: 0.15, fov: 0,   dist: 1.0,  omega: 1.0 },
    LANDED:     { pitch: 0.15, fov: 0,   dist: 1.0,  omega: 1.0 },
    FALLING:    { pitch: 0.42, fov: 3,   dist: 1.05, omega: 1.0 },
    WEB_ATTACH: { pitch: 0.35, fov: 3,   dist: 0.98, omega: 1.0 },
    SWING:      { pitch: 0.33, fov: 4,   dist: 1.0,  omega: 1.0 },
    RELEASE:    { pitch: 0.26, fov: 3,   dist: 1.0,  omega: 1.0 },
    AIRBORNE:   { pitch: 0.12, fov: 3,   dist: 1.05, omega: 1.0 },
    DASH:       { pitch: 0.4,  fov: 4,   dist: 0.9,  omega: 1.0 },
    WALL_RUN:   { pitch: -0.7, fov: -4,  dist: 0.72, omega: 1.0 },
    PERCH:      { pitch: 0.5,  fov: 2,   dist: 1.25, omega: 0.4 },
  } as const,
} as const;
