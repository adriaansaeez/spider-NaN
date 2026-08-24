import * as THREE from 'three';
import type { PlayerSnapshot } from '../contracts';
import { FX_TUNING as T } from './tuning';
import {
  ankleOf, runBob, tickGroundPull, WallTracker, wallRunDebug,
  type CharacterRig, type WallAwareSnapshot, type WallDebug,
} from './poses';
import { isSurfaceContactState, MotionController, type MotionReport } from './motion';

/**
 * OWNED BY: feel-builder.
 * Original low-poly articulated hero — the `characterMode: 'procedural'` rig,
 * and the one the game always boots on. Distinct silhouettes per TraversalState:
 * perch crouch, head-first dive, inverted swing tuck (grip arm toward anchor),
 * belly-down airborne spread, superman dash, wall-run stride. Limbs are boxes
 * hung from pivot groups so poses blend instead of pop (ANIMATION_ANALYSIS).
 *
 * The pose library itself lives in ./poses.ts because CharacterModel (the
 * authored skinned alternative) drives its Mixamo skeleton from exactly the
 * same numbers.
 */

const ARM_DOWN = new THREE.Vector3(0, -1, 0);

interface Limb {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  /** Legs only: the ankle pivot the foot hangs off. See `makeLeg`. */
  tip?: THREE.Object3D;
}

/**
 * The box rig's foot box has its long axis along +Z while a limb rests along
 * -Y, so a zero rotation on the ankle pivot puts the foot PERPENDICULAR to the
 * shin, not along it. `Pose.ankleL` is measured from the shin, so applying it
 * here means adding the quarter turn that closes that gap: value 0 then means
 * "the foot continues the shin" in this rig exactly as it does in the skinned
 * one, and both rigs read the same authored number the same way.
 */
const ANKLE_BOX_OFFSET = Math.PI / 2;

export class PlayerFigure implements CharacterRig {
  readonly root = new THREE.Group();
  /**
   * Whole-body rotation that is NOT part of the pose: airborne flips and body
   * roll (see motion.ts). It sits between the root and the torso so a somersault
   * turns the entire character about the hip pivot, and so it is applied RAW —
   * the flip curve is already smooth, and running it through the pose blend
   * filter would lag it and stop it landing exactly upright.
   */
  private pivot = new THREE.Group();
  private body = new THREE.Group();
  private head: THREE.Object3D;
  private armL: Limb;
  private armR: Limb;
  private legL: Limb;
  private legR: Limb;
  private gripQuatL = new THREE.Quaternion();
  private gripQuatR = new THREE.Quaternion();
  /** Which hand currently grips the web (for the web-line origin). */
  gripL = false;
  gripR = false;
  private tmpV = new THREE.Vector3();
  /** Seconds since the two-handed ground pull fired; < 0 when not pulling. */
  private pullClock = -1;
  /**
   * Variation, flips and secondary motion. Shared with the model rig — both
   * character modes get the same motion because both drive it from here.
   */
  private motion = new MotionController();
  /** Smoothed signed hip shift toward the facade: -1 left, +1 right, 0 none. */
  private wallShift = 0;
  /** Recovers the facade normal from the snapshot's own motion (see poses.ts). */
  private wall = new WallTracker();
  /** The side resolved this frame, kept so `wallDebug` reports what was APPLIED. */
  private wallSideNow = 0;
  /** The ankle applied this frame; published through `wallDebug`. */
  private lastAnkleL = 0;
  private lastAnkleR = 0;

  readonly gripHandL = new THREE.Object3D();
  readonly gripHandR = new THREE.Object3D();

