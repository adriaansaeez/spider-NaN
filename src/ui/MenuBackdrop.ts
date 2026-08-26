import type { PlayerSnapshot, System, UpdateContext } from '../contracts';
import { GLOBALS } from '../contracts/globals';
import type { FreeCameraPose } from '../core/Telemetry';
import { avenueX, streetZ } from '../city/gen';
import { MainMenu } from './MainMenu';

/**
 * OWNER: ui. The title-screen shot.
 *
 * THE IDEA. A main menu that floats over a frozen grey world says "engine
 * demo". A main menu that looks through a fixed lens at a living street says
 * "game". So the backdrop is one locked camera — no orbit, no drift, no
 * Ken Burns — pointed down an avenue at the hero, with everything BEHIND that
 * lens still running: traffic, the day/night cycle, window lights, the sun's
 * own shadow rig, and the hero's breathing idle. The stillness of the camera is
 * what makes the motion in the frame read.
 *
 * WHAT THIS FILE IS NOT. It owns no scene objects, no lights, no character and
 * no camera of its own. Every one of those already exists and is already
 * correct; a second copy would be a second thing to keep in sync and a second
 * GLB to download. This file only decides WHERE the existing camera stands,
 * WHERE the existing hero stands, and WHICH of the existing systems keep
 * ticking while the game is paused. That is the whole design.
 *
 * ACTIVATION. `MainMenu` publishes its screen on `#game-ui[data-mode]`; this
 * watches that attribute and nothing else, so the two files never touch:
 *   main | modes     -> active
 *   playing | pause  -> inactive
 *   settings         -> UNCHANGED, because Settings opens from both the title
 *                       screen and the pause menu. Treating it as either one
 *                       would snap the camera on every visit to Settings.
 *
 * The automation harness bypasses the menu entirely (`navigator.webdriver`), so
 * this must never arm there — a critic screenshot of the title-screen lens
 * instead of the chase camera would be a silent, very confusing failure.
 */

/**
 * The shot. Every number is world metres unless noted, and every one was set by
 * looking at the render, not by arithmetic — see docs/ui/MENU.md for the
 * captures. The city is deterministic (GLOBALS.worldSeed), so this composition
 * is reproducible frame for frame.
 */
const SHOT = {
  /** Which avenue we stand in the middle of. Avenues run north-south (+Z). */
  avenue: 0,
  /** The cross street the shot is anchored to... */
  street: 0,
  /** ...and how far up the avenue from it the hero stands, clear of the junction. */
  along: 34,

  /**
   * Lateral offsets from the avenue centreline. NOTE THE HANDEDNESS: the lens
   * looks along +Z with +Y up, so the camera's RIGHT is world -X. Putting the
   * camera at a LARGER x than the hero is what lands him right of centre, with
   * the avenue's vanishing point falling to his left — a subject and a depth
   * cue, rather than one bullseye down the middle.
   */
  heroOffsetX: 1.15,
  camOffsetX: 1.75,

  /** The lens: this far down-avenue of the hero (-Z), at eye height. */
  camBack: 2.6,
  camHeight: 2.3,

  /**
   * Aim. A point far up the avenue, so the optical axis lies along the street
   * and the facades converge properly; the hero is framed by standing him off
   * that axis, never by pointing the camera at him. `lookHeight` above the eye
   * tilts the lens up just enough to crop him at the thigh and leave the sky
   * wedge between the rooflines in frame.
   */
  lookAhead: 90,
  lookHeight: 2.75,
  lookOffsetX: 1.65,

  /**
   * 36 degrees, against the chase camera's 70. A long lens compresses the
   * avenue behind the hero into the stacked wall of facades the shot is about;
   * at 70 the same street reads as an empty plaza and the face fisheyes.
   */
  fov: 36,

  /**
   * Afternoon, and this number is a MEASUREMENT, not a mood board.
   *
   * The sun's azimuth in DayNightSystem sweeps along +/-X while avenues run
   * along +/-Z, so a low sun never comes down an avenue — it comes ACROSS one,
   * and this city's shortest building is 70 m. Past about t=0.65 the whole 22 m
   * canyon drops into its own shadow and the hero renders as the black
   * silhouette this shot exists to avoid. The band from 0.55 to 0.62 was swept
   * against the final lens (docs/ui/MENU.md lists the frames): the terminator
   * crawls across the road as the sun drops, and at 0.58-0.62 it lands on the
   * hero and cuts him in half. 0.55 puts him in full sun against asphalt that is
   * still in shade — a lit subject on a dark ground, one facade wall raking
   * warm, and his own cast shadow on the road beside him.
   *
   * There is no glow card, no halo, no bloom and no colour wash anywhere in this
   * file. Everything above is the scene's own directional sun.
   */
  timeOfDay: 0.55,
  /**
   * Seconds per full day WHILE THE MENU IS UP. The cycle keeps running — the
   * light must not be a still frame — but at gameplay's 240 s a player reading
   * the menu for a minute would watch the sun set on them. 2400 s drifts about
   * 0.025 a minute, which holds the graded light for any realistic visit while
   * still genuinely moving. Restored on exit.
   */
  cycleSeconds: 2400,
} as const;

