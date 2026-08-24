import * as THREE from 'three';
import type { InputSnapshot, PlayerSnapshot, System, TraversalState, UpdateContext } from '../contracts';
import { CAMERA_TUNING as C } from './tuning';
import { cameraHandle } from './cameraHandle';

/**
 * OWNER: feel-builder. You own src/camera/, src/fx/, src/input/.
 *
 * State-aware chase camera (reference-pack/CAMERA_ANALYSIS.md):
 *  - pitch down in canyons/dives, level on glide, up on wall-run, vista on perch
 *  - anticipatory framing that leads the velocity vector (time-based lead)
 *  - speed-reactive FOV on the FEEL_SPEC curve, hard-clamped to the ceiling
 *  - mostly-leveled roll applied as a true rotation about the view axis
 *  - collision: backward sweep through the frozen AnchorQuery (never CitySystem)
 */
class Spring3 {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  constructor(init: THREE.Vector3) { this.pos.copy(init); }
  step(target: THREE.Vector3, omega: number, dt: number): THREE.Vector3 {
    const e = Math.exp(-omega * dt);
    const dx = this.pos.x - target.x;
    const dy = this.pos.y - target.y;
    const dz = this.pos.z - target.z;
    const cx = this.vel.x + omega * dx;
    const cy = this.vel.y + omega * dy;
    const cz = this.vel.z + omega * dz;
    this.pos.set(
      target.x + (dx + cx * dt) * e,
      target.y + (dy + cy * dt) * e,
      target.z + (dz + cz * dt) * e,
    );
    this.vel.set(
      (this.vel.x - omega * cx * dt) * e,
      (this.vel.y - omega * cy * dt) * e,
      (this.vel.z - omega * cz * dt) * e,
    );
    return this.pos;
  }
  snap(v: THREE.Vector3) { this.pos.copy(v); this.vel.set(0, 0, 0); }
}

export class CameraSystem implements System {
  yaw = 0;

