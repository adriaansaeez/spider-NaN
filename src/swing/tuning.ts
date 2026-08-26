/**
 * OWNED BY: traversal-builder. Only the traversal builder edits this file.
 *
 * Every magic number the traversal system uses lives here with a comment on
 * what it does, so a human can tune the feel without reading the physics.
 *
 * GLOBAL 25% TIME DILATION (k = 0.75):
 * Every trajectory keeps its EXACT geometric shape and is simply traversed
 * 25% more slowly. Fields are classified by units:
 *   length / distance / altitude          -> unchanged (x1)
 *   velocity (m/s)                        -> x0.75
 *   acceleration (m/s^2)                  -> x0.5625 (= 0.75^2)
 *   time / duration / interval (s)        -> x1.3333 (= 1/0.75)
 *   rate coefficient (1/s)                -> x0.75
 *   dimensionless (ratios, angles, counts)-> unchanged (x1)
 * Gravity is scaled at the use sites via `gravityScale` (0.5625) so falls
 * dilate with the rest of the world.
 */
export const SWING_TUNING = {
  // --- spawn ----------------------------------------------------------------
  /** Spawn point sits inside the guaranteed building-free grass plaza at the
   *  downtown core. A fresh run now starts STANDING on the ground, not
   *  airborne: the hero begins on the street grass, ready for the first web
   *  press or a jump. Height comes from the surface query (surface + stand
   *  height) and initial velocity is zero, so a changing city layout can never
   *  trap the player inside a building — the plaza guarantees open ground under
   *  (44, 46). */
  spawnPoint: { x: 44, z: 46 },

  // --- web / anchor ---------------------------------------------------------
  /** Max web reach / anchor query distance, metres. A CRUISING swing lives at
   *  25-120 m (docs/SHARED_TARGET.md) and needs an anchor above that, so the
   *  reach has to cover a rope of 40-70 m plus lateral offset. The old 60 m
   *  reach could only be satisfied by anchors close and low, which is what
   *  produced sub-street nadirs. */
  maxWebDistance: 126,
  /** Anchors on buildings whose top is at least this far above the player are
   *  accepted. This is the FLOOR; pick() raises it dynamically so the anchor is
   *  always high enough to hang a legal arc from (see nadirClearance). */
  minAnchorHeightAbove: 6,
  /** Shortest allowed rope, metres (keeps the constraint solvable). */
  minRope: 18,
  /** Tangential speed (m/s) injected at attach when the grab is head-on or
   *  near-vertical and leaves no usable tangential component. There is NO
   *  minimum-speed veto on attaching any more (iter1+iter2 P1): a press or a
   *  held web always gets to try, and a slow grab is fixed by injecting speed,
   *  not by refusing the player the only input that can save them.
   *  Dilated x0.75: 22.5 m/s. */
  minTangentialSpeed: 22.5,
  /** Min horizontal distance (m) from the player to a candidate anchor. Anchors
   *  almost directly overhead produce winch-like vertical swings with no arc. */
  minAnchorLateral: 24,
  /** Max horizontal distance (m) from the player to a candidate anchor. Wide
   *  enough to reach the far side of an avenue block; the nadir/reel gates in
   *  anchors.ts, not this number, are what stop a slingshot grab. */
  maxAnchorLateral: 90,
  /** Lateral offset (m) the picker scores as ideal — mid-corridor, so the
   *  distribution spreads across the band instead of piling at the ceiling. */
  idealLateral: 55,
  /** Max upward velocity (m/s) at which an automatic attach is allowed. A
   *  release throws the player up and forward; re-grabbing must wait until
   *  near the top of that ballistic arc, otherwise the chain ratchets.
   *  Dilated x0.75: 6 m/s. */
  attachMaxUpward: 6,
  /** Auto-attach ceiling, metres above the surface. High enough that the whole
   *  cruise band is attachable; validity (nadirClearance / reel budget) is what
   *  actually rejects a bad grab now, not altitude. */
  attachMaxAltitude: 135,
  /** Below this altitude, a held web may bypass rhythm gates to catch a
   *  street-level pull-out before the body lands. This is an attach rule, not
   *  a lift: if no legal anchor exists, gravity still wins. */
  urgentAttachAltitude: 16,
  /** A deliberate press is allowed up to this altitude. */
  pressMaxAltitude: 260,
  /** Minimum height (m) above the local surface that a swing's predicted nadir
   *  (pivot.y - rope) must clear. THE central fix of iteration 3: the measured
   *  failure was an attach at player y=1.60 / anchor y=35.0 / rope=42.26, whose
   *  rigid-pendulum nadir is -7.25 m, i.e. BELOW THE STREET. The rope is now
   *  ceilinged at pivot.y - (surface + this), so a sub-street nadir is not
   *  representable, and anchors that cannot satisfy it are rejected outright. */
  nadirClearance: 1,
  /** Where in the band we would LIKE the nadir to land; used for scoring only. */
  nadirTarget: 3,
  /** Highest nadir (m above surface) an anchor may produce. An anchor so tall
   *  that the arc never comes down parks the player above the band, where far
   *  fewer anchors are legal and the loop starves. The band has a top as well
   *  as a bottom (SHARED_TARGET: 25-120 m). */
  nadirMax: 86,
  /** How much longer than the rope ceiling the initial (no-teleport) rope may
   *  be, in METRES. The excess is reeled in during the downswing at reelInRate;
   *  anything beyond this cannot be reeled in before the bottom of the arc, so
   *  the anchor is rejected instead. An absolute budget (reelInRate x a typical
   *  0.8 s downswing) rather than a ratio: a ratio rejected almost every anchor
   *  hung off a modest building, which starved the loop and dropped the player.
   *  INVARIANT: reelBudget = reelInRate x downswing duration; reelInRate x0.75
   *  and the downswing x1.3333, so the budget (metres) is unchanged. */
  reelBudget: 14,
  /** Belt-and-braces ratio guard alongside reelBudget. */
  maxReelRatio: 1.75,
  /** Rope reel-in rate, m/s. Shortening the rope through the downswing is what
   *  lifts the nadir into the band AND adds energy (a real pump), instead of
   *  the old positional floor clamp that pasted the player onto the tarmac.
   *  Dilated x0.75: 7.5 m/s. */
  reelInRate: 7.5,
  /** How often (s) the system re-queries for an anchor while the web is held
   *  in the air — this bounds attach latency. Sub-second target. Queried at
   *  this rate inside the attach window even at terminal dive speed so the
   *  player grabs a web before reaching the facade.
   *  Dilated x1.3333: 0.0667 s. */
  attachQueryInterval: 0.0667,
  /** How many different lateral biases are tried to avoid re-picking the last
   *  structure before giving up on this query. */
  maxAnchorRetries: 6,
  /** Bonus lateral bias handed to the next query so swings alternate sides. */
  alternationBias: 0.5,
  /** Remember this many recent structure ids when avoiding re-picks. Kept low:
   *  the validity gates already reject most candidates, so a long memory
   *  starves the query and drops the player. */
  recentStructures: 2,

  // --- state timing ---------------------------------------------------------
  /** WEB_ATTACH -> SWING, seconds. The brief "line goes taut" beat.
   *  Dilated x1.3333: 0.1067 s. */
  attachTime: 0.1067,
  /** RELEASE -> AIRBORNE, seconds. Keeps RELEASE a readable state without
   *  stalling momentum.
   *  Dilated x1.3333: 0.0667 s. */
  releaseTime: 0.0667,

  // --- pendulum -------------------------------------------------------------
  /** Fraction of rope reeled in per second while pumping (moveY > 0).
   *  Reeling in converts height into speed and tightens the arc.
   *  Dilated x0.75: 0.045 /s. */
  ropePump: 0.045,
  /** m/s^2 added along the swing tangent by forward input.
   *  Dilated x0.5625: 21.375 m/s^2. */
  tangentialAccel: 21.375,
  /** m/s^2 added around the anchor (perpendicular to the swing plane) by
   *  lateral input — this is what carves the plane across an avenue.
   *  Dilated x0.5625: 10.125 m/s^2. */
  lateralAccel: 10.125,
  /** Planar speed (m/s) the swing governor holds. ENERGY MANAGEMENT: a real
   *  swing pumps on the downswing and exits near maximum forward velocity; the
   *  measured build converted 95% of speed into altitude (42.8 -> 2.2 m/s
   *  across one upswing) because nothing put energy back. The governor is a
   *  tangential accel proportional to the deficit below this speed, so a swing
   *  settles into a limit cycle instead of decaying to a stall.
   *  Dilated x0.75: 45 m/s. */
  cruiseSpeed: 45,
  /** Max m/s^2 the governor may add along the tangent.
   *  Dilated x0.5625: 11.25 m/s^2. */
  governorAccel: 11.25,
  /** Governor gain, (m/s^2) per (m/s) of deficit.
   *  Dilated x0.75: 0.675 /s. */
  governorGain: 0.675,
  /** Max m/s^2 the same governor may add along the direction of travel while
   *  AIRBORNE. Without it the ballistic leg between two swings bleeds speed and
   *  the next grab happens slow and low — the front half of the vicious cycle.
   *  Dilated x0.5625: 3.375 m/s^2. */
  airGovernorAccel: 3.375,
  /** Gravity multiplier while the player is RISING under the web. Full gravity
   *  on the downswing (that is where the speed comes from), reduced on the
   *  upswing so the arc does not pay for altitude entirely out of speed.
   *  Dimensionless multiplier: unchanged. */
  upswingGravity: 1.0,
  /** Tangential drag (1/s multiplier) so swings don't run away forever.
   *  Dilated x0.75: 0.0375 /s. */
  swingDrag: 0.0375,
  /** Minimum time (s) in SWING before the dead-hang watchdog may force an
   *  early release. Ordinary auto-release is arc-phase driven instead: descend
   *  through the nadir, climb, then exit near the forward-speed peak.
   *  Dilated x1.3333: 2.0667 s. */
  minSwingTime: 2.0667,
  /** Maximum time (s) in SWING. Bounds the dead-hang case the iter2 critic
   *  flagged as the one un-watchdogged state.
   *  Dilated x1.3333: 6.4 s. */
  maxSwingTime: 6.4,
  /** Rope angle from straight-down (radians) at which a HELD web auto-releases
   *  on the way up. ~26 deg puts the exit velocity 26 deg above horizontal:
   *  most of the speed stays planar, the rest buys the ballistic arc that
   *  carries the player to the next anchor without ever touching the ground.
   *  Angle: unchanged. */
  autoReleaseAngle: 0.56,
  /** Vertical speed that marks a real descent before a physics-driven release
   *  can arm. This replaces the old timer floor as the primary release gate.
   *  Dilated x0.75: 1.5 m/s. */
  releaseDescendSpeed: 1.5,
  /** Vertical speed on the climb that confirms the swing has crossed its
   *  nadir and is exiting the speed-building half of the arc.
   *  Dilated x0.75: 1.125 m/s. */
  releaseRiseSpeed: 1.125,
  /** Do not auto-release a held web after the nadir until planar speed is still
   *  close to the best speed this arc has produced. */
  releasePeakRatio: 0.86,
  /** Seconds after a release before the next attach may fire. Stops a re-grab
   *  on the frame after release (which reads as a stutter, not a chain).
   *  Dilated x1.3333: 6.1333 s. */
  reattachLock: 6.1333,
  /** Height (m) above the local surface below which a SOFT upward repulsion is
   *  blended into the swing. This is a FORCE, never a positional clamp — the
   *  iter2 critic failed the old `swingFloor` clamp for pinning 39-49% of swing
   *  frames to a straight horizontal line at y = surface + 0.8 m. */
  softFloor: 1,
  /** Peak upward accel (m/s^2) of that repulsion at zero altitude.
   *  Dilated x0.5625: 16.875 m/s^2. */
  groundRepel: 16.875,
  /** How far ahead along travel (m) the swing samples the surface when deciding
   *  the rope ceiling and the repulsion. "The surface below" in the shared bar
   *  includes ROOFTOPS, so an arc that clears the street but skims a tower roof
   *  is still out of band — and would collide. Reeling in early lifts the arc
   *  over the obstacle instead of into it. */
  lookAhead: 54,
  /** Spacing (m) of those look-ahead samples. 3 samples; cheap. */
  lookAheadStep: 18,

  // --- release / launch -----------------------------------------------------
  /** m/s impulse added along horizontal travel on release (punchy exit).
   *  Dilated x0.75: 7.5 m/s. */
  releaseBoost: 7.5,
  /** Max upward velocity kept on release. This is release shaping, not a
   *  flight assist: the pendulum keeps its forward energy, but a late upswing
   *  cannot loft the player above the readable city for several seconds.
   *  Dilated x0.75: 22.5 m/s. */
  releaseMaxUp: 22.5,
  /** m/s upward impulse on the apex jump (Space while swinging).
   *  Dilated x0.75: 12 m/s. */
  launchBoostUp: 12,
  /** m/s forward impulse along the swing tangent on the apex jump.
   *  Dilated x0.75: 7.5 m/s. */
  launchBoostFwd: 7.5,

  // --- air ------------------------------------------------------------------
  /** m/s^2 air-control acceleration from steer input (before the speed
   *  falloff). Raised so the ballistic leg between two swings holds cruise
   *  speed instead of bleeding to a slow, low re-grab.
   *  Dilated x0.5625: 11.25 m/s^2. */
  airAccel: 11.25,
  /** Multiplier on the LATERAL (A/D) air-control term only. The player turns on
   *  the spot 50% faster in the air without the forward (W) thrust changing, so
   *  steering authority goes up while the airborne speed profile stays put.
   *  Dimensionless multiplier: unchanged. */
  airTurnBoost: 2.5,
  /** Air drag (1/s multiplier).
   *  Dilated x0.75: 0.01875 /s. */
  airDrag: 0.01875,
  /** Extra m/s^2 downward while diving (tuck to trade height for speed).
   *  Dilated x0.5625: 22.5 m/s^2. */
  diveAccel: 22.5,
  /** Drag while diving — much lower so dives keep building speed.
   *  Dilated x0.75: 0.015 /s. */
  diveDrag: 0.015,
  // --- dash / zip -----------------------------------------------------------
  /** Dash speed, m/s.
   *  Dilated x0.75: 78.75 m/s. */
  dashSpeed: 78.75,
  /** Dash duration, seconds.
   *  Dilated x1.3333: 0.4267 s. */
  dashTime: 0.4267,
  /** Fraction of dash speed kept at the end (momentum into the exit).
   *  Dimensionless fraction: unchanged. */
  dashDecel: 0.55,
  /** Raycast distance for the dash target, metres. */
  dashRange: 150,
  /**
   * Min cosine alignment (horizontal) between steered dash aim and an anchor
   * hit for the optional mild snap. Unused while dashAnchorSnap is 0.
   * 0.85 ≈ 32° cone.
   */
  dashAnchorAlignMin: 0.85,
  /**
   * Blend weight toward an on-axis anchor when steering is held.
   * 0 = steering wins outright (chosen: owner asked for WASD control; even a
   * mild snap yanked aim toward whichever façade the ray grazed). >0 re-enables
   * planar-only assist gated by dashAnchorAlignMin.
   */
  dashAnchorSnap: 0,
  /**
   * Seconds between dashes, measured from ACTIVATION (not from the end of the
   * zip), so the whole move is one 5 s cycle and the usable wait after the
   * 0.4267 s dash is ~4.57 s. Owner-specified.
   *
   * NOT time-dilated. Every other duration in this file carries a x1.3333
   * dilation factor because it is a physics timing that has to stay in step
   * with the dilated velocities; this one is a PLAYER-FACING budget the owner
   * named in real seconds, and the HUD counts it down in real seconds. Dilating
   * it would put 6.67 on screen where 5 was asked for.
   */
  dashCooldown: 5,

  // --- limits ---------------------------------------------------------------
  /** Max planar (horizontal) speed, m/s.
   *  DELIBERATE CONFLICT, resolved by docs/SHARED_TARGET.md: FEEL_SPEC and the
   *  iter2 traversal critic both say 28-48 m/s and "do not raise it". The
   *  shared cross-system bar requires planar speed ABOVE 45 m/s for 80% of a
   *  run, which a 48 m/s ceiling cannot deliver with any headroom. SHARED_TARGET
   *  explicitly supersedes per-system optimisation, so the cap moves to leave
   *  room above the 45 m/s line; cruiseSpeed (45) is where the governor sits.
   *  Dilated x0.75: 63 m/s. */
  maxAirSpeed: 63,
  /** Terminal fall speed, m/s.
   *  Dilated x0.75: 46.5 m/s. */
  maxFallSpeed: 46.5,
  /** Hard cap on total speed magnitude, m/s (incl. vertical).
   *  Dilated x0.75: 84 m/s. */
  maxTotalSpeed: 84,

  // --- ground ---------------------------------------------------------------
  /** Distance below which the body counts as on the surface. */
  standHeight: 1.6,
  /** Fraction of horizontal speed kept when landing. */
  landDamp: 0.8,
  /** Legacy timer from the removed auto-launch. Kept so old probes that read
   *  it do not blow up; the player-initiated ground web pull does NOT wait.
   *  Dilated x1.3333: 0.24 s. */
  landedRecoverTime: 0.24,
  /** m/s upward impulse of a GENUINE ground web pull — the vertical half of the
   *  "haul yourself up the lines" beat, applied only once an anchor is attached
   *  and a rope is visible. It is NOT a no-anchor fallback any more: firing
   *  this with anchor === null is what read as levitating with no web.
   *  Dilated x0.75: 27 m/s. */
  recoverLaunchUp: 27,
  /** m/s forward impulse of that same attached ground pull.
   *  Dilated x0.75: 16.5 m/s. */
  recoverLaunchFwd: 16.5,
  // --- ground web pull: its own anchor gates ---------------------------------
  //
  // WHY THESE ARE SEPARATE NUMBERS. The ground pull is already the deliberately
  // relaxed path (beginGroundPullAttach ignores reelBudget), and it has to work
  // from a standstill in a LOW-RISE STREET, where the airborne gates have
  // nothing to offer: minRope 18 + nadirClearance 1 means an anchor must sit
  // 19 m above the road, and minAnchorLateral 24 rejects the facade you are
  // standing next to for being too close. Measured over 397 random street
  // positions, 15.1% of ground presses found NO legal anchor — 24.0% in the
  // low-rise outskirts. Every one of those was the reported bug: an upward
  // launch with no rope.
  //
  // These gates exist so relaxing the street case cannot loosen mid-air anchor
  // selection, which is separately tuned and works.
  /** Shortest rope a street-level pull may hang. Sized off the city's minimum
   *  building: the roof anchor of a building of height h sits at h + 1.6, and
   *  the city prefilter compares BUILDING height against
   *  surface + groundPullNadirClearance + groundPullMinRope, so the smallest
   *  usable building is exactly 12 m tall. A 4-storey (14 m) city minimum
   *  clears that by 2 m. */
  groundPullMinRope: 10,
  /** Min horizontal distance (m) to a ground-pull anchor. The airborne 24 m
   *  exists to stop winch-like near-vertical arcs at cruise speed; from a
   *  standstill the near facade is the whole point of the move.
   *
   *  Was 14. Lowered to match pressMinLateral, because 14 m still rejected the
   *  building the player was standing against and pointing at — the same dead
   *  click, just on the street instead of in the air. Six metres is the floor
   *  that keeps the line off vertical; anything above that is the player's
   *  call, not the tuning's. */
  groundPullMinLateral: 6,
  /** Nadir clearance (m) for a ground-pull arc. HIGHER than the airborne
   *  nadirClearance of 1: a short rope swings through a tight arc, so the same
   *  1 m of headroom leaves much less room for error at the bottom. Two metres
   *  puts the body above the standHeight of 1.6 m at the nadir. */
  groundPullNadirClearance: 2,
  /** Query directions (degrees off the player's aim) a ground pull sweeps
   *  through, in order, looking for a building to grab.
   *
   *  The city's anchor query keeps only anchors in the FORWARD HEMISPHERE of
   *  the direction it is handed, so a single query can only ever web what the
   *  player is already looking at. Airborne that is right — you grab ahead of
   *  travel. From a standstill it is the difference between "there is nothing
   *  to web here" and "there is nothing to web in this one direction", and the
   *  measured street samples say it is usually the second. One entry per
   *  retry, so the sweep costs exactly the same seven queries as before. */
  groundPullAimSweepDeg: [0, 48, -48, 96, -96, 152, -152],
  /** Score penalty per FULL 180 deg a candidate is off the player's aim, so the
   *  building being looked at wins whenever it is legal and the sweep only
   *  decides what happens when it is not. */
  groundPullAimPenalty: 1.1,
  /** Extra m/s along the web toward the pivot when a genuine ground-pull
   *  attach lands — the "yank yourself up the lines" beat. Stacks with the
   *  recoverLaunch* components so the first frame already leaves the street.
   *  Dilated x0.75: 21 m/s. */
  groundPullYankAlong: 21,
  /** Rope reel-in rate (m/s) while a ground-pull attach is still winching the
   *  long street-level rope down to a legal nadir ceiling. Faster than the
   *  normal reelInRate so the yank reads as two hands hauling, not a slow
   *  winch, and so the nadir never dips sub-street. Cleared once the rope is
   *  at the ceiling.
   *  Dilated x0.75: 36 m/s. */
  groundPullReelRate: 36,

  // --- aimed press: the player's own shot ------------------------------------
  //
  // WHY THIS PATH EXISTS. Everything above governs the AUTOMATIC attach — the
  // held web that keeps the swing rhythm going, tuned against the reference
  // pack and deliberately picky, because a bad automatic grab ruins an arc the
  // player did not ask for. But the same gates were also deciding what happened
  // when the player DELIBERATELY CLICKED, and there they read as a dead button:
  // the façade you are looking at is rejected for being closer than
  // minAnchorLateral (24 m), a long rope is rejected by reelBudget, and a click
  // in the first reattachLock seconds after a release does nothing at all. The
  // owner's report was exactly that — "muchos clicks sin lanzar ninguna
  // telaraña".
  //
  // So a press now takes its own path with its own numbers. Two rules keep this
  // from becoming a back door into the tuned automatic attach:
  //   1. Every gate here is a separate `press*` constant. Loosening the manual
  //      shot can never loosen automatic anchor selection.
  //   2. nadirClearance is NOT relaxed. It is the one gate that stops a swing
  //      passing under the street, so the aimed path CLAMPS the rope to the
  //      legal ceiling and reels the excess in fast — it never attaches to an
  //      arc that would put the body through the tarmac.
  /** Reach (m) of a deliberate aimed shot. Longer than maxWebDistance: the
   *  player is pointing at a specific building and expects to hit it. */
  pressWebRange: 150,
  /** Min horizontal distance (m) to an aimed anchor. The airborne 24 m exists
   *  to stop winch-like near-vertical arcs at cruise speed; when the player
   *  aims at a façade beside them, that near line IS the shot they asked for.
   *  Six metres still rejects an anchor essentially straight overhead. */
  pressMinLateral: 6,
  /** Shortest rope an aimed shot may hang. Below this the constraint solve gets
   *  stiff and the "swing" is really a yank. */
  pressMinRope: 8,
  /** Rope reel-in rate (m/s) while an aimed attach is winching a long shot down
   *  to its legal ceiling. Between reelInRate (7.5, a slow pump) and
   *  groundPullReelRate (36, a two-handed haul): the excess has to be gone
   *  before the nadir, but an aimed mid-air shot should still read as a rope
   *  going taut rather than a winch. */
  pressReelRate: 24,
  /** Query directions (degrees off the player's aim) an aimed press sweeps when
   *  the crosshair raycast misses. Much narrower than groundPullAimSweepDeg
   *  (which reaches +/-152 deg, because from a standstill "nothing in front of
   *  me" should still find a building): a press in the air is a statement about
   *  WHERE, so a shot must never fire behind the player. +/-52 deg is the widest
   *  that still reads as "roughly where I was pointing". */
  pressAimSweepDeg: [0, 14, -14, 30, -30, 52, -52],
  /** Score penalty per FULL 180 deg a candidate is off the player's aim. Higher
   *  than groundPullAimPenalty: on an aimed shot, agreeing with the crosshair
   *  matters more than the quality of the resulting arc. */
  pressAimPenalty: 2.2,
  /** Altitude (m) below which a descending, un-webbed player with no legal
   *  anchor gets an emergency web-line lift instead of being allowed to fall to
   *  the street. This is the recovery move that lets the attach gates REFUSE a
   *  bad anchor rather than take the least-bad one. */
  rescueAltitude: 14,
  /** m/s upward impulse of that rescue.
   *  Dilated x0.75: 12 m/s. */
  rescueLiftUp: 12,
  /** Seconds between rescues, so it can never become a hover.
   *  Dilated x1.3333: 2.6667 s. */
  rescueCooldown: 2.6667,
  /** Look-ahead clearance floor (m) on the BALLISTIC leg between two swings.
   *  The player is airborne for most of a run; without this the arc clips tower
   *  roofs. Expressed as a target CLIMB RATE rather than an acceleration, so
   *  clearing a tower cannot pump energy in and fling the player over the top
   *  of the band once the tower is behind them. */
  airFloor: 12,
  /** Max climb rate (m/s) that clearance may ask for, at zero clearance.
   *  Dilated x0.75: 6 m/s. */
  airFloorLift: 6,
  /** How fast (m/s^2) the climb rate is reached.
   *  Dilated x0.5625: 15.75 m/s^2. */
  airFloorAccel: 15.75,
  /** Altitude (m) above which extra downward accel is blended in. The shared
   *  bar has a TOP (120 m) as well as a bottom: above the skyline there is
   *  nothing to grab, nothing to read as speed, and the corridor is not in
   *  frame. The mirror image of the rescue lift, and the same shape: a bounded
   *  force, not a clamp. */
  ceilingAltitude: 100,
  /** Peak extra downward accel (m/s^2) once well above ceilingAltitude.
   *  Dilated x0.5625: 20.25 m/s^2. */
  ceilingPull: 20.25,
  /** Metres above ceilingAltitude at which that pull saturates. */
  ceilingRamp: 28,
  /** m/s^2 acceleration while walking on the ground.
   *  Dilated x0.5625: 25.3125 m/s^2. */
  groundAccel: 25.3125,
  /** Ground friction (1/s multiplier).
   *  Dilated x0.75: 1.875 /s. */
  groundDrag: 1.875,
  /** m/s upward velocity when jumping from the ground.
   *  Dilated x0.75: 12 m/s. */
  jumpSpeed: 12,

  // --- un-stick watchdog ----------------------------------------------------
  /** Speed magnitude (m/s) below which the player counts as stuck.
   *  Dilated x0.75: 0.375 m/s. */
  unstickSpeed: 0.375,
  /** Seconds below unstickSpeed (outside LANDED/PERCH) before the watchdog
   *  forces a recovery: FALLING + outward push.
   *  Dilated x1.3333: 0.4667 s. */
  unstickTimeout: 0.4667,
  /** m/s impulse applied along the outward contact normal when un-stuck.
   *  Dilated x0.75: 6 m/s. */
  unstickPush: 6,

  // --- facade contact -------------------------------------------------------
  /** Tangential speed kept once when entering a facade contact. This is a
   *  one-time restitution loss, not a per-fixed-step scrape multiplier. */
  facadeSlideDamping: 0.9,
  /** Small outward speed required after a facade contact so the player exits
   *  the contact plane instead of being re-solved against it every step.
   *  Dilated x0.75: 5.25 m/s. */
  facadeExitSpeed: 5.25,
  /** Share of incoming normal speed returned as outward separation. Low enough
   *  that a head-on wall hit costs momentum, high enough that it cannot become
   *  a zero-planar weld. */
  facadeNormalRestitution: 0.18,
  /** Cap on outward normal velocity added by facade contact.
   *  Dilated x0.75: 13.5 m/s. */
  facadeExitMaxSpeed: 13.5,
  /** Metres to place the body outside the contacted facade after a swept hit. */
  facadeContactMargin: 0.45,
  /** Clearance probe distance used to decide when a facade contact has really
   *  exited and may pay a new one-time restitution loss. */
  facadeExitClearance: 1.2,
  /** Normals within this dot product are considered the same persisted contact. */
  facadeSameNormalDot: 0.92,
  /** Minimum share of incoming planar speed that must survive a facade hit. */
  facadeMinPlanarKeep: 0.62,
  /** Maximum m/s of planar speed a facade hit may remove in one fixed step.
   *  Dilated x0.75: 18 m/s. */
  facadeMaxPlanarLoss: 18,

  // --- wall run -------------------------------------------------------------
  /** Metres behind the player to probe for sustained facade contact. */
  wallRunContactProbe: 0.85,
  /** Minimum speed carried into a wall-run so a facade hit becomes motion.
   *  Dilated x0.75: 25.5 m/s. */
  wallRunMinSpeed: 25.5,
  /** Share of entry planar speed kept when converting a facade hit into a run. */
  wallRunSpeedKeep: 0.92,
  /** Maximum total speed allowed while wall-running.
   *  Dilated x0.75: 58.5 m/s. */
  wallRunMaxSpeed: 58.5,
  /** Small along-wall component kept even on head-on upward runs. */
  wallRunSideFloor: 0.28,
  /** Gravity multiplier while feet are driving on the facade. Dimensionless
   *  multiplier: unchanged; the global gravityScale handles the dilation. */
  wallRunGravityScale: 0.09,
  /** Acceleration along the current wall-run direction.
   *  Dilated x0.5625: 10.125 m/s^2. */
  wallRunAccel: 10.125,
  /** Extra acceleration from held forward input during the run.
   *  Dilated x0.5625: 5.625 m/s^2. */
  wallRunInputAccel: 5.625,
  /** Lateral steering acceleration along the wall face.
   *  Dilated x0.5625: 6.75 m/s^2. */
  wallRunLateralAccel: 6.75,
  /** Drag while running on a facade; the state naturally decays.
   *  Dilated x0.75: 0.135 /s. */
  wallRunDrag: 0.135,
  /** Minimum speed before the run falls away from the wall.
   *  Dilated x0.75: 9.75 m/s. */
  wallRunExitSpeed: 9.75,
  /** Maximum duration of one continuous wall-run.
   *  Dilated x1.3333: 2.9333 s. */
  wallRunMaxTime: 2.9333,
  /** Outward speed when the player peels off a slow wall-run.
   *  Dilated x0.75: 6 m/s. */
  wallRunExitPush: 6,
  /** How deep to search inward for the facade after a probe miss, so a tier or
   *  setback continues the run instead of ending it. Metres. */
  wallRunReacquireDepth: 3.4,
  /** Grace period after losing the surface entirely before the run ends.
   *  Keeps a run alive across seams without letting it float in open air.
   *  Dilated x1.3333: 0.2933 s. */
  wallRunCoyoteTime: 0.2933,
  /** Outward impulse for jumping off a wall-run.
   *  Dilated x0.75: 21 m/s. */
  wallJumpAway: 21,
  /** Speed retained along the wall-run direction on wall jump.
   *  Dilated x0.75: 19.5 m/s. */
  wallJumpAlong: 19.5,
  /** Extra upward impulse on wall jump.
   *  Dilated x0.75: 12 m/s. */
  wallJumpUp: 12,

  // --- lean -----------------------------------------------------------------
  /** Max signed lean during SWING (camera roll + pose). */
  leanSwing: 0.85,
  /** Max signed lean while airborne. */
  leanAir: 0.5,
  /** Lateral speed (m/s) at which lean saturates.
   *  Dilated x0.75: 33.75 m/s. */
  leanSpeed: 33.75,
  /** Rate (1/s) at which lean eases toward its target.
   *  Dilated x0.75: 6 /s. */
  leanSmoothing: 6,

  // --- gravity dilation -----------------------------------------------------
  /** Gravity multiplier. 0.5625 = 0.75^2, the acceleration term of the
   *  global 25% time dilation. Trajectory shapes are unchanged; they are
   *  simply traversed 25% slower. Applied at every GLOBALS.gravity use site. */
  gravityScale: 0.5625,
} as const;