/** The systems the backdrop keeps ticking, and the two knobs it borrows. */
export interface MenuBackdropDeps {
  /**
   * Ticked every frame while the title screen is up, in this order. Deliberately
   * a subset of Game's list: input, traversal, camera and score all belong to a
   * RUN, and a menu that quietly accumulated a score or moved the player would
   * be a bug, not atmosphere.
   */
  ambient: readonly System[];
  /** The shared player state. While the backdrop owns the frame, so does it. */
  player: PlayerSnapshot;
  /** Ground height under a world point, for standing the hero on the street. */
  surfaceHeightAt(x: number, z: number): number;
  /** Day/night knobs. Read on activate, restored on deactivate. */
  dayNight: { timeOfDay: number; cycleSeconds: number; paused: boolean };
  /** Pose + drop the hero here and stream the city around him, synchronously. */
  placePlayer(x: number, y: number, z: number, freeze: boolean): void;
  /** Hand the player back to the traversal solver. */
  unfreezePlayer(): void;
  /** The existing free-camera path (Telemetry.setFreeCamera). Not a second camera. */
  setFreeCamera(pose: FreeCameraPose | null): void;
  /** Pose-and-lights-only mode on FxSystem; see FxSystem.setAmbientOnly. */
  setFxAmbientOnly(on: boolean): void;
}

type UiMode = string | undefined;

export class MenuBackdrop {
  private active = false;
  private observer: MutationObserver | null = null;
  private root: HTMLElement | null = null;
  /** Its own clock: Game's frame counter belongs to the run, not to the menu. */
  private elapsed = 0;
  private frame = 0;
  private readonly ctx: UpdateContext = { dt: 0, elapsed: 0, frame: 0 };

  /** Day/night state as we found it, so exiting the menu changes nothing. */
  private restore: { timeOfDay: number; cycleSeconds: number; paused: boolean } | null = null;

  /** The hero's world position for this shot, resolved once at construction. */
  private readonly heroX: number;
  private readonly heroZ: number;
  private readonly pose: FreeCameraPose;
  /**
   * Unit vector from the hero toward the lens. The rig takes its facing from
   * the snapshot's velocity — that is the only facing channel the contract has
   * — so "look at camera" is written as a walk-speed velocity pointed at the
   * camera with `speed` left at zero, which is what keeps the Idle clip playing
   * rather than the run cycle. Re-asserted every frame; nothing else writes it
   * while traversal is parked.
   */
  private readonly faceX: number;
  private readonly faceZ: number;

  constructor(private readonly deps: MenuBackdropDeps) {
    const ax = avenueX(SHOT.avenue, GLOBALS.worldSeed);
    const sz = streetZ(SHOT.street, GLOBALS.worldSeed);
    this.heroX = ax + SHOT.heroOffsetX;
    this.heroZ = sz + SHOT.along;

    const camX = ax + SHOT.camOffsetX;
    const camZ = this.heroZ - SHOT.camBack;
    const ground = deps.surfaceHeightAt(camX, camZ);
    this.pose = {
      x: camX,
      y: ground + SHOT.camHeight,
      z: camZ,
      lookAtX: ax + SHOT.lookOffsetX,
      lookAtY: ground + SHOT.lookHeight,
      lookAtZ: camZ + SHOT.lookAhead,
      fov: SHOT.fov,
    };

    const dx = camX - this.heroX;
    const dz = camZ - this.heroZ;
    const len = Math.hypot(dx, dz) || 1;
    this.faceX = dx / len;
    this.faceZ = dz / len;

    // The harness never sees a menu, so it must never see this. Bail before the
    // observer exists rather than filtering inside it: nothing to disarm later.
    if (MainMenu.shouldBypassForHarness()) return;

    this.root = document.getElementById('game-ui');
    if (!this.root) return;
    this.observer = new MutationObserver(() => this.syncTo(this.root?.dataset.mode));
    this.observer.observe(this.root, { attributes: true, attributeFilter: ['data-mode'] });
    // The menu has already rendered by the time Game constructs us, so the
    // opening screen arrives as an initial READ, never as a mutation.
    this.syncTo(this.root.dataset.mode);
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * One frame of the title screen. Game calls this INSTEAD of its own update
   * loop while paused, so the run's clock, frame counter and systems are all
   * untouched by however long someone sits on the menu.
   */
  update(rawDt: number): void {
    if (!this.active) return;
    const dt = Math.min(rawDt, GLOBALS.maxDeltaSeconds);
    this.elapsed += dt;
    this.frame++;
    this.ctx.dt = dt;
    this.ctx.elapsed = this.elapsed;
    this.ctx.frame = this.frame;

    this.holdHero(dt);
    for (const s of this.deps.ambient) s.update(this.ctx);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.active) this.deactivate();
  }