  private pitch = 0.25;
  private mousePitch = 0;
  private recentLook = 0;
  private spring: Spring3;
  private lookSpring: Spring3;
  private fov: number;
  private roll = 0;
  /** Smoothed state-driven zoom multiplier (see CAMERA_TUNING.stateZoom). */
  private zoom = 1;
  private fovKick = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private velDir = new THREE.Vector3();
  private pBase = new THREE.Vector3();
  /** Smoothed framing offsets chosen by pickFraming(). */
  private yawOff = 0;
  private pitchOff = 0;
  private boomDir = new THREE.Vector3();
  private candPos = new THREE.Vector3();
  private probeDir = new THREE.Vector3();
  private sideDir = new THREE.Vector3();
  private march = new THREE.Vector3();
  private aim = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private player: PlayerSnapshot,
    private input: InputSnapshot,
  ) {
    this.fov = C.baseFov;
    this.spring = new Spring3(this.camera.position);
    this.pBase.copy(player.position).y += C.lookUpBias;
    this.lookSpring = new Spring3(this.pBase);
    cameraHandle.camera = this.camera;
    // Additive debug hook (feel-builder-owned, lives in this file so it does not
    // touch the frozen GauntletApi): critics need the per-frame camera pose and
    // the world query to measure oscillation and camera-in-geometry rates. There
    // is no other way to read either from the page.
    (window as unknown as { __CAM_DEBUG__?: typeof cameraHandle }).__CAM_DEBUG__ = cameraHandle;
  }

  private clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }

  update(ctx: UpdateContext): void {
    const p = this.player;
    const dt = ctx.dt;
    const st = C.state[p.state as TraversalState] ?? C.state.AIRBORNE;

    // --- mouse look ---
    this.yaw -= this.input.lookX;
    this.mousePitch = this.clamp(this.mousePitch + this.input.lookY * 0.95, -0.75, 0.75);
    this.recentLook += Math.abs(this.input.lookX) + Math.abs(this.input.lookY);
    this.recentLook *= Math.exp(-7 * dt);

    // --- speed / dive / proximity factors ---
    const speedT = this.clamp(p.speed / C.speedForMaxFov, 0, 1);
    const diveT = this.clamp(-p.velocity.y / C.diveSpeedForMax, 0, 1);
    const proxT = this.clamp(1 - p.altitude / C.proximityRange, 0, 1);

    // --- anticipatory yaw drift toward the travel direction when not looking ---
    const horiz = Math.hypot(p.velocity.x, p.velocity.z);
    const travelCamera = p.state === 'FALLING' || p.state === 'AIRBORNE' || p.state === 'RELEASE'
      || p.state === 'WEB_ATTACH' || p.state === 'SWING';
    if (this.recentLook < 0.001 && horiz > 6 && travelCamera && st.pitch >= 0) {
      const target = Math.atan2(p.velocity.x, p.velocity.z);
      let d = target - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, C.yawDriftRate * dt);
    }

    // --- pitch: state morph + dive + proximity + mouse ---
    const pitchTarget = this.clamp(
      st.pitch + diveT * C.divePitchGain + proxT * C.proximityPitchGain + this.mousePitch,
      -1.1, 1.25,
    );
    this.pitch += (pitchTarget - this.pitch) * (1 - Math.exp(-C.pitchOmega * dt));

    // --- FOV (FEEL_SPEC curve + state, hard-clamped to the 90° ceiling) ---
    if (p.justAttached) this.fovKick = C.attachFovKick;
    this.fovKick *= Math.exp(-C.fovKickDecay * dt);
    const fovTarget = this.clamp(
      C.baseFov + st.fov
        + Math.min(p.speed * C.speedFovGain, C.maxSpeedFovGain)
        + diveT * C.diveFovGain + proxT * C.proximityFovGain + this.fovKick,
      C.baseFov, C.maxFov,
    );
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-C.fovOmega * dt));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();

    // --- distance (back toward spec now the hero is at human scale) ---
    // distRaw is the un-zoomed boom length. The HEIGHT term below is derived
    // from it rather than from the zoomed value, so zooming in does not also
    // drop the camera: distanceScale and heightScale stay independent knobs.
    // The state-driven zoom rides on the SAME side of that split as
    // distanceScale, so the breathing never lifts or drops the rig.
    const zoomTarget = C.stateZoom[p.state as TraversalState] ?? 1;
    this.zoom += (zoomTarget - this.zoom) * (1 - Math.exp(-C.zoomOmega * dt));
    const distRaw = (C.baseDistance + speedT * C.extraDistance) * st.dist;
    const dist = distRaw * C.distanceScale * this.zoom;
    this.pBase.set(p.position.x, p.position.y, p.position.z);

    // --- framing search: pick a boom that keeps the corridor open ---
    // Last frame's look target is the corridor the camera cares about, and it
    // is available before the look spring is stepped this frame.
    this.aim.copy(this.lookSpring.pos);
    this.pickFraming(dist, dt);

    const boomPitch = this.clamp(this.pitch + this.pitchOff, -1.1, C.maxBoomPitch);
    const cp = Math.cos(boomPitch);
    const sp = Math.sin(boomPitch);
    const boomYaw = this.yaw + this.yawOff;

    // --- desired camera position: behind player, elevated by pitch + heightOffset ---
    // velocity feedforward compensates the spring's steady-state lag so the
    // actual chase distance stays near the target at speed.
    this.tmp.set(
      -Math.sin(boomYaw) * cp * dist,
      // heightScale lifts the WHOLE vertical offset, not just heightOffset. Most
      // of the camera's height comes from the pitch term (sp * dist), so scaling
      // only the constant would have moved the rig a few centimetres.
      (sp * distRaw + C.heightOffset) * C.heightScale,
      -Math.cos(boomYaw) * cp * dist,
    );
    this.tmp.add(this.pBase);
    if (horiz > 1) {
      this.velDir.set(
        p.velocity.x / horiz,
        (p.velocity.y / horiz) * C.positionFeedforwardVertical,
        p.velocity.z / horiz,
      );
      const ff = Math.min(C.positionFeedforward * horiz, C.maxPositionFeedforward);
      this.tmp.addScaledVector(this.velDir, ff);
    }

    // --- backward-sweep collision: pull in before any building/ground face ---
    const safe = this.sweepCollision(this.pBase, this.tmp, C.collisionSkin);
    // ...then float it clear of whatever surface is underneath, so a street
    // skim rides above the tarmac instead of sitting in it.
    this.liftAboveSurface(safe);
    this.spring.step(safe, C.positionOmega * st.omega, dt);

    // --- look target: time-based lead along FULL velocity, lag-compensated ---
    const sp3 = Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z);
    if (sp3 > 1) {
      // feed a target that already includes the predicted spring error so the
      // OUTPUT leads by lookAhead seconds (critic's metric)
      const lead = C.lookAhead * sp3 + (2 / C.lookOmega) * sp3;
      const vT = C.leadVertical[p.state as TraversalState] ?? 0.5;
      this.velDir.copy(p.velocity).multiplyScalar(1 / sp3);
      // damp the vertical component per state (swings look down the corridor)
      this.velDir.y *= vT;
      this.velDir.normalize();
      this.velDir.multiplyScalar(Math.min(lead, C.maxLookLead)).add(this.pBase).y += C.lookUpBias;
      this.lookSpring.step(this.velDir, C.lookOmega, dt);
    } else {
      this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
        .multiplyScalar(C.minLookLead).add(this.pBase).y += C.lookUpBias;
      this.lookSpring.step(this.forward, C.lookOmega, dt);
    }

    // The speed/proximity camera shake that used to be added here is GONE, and
    // must not come back in any form. It was `sin(frame * 1.13)` — indexed by
    // FRAME, not time, so a full cycle took 3.7-5.5 frames (measured: a 3.70
    // frame period, 0.021 wu amplitude on Y, matching cos(f * 1.7) exactly) and
    // its frequency changed with the display refresh rate. It scaled with
    // speedT, so it was loudest precisely while swinging fast, and it read as a
    // buzz rather than as camera weight. The owner asked for it removed, not
    // retuned: do not reintroduce a "better" time-based shake here.
    this.camera.position.copy(this.spring.pos);
    // safety: clamp the final position out of geometry too
    if (cameraHandle.world) {
      this.liftAboveSurface(this.camera.position);
      this.resolveFinal(this.camera.position);
    }

    // --- keep the player in frame: the velocity lead may run tens of metres
    // ahead, which is what put the player outside the frustum entirely in the
    // wave-1 capture. Clamp the look direction to a cone around the player. ---
    this.clampLookOnAxis(this.camera.position);
    this.guardLookPitch(this.camera.position);

    // --- roll: mostly leveled, subtle bank into the swing ---
    const swinging = p.state === 'SWING' || p.state === 'WEB_ATTACH';
    const rollTarget = swinging
      ? this.clamp(-p.lean * C.swingRoll * (0.5 + 0.5 * speedT), -C.maxRoll, C.maxRoll)
      : 0;
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-C.rollOmega * dt));

    // lookAt writes a quaternion; apply roll as a rotation about the view axis.
    // NEVER assign .rotation.z — that decomposes the quaternion and corrupts it.
    this.camera.lookAt(this.lookSpring.pos);
    this.camera.rotateZ(this.roll);
    cameraHandle.debug = {
      camPos: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      look: [this.lookSpring.pos.x, this.lookSpring.pos.y, this.lookSpring.pos.z],
      zoom: this.zoom,
    };
  }

  // -------------------------------------------------------------------------
  // Framing (integration critique blocker 3)
  // -------------------------------------------------------------------------

  /**
   * Distance the ray (from, dir) travels before the world turns solid, capped
   * at `max`. Coarse marching — this is a visibility heuristic, not a physics
   * cast, and it runs through the frozen AnchorQuery like everything else here.
   */
  private freeDistance(from: THREE.Vector3, dir: THREE.Vector3, max: number, step: number): number {
    const world = cameraHandle.world;
    if (!world) return max;
    for (let t = step; t <= max; t += step) {
      this.march.set(from.x + dir.x * t, from.y + dir.y * t, from.z + dir.z * t);
      if (world.isSolidAt(this.march)) return t - step;
    }
    return max;
  }

  /**
   * Score one candidate boom. Rewards a boom that reaches its full length (the
   * player is unoccluded and the camera is not jammed against a facade) and a
   * vantage from which the corridor ahead is open; charges for deviating from
   * the director's angle, elevation being cheaper than yaw.
   */
  private scoreFraming(dYaw: number, dPitch: number, dist: number): number {
    const yaw = this.yaw + dYaw;
    const pitch = this.clamp(this.pitch + dPitch, -1.1, C.maxBoomPitch);
    const cp = Math.cos(pitch);
    this.boomDir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();

    const reach = this.freeDistance(this.pBase, this.boomDir, dist, C.collisionStep);
    const penalty = Math.abs(dYaw) * C.yawPenalty + dPitch * C.pitchPenalty;
    // a boom this short means the camera would be inside the player; rank these
    // against each other but always below any candidate that clears.
    if (reach < C.minBoom) return -10 + reach - penalty;

    this.candPos.copy(this.pBase).addScaledVector(this.boomDir, reach);
    this.candPos.y += C.heightOffset * C.heightScale;
    this.liftAboveSurface(this.candPos);

    this.probeDir.copy(this.aim).sub(this.candPos);
    const l = this.probeDir.length();
    if (l < 0.001) return (reach / dist) * C.reachWeight - penalty;
    this.probeDir.multiplyScalar(1 / l);
    const open = this.freeDistance(this.candPos, this.probeDir, C.corridorProbe, C.corridorStep);
    const left = this.sideOpenness(1);
    const right = this.sideOpenness(-1);
    const side = C.centreShare * (open / C.corridorProbe)
      + (1 - C.centreShare) * 0.5 * ((left + right) / C.sideProbe);

    return (reach / dist) * C.reachWeight + side * C.openWeight - penalty;
  }

  /** Free distance from the candidate vantage, `sign * sideAngle` off the view
   *  axis about world up. Catches the "flush against a facade" shot. */
  private sideOpenness(sign: number): number {
    const a = sign * C.sideAngle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.sideDir.set(
      this.probeDir.x * c + this.probeDir.z * s,
      this.probeDir.y,
      -this.probeDir.x * s + this.probeDir.z * c,
    );
    return this.freeDistance(this.candPos, this.sideDir, C.sideProbe, C.sideStep);
  }

  /**
   * Choose and smooth the framing offsets. The director's own angle is tried
   * first and accepted outright when nothing is in the way — the common case
   * costs about eight solid tests. Only when the shot is compromised does the
   * full fan get evaluated, and the winner is blended in over ~0.2 s so a
   * candidate switch can never read as a cut.
   */
  private pickFraming(dist: number, dt: number): void {
    const k = 1 - Math.exp(-C.framingOmega * dt);
    let bestYaw = 0;
    let bestPitch = 0;

    if (cameraHandle.world) {
      let best = this.scoreFraming(0, 0, dist);
      if (best < C.framingGoodEnough) {
        for (let pi = 0; pi < C.framingPitches.length; pi++) {
          for (let yi = 0; yi < C.framingYaws.length; yi++) {
            const dp = C.framingPitches[pi];
            const dy = C.framingYaws[yi];
            if (dp === 0 && dy === 0) continue;
            const s = this.scoreFraming(dy, dp, dist);
            if (s > best) { best = s; bestYaw = dy; bestPitch = dp; }
          }
        }
      }
    }

    this.yawOff += (bestYaw - this.yawOff) * k;
    this.pitchOff += (bestPitch - this.pitchOff) * k;
  }

  /** Float a camera point clear of the surface beneath it. Skipped when the lift
   *  would be large: that means the XZ is inside a tall footprint, where the
   *  boom sweep is the right tool and this would teleport the camera to a roof. */
  private liftAboveSurface(pos: THREE.Vector3): void {
    const world = cameraHandle.world;
    if (!world) return;
    const lift = world.surfaceHeightAt(pos.x, pos.z) + C.groundClearance - pos.y;
    if (lift > 0 && lift <= C.maxGroundLift) pos.y += lift;
  }

  /**
   * Pull the look target back into a cone around the player so the velocity
   * lead can never walk the player out of the frustum. Uses the vertical FOV,
   * which is the tighter axis, so the guarantee holds horizontally too.
   */
  private clampLookOnAxis(camPos: THREE.Vector3): void {
    this.tmp.copy(this.lookSpring.pos).sub(camPos);
    this.tmp2.copy(this.pBase).sub(camPos);
    const a = this.tmp.length();
    const b = this.tmp2.length();
    if (a < 1e-4 || b < 1e-4) return;
    this.tmp.multiplyScalar(1 / a);
    this.tmp2.multiplyScalar(1 / b);

    const ang = Math.acos(this.clamp(this.tmp.dot(this.tmp2), -1, 1));
    const maxAng = (this.fov * Math.PI) / 180 * 0.5 * C.maxOffAxisFrac;
    if (ang <= maxAng || ang < 1e-4) return;

    // slerp the look direction back toward the player by exactly the excess
    const t = 1 - maxAng / ang;
    const s = Math.sin(ang);
    const w1 = Math.sin((1 - t) * ang) / s;
    const w2 = Math.sin(t * ang) / s;
    this.tmp.multiplyScalar(w1).addScaledVector(this.tmp2, w2).normalize();
    this.lookSpring.pos.copy(camPos).addScaledVector(this.tmp, a);
  }

  /**
   * Keep the view direction off vertical. `lookAt` resolves roll against world
   * up, so a look direction within a degree or two of straight down flips the
   * resulting quaternion by 180 degrees between frames — a full-frame roll snap
   * on a vertical dive. Tilting the target back to at most ~75 degrees costs
   * nothing visually and removes the singularity.
   */
  private guardLookPitch(camPos: THREE.Vector3): void {
    this.tmp.copy(this.lookSpring.pos).sub(camPos);
    const len = this.tmp.length();
    if (len < 1e-4) {
      this.lookSpring.pos.set(camPos.x + Math.sin(this.yaw), camPos.y, camPos.z + Math.cos(this.yaw));
      return;
    }
    this.tmp.multiplyScalar(1 / len);
    if (Math.abs(this.tmp.y) <= C.maxLookSlope) return;

    const y = this.tmp.y > 0 ? C.maxLookSlope : -C.maxLookSlope;
    const flat = Math.hypot(this.tmp.x, this.tmp.z);
    const want = Math.sqrt(1 - y * y);
    if (flat > 1e-4) {
      const k = want / flat;
      this.tmp.set(this.tmp.x * k, y, this.tmp.z * k);
    } else {
      // exactly vertical: fall back to the camera's own heading
      this.tmp.set(Math.sin(this.yaw) * want, y, Math.cos(this.yaw) * want);
    }
    this.lookSpring.pos.copy(camPos).addScaledVector(this.tmp, len);
  }

  /**
   * March from the player outward toward the desired camera point and pull the
   * camera back to the last non-solid position (small skin width). Uses the
   * frozen AnchorQuery injected via cameraHandle.world — never CitySystem.
   */
  private sweepCollision(from: THREE.Vector3, toward: THREE.Vector3, skin: number): THREE.Vector3 {
    const world = cameraHandle.world;
    if (!world) return toward;

    this.tmp2.copy(toward).sub(from);
    const dist = this.tmp2.length();
    if (dist < 0.001) return toward;
    this.tmp2.multiplyScalar(1 / dist);

    // scan outward; first solid point bounds the camera
    const step = C.collisionStep;
    let safeT = dist;
    for (let t = step; t < dist; t += step) {
      this.tmp.set(from.x + this.tmp2.x * t, from.y + this.tmp2.y * t, from.z + this.tmp2.z * t);
      if (world.isSolidAt(this.tmp)) {
        safeT = Math.max(0, t - skin);
        break;
      }
    }
    return this.tmp.set(
      from.x + this.tmp2.x * safeT,
      from.y + this.tmp2.y * safeT,
      from.z + this.tmp2.z * safeT,
    );
  }

  /** Hard guard so the rendered camera can never sit inside geometry. */
  private resolveFinal(pos: THREE.Vector3) {
    const world = cameraHandle.world!;
    if (!world.isSolidAt(pos)) return;
    // binary-search back toward the look point for the last free position
    const look = this.lookSpring.pos;
    let lo = 0, hi = 1;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      this.tmp2.lerpVectors(pos, look, mid);
      if (world.isSolidAt(this.tmp2)) lo = mid; else hi = mid;
    }
    this.tmp2.lerpVectors(pos, look, hi);
    pos.copy(this.tmp2);
  }
}