  constructor(scene: THREE.Scene) {
    const { suit, suitDark, limb, mask } = T.figureColors;
    // small emissive keeps the suit readable against busy, dimly-lit backdrops
    // at any time of day without needing extra lights (AGENTS rule 4).
    const torsoMat = new THREE.MeshLambertMaterial({ color: suit, emissive: suit, emissiveIntensity: 0.25, flatShading: true });
    const darkMat = new THREE.MeshLambertMaterial({ color: suitDark, emissive: suitDark, emissiveIntensity: 0.2, flatShading: true });
    const limbMat = new THREE.MeshLambertMaterial({ color: limb, emissive: limb, emissiveIntensity: 0.2, flatShading: true });
    const maskMat = new THREE.MeshLambertMaterial({ color: mask, emissive: mask, emissiveIntensity: 0.4, flatShading: true });

    // Human scale. The rig spans -0.81..+1.05 about the hip pivot = 1.86 m,
    // which sits correctly against the city's 3.5 m storey convention. The
    // previous 1.5x was a local fix for a camera problem (the hero was hard to
    // read because the shot was inside a wall) and it broke that relationship;
    // readability is now recovered with chase distance instead.
    this.root.scale.setScalar(1.0);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.78, 0.34), torsoMat);
    torso.position.y = 0.42;
    this.body.add(torso);

    this.head = new THREE.Object3D();
    // sits clear of the torso top (0.81) so there is a readable neck break —
    // at 0.9 the head merged into the shoulders and the silhouette lost its
    // most important landmark for reading which way the body is facing.
    this.head.position.y = 0.98;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.3), darkMat);
    this.head.add(head);
    const maskPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.07), maskMat);
    maskPlate.position.z = 0.17;
    maskPlate.position.y = -0.01;
    this.head.add(maskPlate);
    this.body.add(this.head);

    this.armL = this.makeArm(-0.32, limbMat, this.gripHandL);
    this.armR = this.makeArm(0.32, limbMat, this.gripHandR);
    this.legL = this.makeLeg(-0.18, limbMat);
    this.legR = this.makeLeg(0.18, limbMat);

    // The limbs hang off the TORSO, not off the root. Parenting them to the
    // root was the disintegration bug: `pose.body.x` reaches 2.5 rad in SWING,
    // so the torso pitched away while the arms stayed behind as a floating bar
    // and the legs as a separate X (E_figure_disintegrated_t44s.png). The grip
    // solve below already works in body-local space, so body is the space the
    // shoulder/hip pivots were authored in.
    this.body.add(this.armL.upper, this.armR.upper, this.legL.upper, this.legR.upper);
    this.pivot.add(this.body);
    this.root.add(this.pivot);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = false;
      }
    });
    scene.add(this.root);
  }

  private makeArm(x: number, mat: THREE.Material, hand: THREE.Object3D): Limb {
    const shoulder = new THREE.Object3D();
    shoulder.position.set(x, 0.8, 0);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.34, 0.14), mat);
    upper.position.y = -0.17;
    shoulder.add(upper);
    const elbow = new THREE.Object3D();
    elbow.position.y = -0.34;
    shoulder.add(elbow);
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.32, 0.12), mat);
    fore.position.y = -0.16;
    elbow.add(fore);
    hand.position.y = -0.34;
    elbow.add(hand);
    return { upper: shoulder, lower: elbow };
  }

  private makeLeg(x: number, mat: THREE.Material): Limb {
    const hip = new THREE.Object3D();
    hip.position.set(x, 0.05, 0);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.2), mat);
    thigh.position.y = -0.2;
    hip.add(thigh);
    const knee = new THREE.Object3D();
    knee.position.y = -0.4;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.4, 0.18), mat);
    shin.position.y = -0.2;
    knee.add(shin);
    // The foot hangs off an ANKLE PIVOT rather than being welded to the shin at
    // a fixed offset. Welded, it was a rigid continuation of the leg with no
    // orientation of its own — the same defect the skinned rig had, and the two
    // rigs have to agree because either one can be the one a critic screenshots.
    const ankle = new THREE.Object3D();
    ankle.position.y = -0.4;
    knee.add(ankle);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.08, 0.26), mat);
    foot.position.set(0, -0.02, 0.06);
    ankle.add(foot);
    return { upper: hip, lower: knee, tip: ankle };
  }

  update(p: PlayerSnapshot, dt: number, groundPull: boolean): void {
    this.root.position.copy(p.position);
    this.root.visible = true;

    const horiz = Math.hypot(p.velocity.x, p.velocity.z);
    if (horiz > 0.5) {
      this.root.rotation.y = Math.atan2(p.velocity.x, p.velocity.z);
    }

    // Wall running turns the body ALONG the facade. Without this a vertical
    // climb keeps the yaw the approach left behind — pointing into the wall —
    // and "shift the hips toward the wall" would then shift them forward.
    this.wall.update(p as WallAwareSnapshot);
    let wallYaw: number | null = null;
    if (p.state === 'WALL_RUN') {
      wallYaw = this.wall.yaw(p, this.root.rotation.y);
      if (wallYaw !== null) {
        this.root.rotation.y = WallTracker.easeYaw(
          this.root.rotation.y, wallYaw, dt, T.wallRunYawRate,
        );
      }
    }

    // ONE locomotion animation: the run. The motion layer hands back the cycle
    // for both ground movement and wall running (its phase clock has a rate
    // floor so slowing down never turns it into a walk), and for every other
    // state it hands back this VISIT's variant driven toward its physics
    // partner, with the secondary layer already applied. See motion.ts.
    const m = this.motion.update(p, dt, this.root.rotation.y);
    const running = m.running;
    const statePose = m.pose;

    // Flips and body roll are a whole-body orientation, not a pose, so they go
    // on the pivot rather than into the joint targets — EXCEPT on a surface,
    // where the surface owns the orientation and the flip has no claim on it.
    // The motion layer resolves a flip on the contact frame already; this is the
    // second gate, at the point of application, and it is the one that answers
    // the animation critic's procedural finding directly (204 and 321.5 degrees
    // of flip pitch applied on top of the wall-run tilt during WALL_RUN).
    const surface = isSurfaceContactState(p.state);
    this.pivot.rotation.x = surface ? 0 : m.flipPitch;
    this.pivot.rotation.z = surface ? 0 : m.flipRoll;

    // The two-handed ground pull is a one-shot overlay on top of the state
    // pose, on its own clock — by the time the body is moving the state machine
    // has already left the ground (see poses.ts).
    const pull = tickGroundPull(this.pullClock, groundPull, dt, statePose);
    this.pullClock = pull.clock;
    const pose = pull.pose;

    // which hand grips the web. Suppressed while the pull owns the arms: the
    // pull is explicitly two-handed and a one-armed grip would fight it.
    this.gripL = false;
    this.gripR = false;
    if (pull.weight < 0.5 && p.anchorPosition && (p.state === 'SWING' || p.state === 'WEB_ATTACH')) {
      // World -> body space is the INVERSE yaw, so the z term is MINUS sin. It
      // used to be plus, which is a different (non-orthonormal) mapping: at yaw
      // 90 degrees an anchor squarely on the character's right resolved to the
      // LEFT hand, and since `gripQuat` below aims the chosen arm at the real
      // anchor with a correct transform, the hero reached across his own chest
      // for every anchor at those yaws. Verified against Object3D.worldToLocal
      // rather than by eye: anchor (0,0,-10) at yaw 90 is local x = +10.
      const cos = Math.cos(this.root.rotation.y);
      const sin = Math.sin(this.root.rotation.y);
      const localX = (p.anchorPosition.x - p.position.x) * cos - (p.anchorPosition.z - p.position.z) * sin;
      if (localX >= 0) this.gripR = true; else this.gripL = true;
    }

    if (this.gripL || this.gripR) {
      // direction from shoulder to anchor, in body-local space (arm hangs -Y)
      this.root.updateMatrixWorld(true);
      this.body.updateWorldMatrix(true, false);
      this.tmpV.copy(p.anchorPosition!);
      this.body.worldToLocal(this.tmpV);
      const shoulder = this.gripL ? this.armL.upper.position : this.armR.upper.position;
      this.tmpV.sub(shoulder).normalize();
      if (this.tmpV.lengthSq() > 0.001) {
        const q = this.gripL ? this.gripQuatL : this.gripQuatR;
        q.setFromUnitVectors(ARM_DOWN, this.tmpV);
      }
    }

    // Hips toward the facade while wall running, plus a small tilt into it, so
    // the body settles onto the surface instead of running on flat ground in
    // mid-air. Eased, so entering and leaving a wall run morphs rather than pops.
    const wallSide = wallYaw !== null ? this.wall.side(wallYaw) : 0;
    this.wallSideNow = wallSide;
    this.wallShift += (wallSide - this.wallShift) * Math.min(1, T.wallRunShiftRate * dt);

    // Per-state blend rate, from the motion layer: a dash is struck into its
    // pose and a glide eases into one, and the run cycle is filtered much less
    // than either (see FX_TUNING.runBlendRate for the measurement).
    const k = 1 - Math.exp(-m.blendRate * dt);
    // The whole upper body hangs off `body`, so translating it IS the hip shift.
    const shift = this.wallShift * wallRunDebug.scale;
    this.body.position.x += (shift * T.wallRunHipShift - this.body.position.x) * k;
    const bob = running && pull.weight < 0.5 ? runBob(m.runPhase) : 0;
    this.body.position.y += (bob - this.body.position.y) * k;
    this.blend(
      this.body, pose.body.x, 0,
      // Positive body.z tips the torso top toward -X, so leaning INTO a wall on
      // the character's right (+X) takes the negative sign.
      pose.body.z + p.lean * 0.2 - shift * T.wallRunTorsoTilt, k,
    );
    // head.y is the look-toward-the-anchor turn from the secondary layer
    this.blend(this.head, pose.head.x, pose.head.y, 0, k);
    if (this.gripL) {
      this.armL.upper.quaternion.slerp(this.gripQuatL, k);
      this.blend1(this.armL.lower, 0.1, k);
    } else this.blend(this.armL.upper, pose.shoulderL.x, 0, pose.shoulderL.z, k);
    if (this.gripR) {
      this.armR.upper.quaternion.slerp(this.gripQuatR, k);
      this.blend1(this.armR.lower, 0.1, k);
    } else this.blend(this.armR.upper, pose.shoulderR.x, 0, pose.shoulderR.z, k);
    if (!this.gripL) this.blend1(this.armL.lower, pose.elbowL, k);
    if (!this.gripR) this.blend1(this.armR.lower, pose.elbowR, k);

    // legs: note rotation.y on hip pivots so both knees bend the same way
    this.blend(this.legL.upper, pose.hipL.x, 0, pose.hipL.z, k);
    this.blend(this.legL.lower, pose.kneeL, 0, 0, k);
    this.blend(this.legR.upper, pose.hipR.x, 0, pose.hipR.z, k);
    this.blend(this.legR.lower, pose.kneeR, 0, 0, k);
    // ankles: authored relative to the shin, so the box quarter turn is added
    // back here (see ANKLE_BOX_OFFSET) rather than baked into the pose numbers.
    this.lastAnkleL = ankleOf(pose, 'L');
    this.lastAnkleR = ankleOf(pose, 'R');
    if (this.legL.tip) this.blend1(this.legL.tip, this.lastAnkleL + ANKLE_BOX_OFFSET, k);
    if (this.legR.tip) this.blend1(this.legR.tip, this.lastAnkleR + ANKLE_BOX_OFFSET, k);
  }

  /** See CharacterRig.motionReport. */
  motionReport(p: PlayerSnapshot): MotionReport {
    return this.motion.report(p);
  }

  /** See CharacterRig.wallDebug. */
  wallDebug(): WallDebug {
    return {
      side: this.wallSideNow,
      shift: +this.wallShift.toFixed(4),
      nx: +this.wall.x.toFixed(4),
      nz: +this.wall.z.toFixed(4),
      valid: this.wall.valid,
      yawDeg: +(this.root.rotation.y * 180 / Math.PI).toFixed(2),
      phase: +this.motion.phase.toFixed(3),
      hipLx: +this.legL.upper.rotation.x.toFixed(3),
      hipRx: +this.legR.upper.rotation.x.toFixed(3),
      kneeL: +this.legL.lower.rotation.x.toFixed(3),
      kneeR: +this.legR.lower.rotation.x.toFixed(3),
      bodyX: +this.body.rotation.x.toFixed(3),
      ankleL: +this.lastAnkleL.toFixed(3),
      ankleR: +this.lastAnkleR.toFixed(3),
    };
  }

  private blend(o: THREE.Object3D, x: number, y: number, z: number, k: number): void {
    o.rotation.x += (x - o.rotation.x) * k;
    o.rotation.y += (y - o.rotation.y) * k;
    o.rotation.z += (z - o.rotation.z) * k;
  }

  private blend1(o: THREE.Object3D, x: number, k: number): void {
    o.rotation.x += (x - o.rotation.x) * k;
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m as THREE.Mesh).isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}