  // ---------------------------------------------------------------------------

  private syncTo(mode: UiMode): void {
    // Settings is reachable from BOTH the title screen and the pause menu, so it
    // carries no information about which one we are in. Holding the current
    // state is the whole reason opening Settings mid-run does not cut to the
    // title-screen lens and back.
    if (mode === 'settings' || mode === undefined) return;
    const want = mode === 'main' || mode === 'modes';
    if (want === this.active) return;
    if (want) this.activate();
    else this.deactivate();
  }

  private activate(): void {
    this.active = true;
    const dn = this.deps.dayNight;
    this.restore = { timeOfDay: dn.timeOfDay, cycleSeconds: dn.cycleSeconds, paused: dn.paused };
    dn.timeOfDay = SHOT.timeOfDay;
    dn.cycleSeconds = SHOT.cycleSeconds;
    dn.paused = false;

    this.deps.setFxAmbientOnly(true);

    // Stand him on the street. `placePlayer` streams the city around the point
    // synchronously, so the first rendered menu frame already has its buildings
    // rather than popping them in over the next second.
    const ground = this.deps.surfaceHeightAt(this.heroX, this.heroZ);
    this.deps.placePlayer(this.heroX, ground + HERO_STAND_HEIGHT, this.heroZ, true);
    // He has been standing here for zero seconds, not for however long the last
    // run's final state lasted — the motion layer reads this.
    this.deps.player.stateTime = 0;
    this.holdHero(0);
    this.deps.setFreeCamera(this.pose);
  }

  private deactivate(): void {
    this.active = false;
    this.deps.setFreeCamera(null);
    this.deps.setFxAmbientOnly(false);
    this.deps.unfreezePlayer();
    if (this.restore) {
      const dn = this.deps.dayNight;
      dn.timeOfDay = this.restore.timeOfDay;
      dn.cycleSeconds = this.restore.cycleSeconds;
      dn.paused = this.restore.paused;
      this.restore = null;
    }
    // Deliberately does NOT move the player back. Every path out of the title
    // screen into a run goes through Game's reset(), which respawns him; every
    // path into the pause menu never came through here at all.
  }

  /**
   * Re-assert the hero's state each frame. Traversal is parked while the menu is
   * up, so nothing else is writing this — but FxSystem reads it, and a state
   * that drifts is a hero who wanders out of a locked shot.
   */
  private holdHero(dt: number): void {
    const p = this.deps.player;
    p.stateTime += dt;
    p.position.set(
      this.heroX,
      this.deps.surfaceHeightAt(this.heroX, this.heroZ) + HERO_STAND_HEIGHT,
      this.heroZ,
    );
    // See `faceX`: direction only. `speed` stays 0, which is what selects the
    // Idle clip and arms the breathing sway rather than the run cycle.
    p.velocity.set(this.faceX * FACING_VELOCITY, 0, this.faceZ * FACING_VELOCITY);
    p.speed = 0;
    p.state = 'IDLE';
    p.altitude = 0;
    p.lean = 0;
    p.anchorPosition = null;
    p.ropeLength = 0;
    p.justAttached = false;
    p.justReleased = false;
    p.justGroundPull = false;
  }
}

/**
 * The hero's pivot is his HIPS (CharacterModel hangs the rig by them), and the
 * traversal solver rests a standing player at this height above the surface.
 * Matching it here is what makes the menu hero stand exactly the way the played
 * hero does — one number, not a second convention.
 */
const HERO_STAND_HEIGHT = 1.6;

/**
 * Magnitude of the facing velocity. Only its DIRECTION is read (CharacterModel
 * ignores anything under 0.5 m/s so a resting hero does not spin on noise), so
 * this just has to clear that gate.
 */
const FACING_VELOCITY = 1;
