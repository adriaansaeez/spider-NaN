import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { PlayerSnapshot, TraversalState } from '../contracts';
import { FX_TUNING as T } from './tuning';
import {
  ankleOf, ankleRollDebug, tickGroundPull, WallTracker, wallRunDebug,
  type CharacterRig, type EulerTarget, type Pose, type WallAwareSnapshot, type WallDebug,
} from './poses';
import { isSurfaceContactState, MotionController, type MotionReport } from './motion';

/**
 * OWNED BY: feel-builder.
 *
 * The `characterMode: 'model'` rig: the authored low-poly skinned hero from
 * public/assets/character.glb, driven by a hybrid of its own shipped clips and
 * the hand-authored pose library in ./poses.ts.
 *
 * WHY A HYBRID. The asset ships four clips — Idle, Jump, Land, Run — which are
 * exactly the states a traversal game spends the LEAST time in. Nothing ships
 * for SWING, FALLING, AIRBORNE, DASH, WALL_RUN, PERCH or the two-handed ground
 * pull, which is where this game actually lives. Rather than invent a second
 * animation set from nothing, the missing states are authored by pointing the
 * model's Mixamo skeleton at the SAME joint directions the procedural figure
 * already uses and that critics already validated as state-readable. Where a
 * shipped clip exists it wins outright (`poseWeight` 0); everywhere else the
 * pose solver wins (`poseWeight` 1); transitions cross-fade between the two.
 *
 * HOW THE POSE SOLVER WORKS. A pose entry is a set of BODY-SPACE limb
 * directions, not bone rotations — the box figure's limbs rest pointing -Y,
 * Mixamo's rest in a T-pose, so raw eulers are not portable. For each solved
 * bone we know `restDir`, the unit direction from the bone to its child in the
 * bone's own local space, captured at bind time. Walking the skeleton top-down
 * we carry `accum`, the rotation from a bone's parent space into body space, so
 *
 *     localTarget = accum⁻¹ · bodyDirection
 *     bone.quaternion = quatFromUnitVectors(restDir, localTarget)
 *
 * points the bone at the authored direction whatever its bind orientation. Roll
 * about the limb axis is left as the minimal rotation, which is stable and
 * invisible at this poly count: the elbow/knee plane is pinned anyway because
 * the forearm/shin direction is authored separately.
 *
 * SCALE AND ORIENTATION are both derived, never hard-coded, so a re-export of
 * the asset cannot silently break them: the rig is hung by its HIP bone so the
 * hip pivot lands on `PlayerSnapshot.position` exactly like the box figure's;
 * facing is measured from the heel→toe vector and yawed to +Z; and handedness is
 * measured from the left hand's X sign, so a mirrored export swaps L/R feeds
 * instead of posing the model inside out.
 *
 * The skinned geometry is NEVER transformed (no `applyMatrix4`). The shipped GLB
 * is meshopt/KHR_mesh_quantization compressed, where that call is silently
 * destructive — see tools/build-assets.mjs.
 */

// --- bone roles -------------------------------------------------------------

/** The joints the pose solver drives. Everything else stays on the clip. */
type Role =
  | 'spine' | 'spine1' | 'spine2' | 'neck' | 'head'
  | 'armL' | 'foreL' | 'armR' | 'foreR'
  | 'upLegL' | 'legL' | 'upLegR' | 'legR'
  | 'footL' | 'footR';

/**
 * Mixamo base name -> role, and which child that bone must point at. `childAlt`
 * is a second name to try: the toe joint is `LeftToeBase` in a standard Mixamo
 * export but some rigs only carry the `_End` leaf, and the facing calibration
 * above already has to try both.
 */
const ROLE_BY_BONE: Record<string, { role: Role; child: string; childAlt?: string }> = {
  Spine: { role: 'spine', child: 'Spine1' },
  Spine1: { role: 'spine1', child: 'Spine2' },
  Spine2: { role: 'spine2', child: 'Neck' },
  Neck: { role: 'neck', child: 'Head' },
  Head: { role: 'head', child: 'HeadTop_End' },
  LeftArm: { role: 'armL', child: 'LeftForeArm' },
  LeftForeArm: { role: 'foreL', child: 'LeftHand' },
  RightArm: { role: 'armR', child: 'RightForeArm' },
  RightForeArm: { role: 'foreR', child: 'RightHand' },
  LeftUpLeg: { role: 'upLegL', child: 'LeftLeg' },
  LeftLeg: { role: 'legL', child: 'LeftFoot' },
  RightUpLeg: { role: 'upLegR', child: 'RightLeg' },
  RightLeg: { role: 'legR', child: 'RightFoot' },
  // THE FEET. Before these two entries existed the leg chain simply stopped at
  // the shin, so nothing in the codebase decided where a foot pointed: the foot
  // bone kept whatever the shipped clip wrote on it and inherited the whole
  // accumulated rotation of a leg the pose solver had thrown somewhere else
  // entirely. See `soleRest` and `rollToSole` for the twist that caused.
  LeftFoot: { role: 'footL', child: 'LeftToeBase', childAlt: 'LeftToe_End' },
  RightFoot: { role: 'footR', child: 'RightToeBase', childAlt: 'RightToe_End' },
};

/** The roles whose ROLL matters, so the sole has a deliberate facing. */
function isFootRole(role: Role): boolean {
  return role === 'footL' || role === 'footR';
}

/**
 * `mixamorig:LeftForeArm_24` -> `LeftForeArm`.
 *
 * The separator has to be optional. GLTFLoader runs every node name through
 * `PropertyBinding.sanitizeNodeName`, which STRIPS the reserved `:` rather than
 * replacing it, so what actually reaches us is `mixamorigLeftForeArm_24`.
 * Matching the colon literally finds no joints at all and silently drops the
 * whole model to the procedural fallback — verified in the browser, not assumed.
 */
function baseName(name: string): string {
  return name.replace(/^mixamorig[:_]?/, '').replace(/_\d+$/, '');
}

interface SolvedBone {
  bone: THREE.Object3D;
  role: Role;
  /** Bone -> child direction in the bone's own local space, at bind. */
  restDir: THREE.Vector3;
  /**
   * The bone-local axis that pointed along BODY +X at bind — for a foot, the
   * medial-lateral axis through the ankle. Captured only for the roles whose
   * roll is resolved (the feet), because it is what turns a direction into a
   * full orientation: aiming a bone with `setFromUnitVectors` is a MINIMAL-ARC
   * rotation, which leaves roll about the bone's own axis completely undefined
   * and free to drift with the target direction. A shin is a cylinder and does
   * not care; a foot is flat and asymmetric, and an undefined roll on a foot is
   * a visibly twisted ankle.
   */
  soleRest?: THREE.Vector3;
  /** Temporally smoothed solve, so state changes morph instead of popping. */
  smoothed: THREE.Quaternion;
}

// --- loading ----------------------------------------------------------------

export interface CharacterAsset {
  /** Prepared scene graph: hips at the origin, facing +Z, 1 unit = 1 m. */
  group: THREE.Group;
  clips: Map<string, THREE.AnimationClip>;
  mixerRoot: THREE.Object3D;
  solved: Map<THREE.Object3D, SolvedBone>;
  /**
   * Children to descend into, per bone: the solved bones and their ancestors
   * only. Precomputed so the per-frame walk touches ~20 nodes instead of all 66
   * (40 of which are finger joints the solver never drives).
   */
  walkPlan: Map<THREE.Object3D, THREE.Object3D[]>;
  /** Traversal order: the skeleton root, walked top-down every frame. */
  skeletonRoot: THREE.Object3D;
  /** Rotation from `skeletonRoot.parent` space into body space. Static. */
  baseQuat: THREE.Quaternion;
  handL: THREE.Object3D;
  handR: THREE.Object3D;
  shoulderL: THREE.Object3D;
  shoulderR: THREE.Object3D;
  /** The hip bone. Not a solved joint — it is TRANSLATED, for the wall-run shift. */
  hips: THREE.Object3D;
  /**
   * Rotation from body space INTO the hip bone's parent space, and the metres
   * -> hip-local-units scale. Both derived, because a Mixamo export's skeleton
   * root may carry its own orientation and a 0.01 unit scale, and a hard-coded
   * offset would then be pointing the wrong way at the wrong size.
   */
  hipOffsetQuat: THREE.Quaternion;
  hipUnitsPerMetre: number;
  triangles: number;
  meshes: number;
  /** True when the export is mirrored w.r.t. our "left is -X" convention. */
  mirrored: boolean;
  /**
   * The BIND angle from the shin direction to the foot direction, radians, in
   * `Pose.ankleL`'s convention (0 = the foot continues the shin, + = toe further
   * behind). This is what the ankle looked like before anything drove it, so it
   * is the number `ANKLE_REST` in poses.ts has to match for the states nobody
   * asked to change to keep the silhouette they shipped with. Published through
   * `characterStats().ankleBind` so that match is checkable rather than claimed.
   */
  ankleBind: number;
  hipHeight: number;
}

function boxOf(root: THREE.Object3D): THREE.Box3 {
  return new THREE.Box3().setFromObject(root);
}

/**
 * Rebuild an authored glTF material as the flat-shaded Lambert the rest of the
 * game uses, keeping only the base colour. The source is colour-only PBR with
 * metalness 0, so nothing is lost, and this puts the hero in the same lighting
 * model as the city: it responds to DayNightSystem's sun and hemisphere exactly
 * like the procedural figure. Keep it LIT — see tools/build-assets.mjs.
 */
function toFigureMaterial(src: THREE.Material): THREE.MeshLambertMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const color = s.color ? s.color.clone() : new THREE.Color(0xcccccc);
  const mat = new THREE.MeshLambertMaterial({
    color,
    // Same trick as PlayerFigure: a little self-emission keeps the hero
    // readable against busy, dimly lit facades without adding lights or post.
    emissive: color.clone(),
    emissiveIntensity: 0.22,
    flatShading: true,
    // PRESERVE THE AUTHORED SIDEDNESS. All four source materials are
    // doubleSided:true — the suit is modelled as single-plane shells, as
    // low-poly characters usually are. Forcing FrontSide made faces whose
    // winding turned away from the camera disappear, so articulating the rig
    // opened holes in the chest and torso mid-swing. The city hit the exact
    // same bug on its facade planes. Cost is negligible at 3.6k triangles.
    side: src.side,
  });
  mat.name = `fx-character-${src.name || 'mat'}`;
  return mat;
}

/**
 * Mixamo clips carry root motion on the hips, which would slide the character
 * away from the simulated position. Strip horizontal hip translation (keeping
 * the vertical bob, which is the part that sells the run and the landing) and
 * drop every other position track: bones rotate, they do not translate.
 */
function stripRootMotion(clip: THREE.AnimationClip, hipsName: string): void {
  clip.tracks = clip.tracks.filter((track) => {
    if (!track.name.endsWith('.position')) return true;
    if (!track.name.startsWith(hipsName)) return false;
    const v = track.values;
    // Keep authored Y, pin X/Z to the first frame so the hips never drift.
    for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
    return true;
  });
}

/**
 * Load and prepare the authored character. Rejects if the asset is missing or
 * unusable; the caller stays on the procedural figure and warns once.
 */
export async function loadCharacterAsset(url: string): Promise<CharacterAsset> {
  const loader = new GLTFLoader();
  // REQUIRED: the shipped GLB is meshopt-compressed and will not parse without this.
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  const src = gltf.scene;

  // group -> align -> gltf scene. `align` carries the derived facing and hip
  // offset so `group`'s own transform stays free for position + steering yaw.
  const group = new THREE.Group();
  const align = new THREE.Group();
  align.add(src);
  group.add(align);

  const bones = new Map<string, THREE.Object3D>();
  const skins: THREE.SkinnedMesh[] = [];
  let triangles = 0;
  let meshes = 0;
  src.traverse((o) => {
    if ((o as THREE.Bone).isBone || bonesLikelyNamed(o.name)) bones.set(baseName(o.name), o);
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) {
      skins.push(m);
      meshes++;
      const index = m.geometry.getIndex();
      const pos = m.geometry.getAttribute('position');
      triangles += Math.floor((index ? index.count : pos ? pos.count : 0) / 3);
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      m.material = Array.isArray(m.material)
        ? mats.map(toFigureMaterial)
        : toFigureMaterial(mats[0]);
      // Skinned bounding volumes are computed at bind; the pose solver throws
      // limbs far outside them, and a hero culled mid-swing is unmissable.
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = false;
    }
  });
  if (skins.length === 0) throw new Error('[fx] character.glb has no skinned mesh');

  const hips = bones.get('Hips');
  const foot = bones.get('LeftFoot');
  const toe = bones.get('LeftToe_End') ?? bones.get('LeftToeBase');
  const handL = bones.get('LeftHand');
  const handR = bones.get('RightHand');
  const shoulderL = bones.get('LeftArm');
  const shoulderR = bones.get('RightArm');
  if (!hips || !foot || !toe || !handL || !handR || !shoulderL || !shoulderR) {
    throw new Error('[fx] character.glb is missing expected Mixamo joints');
  }

  // --- derive facing, then yaw the rig so it faces +Z -----------------------
  //
  // Measured off the SHOULDER AXIS, not the heel -> toe vector. The foot is a
  // ~0.15 m baseline whose horizontal component is mostly toe splay, and reading
  // facing off it landed the model a full 90° out (verified against the
  // procedural figure in the same shot — it faced away from the chase camera
  // while the model stood in profile). Right hand to left hand is a ~0.4 m
  // baseline that points squarely along the body's lateral axis.
  //
  // Our convention: facing +Z with +Y up puts the character's LEFT at -X. So
  // yaw until (rightArm -> leftArm) lies along -X, which fixes facing up to a
  // 180° flip, and settle the flip with the toe vector, where only its SIGN is
  // needed and that much it is reliable for.
  group.updateMatrixWorld(true);
  const side = shoulderL.getWorldPosition(new THREE.Vector3())
    .sub(shoulderR.getWorldPosition(new THREE.Vector3()));
  side.y = 0;
  if (side.lengthSq() > 1e-8) {
    side.normalize();
    // yaw that carries the side vector's bearing atan2(x, z) onto -X's bearing
    align.rotation.y = -Math.PI / 2 - Math.atan2(side.x, side.z);
    group.updateMatrixWorld(true);
    const heel = foot.getWorldPosition(new THREE.Vector3());
    const tip = toe.getWorldPosition(new THREE.Vector3());
    if (tip.z - heel.z < 0) align.rotation.y += Math.PI;
  }

  // --- hang the rig by its hip so the pivot matches the procedural figure ---
  group.updateMatrixWorld(true);
  const hipWorld = hips.getWorldPosition(new THREE.Vector3());
  const hipHeight = hipWorld.y;
  align.position.y -= hipHeight;
  group.updateMatrixWorld(true);

  // --- handedness: our convention is "the character's left is at -X" --------
  const mirrored = handL.getWorldPosition(new THREE.Vector3()).x > 0;

  // --- static rotation from the skeleton root's parent into body space ------
  let skeletonRoot: THREE.Object3D = hips;
  while (skeletonRoot.parent && skeletonRoot.parent !== align &&
         ((skeletonRoot.parent as THREE.Bone).isBone || bonesLikelyNamed(skeletonRoot.parent.name))) {
    skeletonRoot = skeletonRoot.parent;
  }
  const baseQuat = new THREE.Quaternion();
  const parent = skeletonRoot.parent ?? align;
  parent.getWorldQuaternion(baseQuat);
  const groupQ = new THREE.Quaternion();
  group.getWorldQuaternion(groupQ);
  baseQuat.premultiply(groupQ.invert());

  // --- capture each solved bone's bind direction toward its child -----------
  const solved = new Map<THREE.Object3D, SolvedBone>();
  const bodyQuat = group.getWorldQuaternion(new THREE.Quaternion()).invert();
  const boneWorld = new THREE.Quaternion();
  for (const [name, spec] of Object.entries(ROLE_BY_BONE)) {
    const bone = bones.get(name);
    const child = bones.get(spec.child) ?? (spec.childAlt ? bones.get(spec.childAlt) : undefined);
    if (!bone || !child) continue;
    const restDir = child.position.clone();
    if (restDir.lengthSq() < 1e-10) continue;
    restDir.normalize();
    const entry: SolvedBone = { bone, role: spec.role, restDir, smoothed: bone.quaternion.clone() };
    if (isFootRole(spec.role)) {
      // Body-space +X, expressed in the foot bone's own local space AT BIND.
      // `bodyQuat⁻¹ · boneWorld` is the bone's orientation in body space, so
      // inverting it carries body +X back down into the bone. This is the
      // reference the roll is resolved against every frame (`rollToSole`).
      bone.getWorldQuaternion(boneWorld);
      entry.soleRest = new THREE.Vector3(1, 0, 0)
        .applyQuaternion(boneWorld.premultiply(bodyQuat).invert())
        .normalize();
    }
    solved.set(bone, entry);
  }
  if (solved.size < 10) throw new Error('[fx] character.glb skeleton is not poseable');
  // A role whose bone name never matches fails SILENTLY — it just stops being
  // driven — which is exactly how the feet went unnoticed. Both must resolve.
  {
    const roles = new Set<Role>();
    for (const e of solved.values()) roles.add(e.role);
    if (!roles.has('footL') || !roles.has('footR')) {
      throw new Error('[fx] character.glb has no drivable foot joints');
    }
  }

  // Everything on a path from the skeleton root down to a solved bone; nothing
  // else needs visiting, because a bone the solver never writes cannot change
  // the accumulated rotation of a bone it does.
  const needed = new Set<THREE.Object3D>();
  for (const bone of solved.keys()) {
    for (let n: THREE.Object3D | null = bone; n && !needed.has(n); n = n.parent) {
      needed.add(n);
      if (n === skeletonRoot) break;
    }
  }
  const walkPlan = new Map<THREE.Object3D, THREE.Object3D[]>();
  for (const node of needed) walkPlan.set(node, node.children.filter((c) => needed.has(c)));

  const clips = new Map<string, THREE.AnimationClip>();
  for (const clip of gltf.animations) {
    stripRootMotion(clip, hips.name);
    clips.set(clip.name, clip);
  }

  // --- hip translation space -----------------------------------------------
  //
  // The wall-run shift is authored in METRES along body-space X. Converting it
  // into the units `hips.position` is actually expressed in needs the hip
  // parent's rotation (inverted: body -> parent) and its world scale.
  group.updateMatrixWorld(true);
  const hipParent = hips.parent ?? align;
  const hipParentQuat = hipParent.getWorldQuaternion(new THREE.Quaternion());
  const groupQuat = group.getWorldQuaternion(new THREE.Quaternion());
  // v_parent = Q_parent⁻¹ · Q_group · v_body
  const hipOffsetQuat = hipParentQuat.invert().multiply(groupQuat);
  const hipScale = hipParent.getWorldScale(new THREE.Vector3());
  const hipUnitsPerMetre = 1 / Math.max(1e-6, (hipScale.x + hipScale.y + hipScale.z) / 3);

  // --- the bind ankle -------------------------------------------------------
  const ankleBind = measureBindAnkle(solved, bones, bodyQuat.clone().invert());

  const bounds = boxOf(group);
  if (!(bounds.max.y - bounds.min.y > 0.5)) {
    throw new Error('[fx] character.glb has a degenerate bounding box');
  }

  return {
    group, clips, mixerRoot: src, solved, walkPlan, skeletonRoot, baseQuat,
    handL, handR, shoulderL, shoulderR, hips, hipOffsetQuat, hipUnitsPerMetre,
    triangles, meshes, mirrored, hipHeight, ankleBind,
  };
}

/**
 * Signed angle from the left shin's bind direction to the left foot's bind
 * direction, about body +X — the axis `limbDir` flexes every other joint about,
 * so the number is directly comparable with an authored `Pose.ankleL`.
 */
function measureBindAnkle(
  solved: Map<THREE.Object3D, SolvedBone>,
  bones: Map<string, THREE.Object3D>,
  groupWorldInv: THREE.Quaternion,
): number {
  const dirOf = (name: string): THREE.Vector3 | null => {
    const bone = bones.get(name);
    const entry = bone ? solved.get(bone) : undefined;
    if (!bone || !entry) return null;
    const q = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(groupWorldInv);
    return entry.restDir.clone().applyQuaternion(q).normalize();
  };
  const shin = dirOf('LeftLeg');
  const foot = dirOf('LeftFoot');
  if (!shin || !foot) return 0;
  const x = new THREE.Vector3(1, 0, 0);
  return +Math.atan2(
    new THREE.Vector3().crossVectors(shin, foot).dot(x),
    THREE.MathUtils.clamp(shin.dot(foot), -1, 1),
  ).toFixed(4);
}

/** Sketchfab/Mixamo exports do not always flag joints as Bone nodes. */
function bonesLikelyNamed(name: string): boolean {
  return /^mixamorig[:_]?/.test(name) || name.endsWith('rootJoint');
}

// --- runtime ----------------------------------------------------------------

/**
 * States the shipped clips cover outright; the pose solver stands down here.
 *
 * ON THE GROUND THERE IS EXACTLY ONE MOVEMENT CLIP AND IT IS `Run`. The asset
 * ships no walk and the hero has none: above `characterRunSpeed` — a threshold
 * set low on purpose — he runs, below it he stands. There is no in-between band
 * and no blend between Idle and Run, because a half-weight Run reads as a walk.
 *
 * WALL_RUN deliberately returns `Run` too. The owner asked for the same run
 * animation on the facade; what makes it a WALL run is the hip shift the caller
 * applies on top, not a different clip.
 */
function clipStateOf(state: TraversalState, speed: number): 'Idle' | 'Run' | null {
  if (state === 'IDLE') return 'Idle';
  if (state === 'LANDED') return speed > T.characterRunSpeed ? 'Run' : 'Idle';
  if (state === 'WALL_RUN') return 'Run';
  return null;
}

function isGrounded(state: TraversalState): boolean {
  return state === 'IDLE' || state === 'LANDED';
}

export class CharacterModel implements CharacterRig {
  readonly root = new THREE.Group();
  gripL = false;
  gripR = false;
  readonly gripHandL = new THREE.Object3D();
  readonly gripHandR = new THREE.Object3D();

  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private baseAction: THREE.AnimationAction | null = null;
  /** Remaining seconds of a Jump/Land one-shot; the clip owns the body while >0. */
  private oneShot = 0;
  /** The one-shot action currently layered over the base clip, if any. */
  private oneShotAction: THREE.AnimationAction | null = null;
  /** 0 = the shipped clip is in charge, 1 = the authored pose is. */
  private poseWeight = 0;
  /** The blend weight the last solve actually applied — see `poseReport`. */
  private lastSolveWeight = 0;
  private pullClock = -1;
  private prevGrounded = true;
  private started = false;
  /**
   * Variation, flips and secondary motion — the SAME controller the procedural
   * figure uses, so both character modes move alike. It also owns the run-cycle
   * phase for the pose fallback; the shipped Run clip has its own clock.
   */
  private motion = new MotionController();
  /** Whole-body flip pitch/roll this frame, applied to `asset.group`. */
  private flipPitch = 0;
  private flipRoll = 0;
  /** Clock and eased weight for the ground-rest idle sway. See `idleLife`. */
  private idleClock = 0;
  private idleWeight = 0;
  private idleOut = { sway: 0, nod: 0 };
  /**
   * The share of the pose's torso pitch carried by the WHOLE RIG rather than by
   * the spine bones. Smoothed at the pose blend rate, because unlike a flip it
   * follows a target that changes when the state does.
   *
   * WHY THIS EXISTS. The hips are not a solved joint — the solver points spine,
   * neck, arm and leg bones at directions and leaves the hip bone alone — so
   * `pose.body.x` could only ever bend the model's SPINE. Measured in the running
   * game against the same pose on the procedural figure: at a swing's authored
   * 1.15-2.35 rad the box figure tipped its entire body (legs trailing above the
   * torso, which is what the reference shows) while the model stood upright with
   * its chest bent and its legs hanging straight down. Splitting the pitch —
   * part on the rig, the remainder on the spine — reproduces the silhouette
   * without changing what the pose library means, because the two parts sum to
   * exactly the authored angle.
   */
  private rootPitch = 0;
  /** Smoothed signed hip shift toward the facade: -1 left, +1 right, 0 none. */
  private wallShift = 0;
  /** Recovers the facade normal from the snapshot's own motion (see poses.ts). */
  private wall = new WallTracker();
  /** The side resolved this frame, kept so `wallDebug` reports what was APPLIED. */
  private wallSideNow = 0;
  /** Hip translation written last frame, in hip-local units; backed out before
   *  the mixer runs so a clip without a hips position track cannot accumulate it. */
  private hipOffsetApplied = new THREE.Vector3();
  private hipOffset = new THREE.Vector3();

  /** Body-space limb directions for this frame, filled by `buildTargets`. */
  private targets: Record<Role, THREE.Vector3> = {
    spine: new THREE.Vector3(), spine1: new THREE.Vector3(), spine2: new THREE.Vector3(),
    neck: new THREE.Vector3(), head: new THREE.Vector3(),
    armL: new THREE.Vector3(), foreL: new THREE.Vector3(),
    armR: new THREE.Vector3(), foreR: new THREE.Vector3(),
    upLegL: new THREE.Vector3(), legL: new THREE.Vector3(),
    upLegR: new THREE.Vector3(), legR: new THREE.Vector3(),
    footL: new THREE.Vector3(), footR: new THREE.Vector3(),
  };
  private qBody = new THREE.Quaternion();
  private qJoint = new THREE.Quaternion();
  private qAccum = new THREE.Quaternion();
  private qInv = new THREE.Quaternion();
  private qSolve = new THREE.Quaternion();
  private qFlex = new THREE.Quaternion();
  private qTwist = new THREE.Quaternion();
  private qAim = new THREE.Quaternion();
  /** Head yaw for this frame; applied as a twist in `walk`, not as a direction. */
  private headTwist = 0;
  /** The ankle the pose asked for this frame; published through `wallDebug`. */
  private lastAnkleL = 0;
  private lastAnkleR = 0;
  private euler = new THREE.Euler();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpV3 = new THREE.Vector3();
  private tmpV4 = new THREE.Vector3();
  private qRoll = new THREE.Quaternion();
  private accumStack: THREE.Quaternion[] = [];

  constructor(scene: THREE.Scene, private asset: CharacterAsset) {
    this.root.add(asset.group);
    this.root.visible = false; // shown on the first update, once positioned
    scene.add(this.root);

    asset.handL.add(this.gripHandL);
    asset.handR.add(this.gripHandR);

    this.mixer = new THREE.AnimationMixer(asset.mixerRoot);
    for (const [name, clip] of asset.clips) {
      const action = this.mixer.clipAction(clip);
      if (name === 'Jump' || name === 'Land') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }
    this.play('Idle');
  }

  /**
   * Per-bone solve diagnostics: for every driven joint, the direction the pose
   * asked for and the direction the bone actually ends up pointing, both in body
   * space, plus the angular error between them. Exposed through
   * `__GAUNTLET__.characterStats().poseReport` so the solver can be checked
   * against the running game instead of by eye.
   */
  poseReport(): Array<{ role: Role; want: number[]; got: number[]; errDeg: number; authority: number }> {
    // THE ERROR IS ONLY MEANINGFUL AT FULL AUTHORITY. `want` is the pose's
    // target; `got` is where the bone ended up after `bone.quaternion.slerp(
    // solved, w)` blended it against whatever the shipped clip wrote. At w = 1
    // the solve is exact (setFromUnitVectors is a closed-form minimal rotation,
    // so the residual is the temporal smoothing only). At w < 1 the residual is
    // (1 - w) of the distance between the CLIP pose and the target — which is
    // per-bone, and in a Run clip the left and right limbs are half a stride
    // apart, so it is asymmetric BY CONSTRUCTION. Reporting errDeg without w
    // made that look like a left-side rigging bug. It is not; see the header.
    const out: Array<{ role: Role; want: number[]; got: number[]; errDeg: number; authority: number }> = [];
    const authority = +this.lastSolveWeight.toFixed(3);
    const got = new THREE.Vector3();
    const walk = (bone: THREE.Object3D, parentAccum: THREE.Quaternion) => {
      const accum = parentAccum.clone().multiply(bone.quaternion);
      const entry = this.asset.solved.get(bone);
      if (entry) {
        got.copy(entry.restDir).applyQuaternion(accum).normalize();
        const want = this.targets[entry.role];
        out.push({
          role: entry.role,
          want: want.toArray().map((v) => +v.toFixed(3)),
          got: got.toArray().map((v) => +v.toFixed(3)),
          errDeg: +THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(got.dot(want), -1, 1))).toFixed(1),
          authority,
        });
      }
      for (const c of this.asset.walkPlan.get(bone) ?? []) walk(c, accum);
    };
    walk(this.asset.skeletonRoot, this.asset.baseQuat);
    return out;
  }

  get poseAuthority(): number { return this.poseWeight; }
  /** The rig's bind ankle in radians; see CharacterAsset.ankleBind. */
  get ankleBind(): number { return this.asset.ankleBind; }
  /**
   * The share of torso pitch currently carried by the whole rig, in degrees.
   * Published because it MUST decay to zero on the ground: a clip-driven Run
   * played on a tipped rig is the exact regression this split could cause, and
   * it is not something a 60-pixel figure would show you.
   */
  get rootPitchDeg(): number { return +(this.rootPitch * 180 / Math.PI).toFixed(2); }
  /**
   * Which shipped clip is actually running, with what weight and at what rate.
   * The owner's rule is "ground movement is always Run and never reads as a
   * walk", and that is a claim about the CLIP and its PLAYBACK RATE, so both
   * have to be observable from outside rather than inferred from a screenshot.
   */
  clipReport(): Array<{ name: string; weight: number; timeScale: number; time: number }> {
    const out: Array<{ name: string; weight: number; timeScale: number; time: number }> = [];
    for (const [name, a] of this.actions) {
      const weight = a.getEffectiveWeight();
      if (!a.isRunning() || weight < 0.001) continue;
      out.push({
        name,
        weight: +weight.toFixed(3),
        timeScale: +a.getEffectiveTimeScale().toFixed(3),
        time: +a.time.toFixed(3),
      });
    }
    return out.sort((a, b) => b.weight - a.weight);
  }
  get triangles(): number { return this.asset.triangles; }
  get meshCount(): number { return this.asset.meshes; }

  private play(name: string): void {
    const next = this.actions.get(name);
    if (!next || next === this.baseAction) return;
    next.reset().setEffectiveWeight(1).fadeIn(T.characterClipFade).play();
    this.baseAction?.fadeOut(T.characterClipFade);
    this.baseAction = next;
  }

  /**
   * Fire Jump or Land over the top of the base clip for `seconds`.
   *
   * THE ONE-SHOT MUST BE TAKEN BACK OFF AGAIN. It used to be started at weight
   * 1 and never stopped: both are LoopOnce + clampWhenFinished, so each one
   * held its last frame at FULL weight for the rest of the session, and the
   * mixer normalises across everything bound to a joint. Measured in the running
   * game: Jump(w 1, t 1.72), Land(w 1, t 1.78) and Run(w 1) all live at once, so
   * the hero's ground movement was one third Run and two thirds two frozen
   * poses. That is the mechanism behind "it does not look like he is running" —
   * the clip was correct, its share of the joint was not.
   */
  private oneShotClip(name: string, seconds: number): void {
    const action = this.actions.get(name);
    if (!action) return;
    if (this.oneShotAction && this.oneShotAction !== action) this.oneShotAction.stop();
    action.reset().setEffectiveWeight(1).play();
    this.oneShotAction = action;
    this.oneShot = Math.max(this.oneShot, seconds);
  }

  /**
   * Ramp the running one-shot out and stop it dead at the end of its window.
   * The weight is driven explicitly rather than with `fadeOut` because a
   * LoopOnce action that has already clamped is paused, and leaving its removal
   * to the mixer is what let the leak above go unnoticed.
   */
  private tickOneShot(dt: number): void {
    if (!this.oneShotAction) { this.oneShot = 0; return; }
    this.oneShot = Math.max(0, this.oneShot - dt);
    if (this.oneShot <= 0) {
      this.oneShotAction.stop();
      this.oneShotAction = null;
      return;
    }
    this.oneShotAction.setEffectiveWeight(Math.min(1, this.oneShot / T.characterClipFade));
  }

  update(p: PlayerSnapshot, dt: number, groundPull: boolean): void {
    this.root.position.copy(p.position);
    this.root.visible = true;

    const horiz = Math.hypot(p.velocity.x, p.velocity.z);
    if (horiz > 0.5) this.root.rotation.y = Math.atan2(p.velocity.x, p.velocity.z);

    // Wall running turns the body ALONG the facade, so the wall is squarely to
    // one side. Without it a vertical climb keeps the approach yaw — pointing
    // into the wall — and the hip shift would push the hips forward instead.
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

    // --- which shipped clip, if any, owns the body ---------------------------
    const grounded = isGrounded(p.state);
    if (this.started) {
      // Land is a stop-and-absorb. Touching down still moving gets a short beat
      // of it and then hands the body straight back to the run — the hero does
      // not spend half a second not-running after every landing.
      if (grounded && !this.prevGrounded) {
        this.oneShotClip(
          'Land',
          p.speed > T.characterRunSpeed ? T.characterLandTimeMoving : T.characterLandTime,
        );
      }
      // The ground pull is a two-handed authored move, not a jump — never let
      // the shipped Jump clip steal it.
      else if (!grounded && this.prevGrounded && !groundPull && this.pullClock < 0) {
        this.oneShotClip('Jump', T.characterJumpTime);
      }
    }
    this.prevGrounded = grounded;
    this.started = true;

    this.tickOneShot(dt);
    const clip = clipStateOf(p.state, p.speed);
    if (clip) this.play(clip);
    else if (!this.baseAction) this.play('Idle');

    // Stride rate follows ground speed between a FLOOR and a ceiling. The floor
    // is what keeps this a run: the Run clip played slowly IS a walk, so below
    // the reference speed the cadence holds and only the travel shortens.
    const run = this.actions.get('Run');
    if (run) {
      run.timeScale = Math.min(
        T.runClipMaxRate,
        Math.max(T.runClipMinRate, (p.speed / T.runCycleRefSpeed) * T.runClipMaxRate),
      );
    }

    // Pose authority: 0 while a shipped clip covers the state (or a one-shot is
    // running), 1 for every state the asset ships nothing for. Blended, not
    // switched, so Jump -> AIRBORNE and SWING -> LANDED cross-fade.
    const wantPose = clip || this.oneShot > 0 ? 0 : 1;
    const kW = 1 - Math.exp(-T.characterPoseFadeRate * dt);
    this.poseWeight += (wantPose - this.poseWeight) * kW;

    // Back the hip shift out before the mixer runs. A clip that carries a hips
    // position track overwrites it anyway, but Idle/Jump/Land are not guaranteed
    // to, and an offset added on top of itself every frame would walk the hips
    // out of the body within a second.
    this.asset.hips.position.sub(this.hipOffsetApplied);
    this.hipOffsetApplied.set(0, 0, 0);

    this.mixer.update(dt);

    // --- hips toward the facade, while wall running --------------------------
    //
    // The owner's note: a figure running up or across a facade should not look
    // like it is running on flat ground in mid-air. Same clip, hips settled
    // slightly into the surface. Eased, so entering a wall run morphs.
    const wallSide = wallYaw !== null ? this.wall.side(wallYaw) : 0;
    this.wallSideNow = wallSide;
    this.wallShift += (wallSide - this.wallShift) * Math.min(1, T.wallRunShiftRate * dt);
    const shift = this.wallShift * wallRunDebug.scale;
    if (Math.abs(shift) > 1e-4) {
      // authored in metres along body +X (the character's right), converted into
      // whatever space and scale this export's hip bone actually lives in
      this.hipOffset
        .set(shift * T.wallRunHipShift * this.asset.hipUnitsPerMetre, 0, 0)
        .applyQuaternion(this.asset.hipOffsetQuat);
      this.asset.hips.position.add(this.hipOffset);
      this.hipOffsetApplied.copy(this.hipOffset);
    }
    // The motion layer: this visit's pose variant driven toward its physics
    // partner, the secondary layer, and the two whole-body angles below. Shared
    // with the procedural rig — see motion.ts.
    const m = this.motion.update(p, dt, this.root.rotation.y);
    // A SURFACE-CONTACT STATE OWNS THE BODY'S ORIENTATION AND REJECTS THE FLIP.
    //
    // The motion layer already resolves a flip on the contact frame, so this is
    // the second of two gates, and it is deliberately not the same one: the
    // failure the animation critic caught was this line and the rootPitch line
    // below ADDING flip roll and flip pitch straight on top of the wall-run tilt
    // and hip shift, so the hero ran a facade at 226.7 degrees of pitch. Wall
    // running consumes its own orientation FIRST; whatever the somersault was
    // doing is not part of it.
    const surface = isSurfaceContactState(p.state);
    this.flipPitch = surface ? 0 : m.flipPitch;
    this.flipRoll = surface ? 0 : m.flipRoll;

    // `asset.group` carries every whole-body rotation that is not the root's
    // yaw: the wall-run tilt, the flip pitch / body roll, and the idle sway.
    //
    // …the wall tilt is a small roll about the hip pivot, toward the wall. The
    // shift alone slides the body sideways; the roll is what makes it read as
    // leaning INTO the surface. Positive Z tips the body's up axis toward -X, so
    // a wall on the character's right (+X) takes the negative sign.
    //
    // NOTE: `aimAt` assumes the rig carries yaw only. That still holds wherever
    // the grip solve runs — gripping needs SWING/WEB_ATTACH, the wall tilt
    // decays to 0 within ~0.2 s of leaving WALL_RUN, a flip is zero on any
    // tethered or surface frame, and the idle sway only runs at ground rest.
    const idle = this.idleLife(p, dt);
    this.asset.group.rotation.z = -shift * T.wallRunTorsoTilt + this.flipRoll + idle.sway;

    // The ground pull overrides everything, including a shipped clip: it is the
    // one authored move that has to read on the ground.
    const statePose = m.pose;
    const pull = tickGroundPull(this.pullClock, groundPull, dt, statePose);
    this.pullClock = pull.clock;
    const w = Math.max(this.poseWeight, pull.weight);
    this.lastSolveWeight = w;

    // Split the torso pitch between the rig and the spine (see `rootPitch`),
    // scaled by pose authority so a shipped clip that owns the body is never
    // tipped by a pose it is not playing. THIS RUNS BEFORE THE EARLY RETURN:
    // authority reaching zero is exactly when the rig has to un-tip, and doing
    // it after the return left the model leaning through every Run clip.
    const wantRoot = pull.pose.body.x * T.motionBodyPitchToRoot * w;
    this.rootPitch += (wantRoot - this.rootPitch) * (1 - Math.exp(-m.blendRate * dt));
    this.asset.group.rotation.x = this.flipPitch + this.rootPitch + idle.nod;

    if (w <= 0.001) { this.gripL = this.gripR = false; return; }


    this.resolveGrip(p, pull.weight);
    this.buildTargets(pull.pose, p);
    this.solve(dt, w);
  }

  /**
   * Ground-rest idle life, model mode.
   *
   * The critic's finding was that the visible ground idle is "quiet and mostly
   * dead", and in THIS rig that is structural rather than a matter of taste: at
   * ground rest the shipped `Idle` clip is playing, so pose authority is 0 and
   * every joint offset the motion layer's idle layer writes is multiplied away.
   * The only channel left is the one the clip does not own — the rig group — so
   * the weight shift arrives here, as a slow sway with a slower nod against it.
   *
   * Both are clock-driven at frequencies that do not divide each other, so the
   * body never settles into a single visible pulse, and both fade in and out on
   * `idleWeight` so stepping off into a run does not snap the torso upright.
   */
  private idleLife(p: PlayerSnapshot, dt: number): { sway: number; nod: number } {
    const atRest = p.speed < T.characterRunSpeed && isSurfaceContactState(p.state);
    this.idleWeight += ((atRest ? 1 : 0) - this.idleWeight) * Math.min(1, 3 * dt);
    const out = this.idleOut;
    if (this.idleWeight < 0.002) { out.sway = 0; out.nod = 0; return out; }
    this.idleClock += dt;
    const a = this.idleClock * Math.PI * 2;
    out.sway = Math.sin(a * T.motionIdleShiftHz) * T.motionIdleBodySwayRad * this.idleWeight;
    out.nod = Math.sin(a * T.motionBreathHz) * T.motionIdleBodyNodRad * this.idleWeight;
    return out;
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
      // the model's limbs are clip-driven on the ground, so report the TARGETS
      hipLx: +this.targets.upLegL.z.toFixed(3),
      hipRx: +this.targets.upLegR.z.toFixed(3),
      kneeL: +this.targets.legL.z.toFixed(3),
      kneeR: +this.targets.legR.z.toFixed(3),
      bodyX: +this.targets.spine.z.toFixed(3),
      ankleL: +this.lastAnkleL.toFixed(3),
      ankleR: +this.lastAnkleR.toFixed(3),
    };
  }

  /** Same rule as the procedural figure: the hand on the anchor's side grips. */
  private resolveGrip(p: PlayerSnapshot, pullWeight: number): void {
    this.gripL = false;
    this.gripR = false;
    if (pullWeight >= 0.5) return;
    if (!p.anchorPosition || (p.state !== 'SWING' && p.state !== 'WEB_ATTACH')) return;
    // MINUS sin: world -> body is the inverse yaw. See PlayerFigure.update for
    // the measurement — with plus, an anchor on the character's right resolved
    // to the left hand at yaw 90, and `aimAt` (which is correct) then reached
    // that arm across the chest.
    const cos = Math.cos(this.root.rotation.y);
    const sin = Math.sin(this.root.rotation.y);
    const localX = (p.anchorPosition.x - p.position.x) * cos - (p.anchorPosition.z - p.position.z) * sin;
    if (localX >= 0) this.gripR = true; else this.gripL = true;
  }

  /** Body-space direction of a limb whose rest direction is -Y, hung off `qBody`. */
  private limbDir(out: THREE.Vector3, e: EulerTarget, flex: number | null): THREE.Vector3 {
    this.euler.set(e.x, 0, e.z);
    this.qJoint.setFromEuler(this.euler);
    if (flex !== null) {
      this.euler.set(flex, 0, 0);
      this.qJoint.multiply(this.qFlex.setFromEuler(this.euler));
    }
    out.set(0, -1, 0).applyQuaternion(this.qJoint).applyQuaternion(this.qBody);
    return out.normalize();
  }

  /** Direction from a bone's world position to a world point, in body space. */
  private aimAt(out: THREE.Vector3, from: THREE.Object3D, target: THREE.Vector3): boolean {
    this.root.updateMatrixWorld(true);
    from.getWorldPosition(this.tmpV);
    this.tmpV2.copy(target).sub(this.tmpV);
    // World -> body space is the INVERSE of the group's actual world rotation.
    // It used to be the root's yaw alone, on the assumption that the rig carried
    // no tilt; `asset.group` now also carries the flip, the body roll and the
    // rig's share of the torso pitch, and a grip arm aimed through a yaw-only
    // transform would miss the anchor by exactly those angles.
    this.asset.group.getWorldQuaternion(this.qAim).invert();
    this.tmpV2.applyQuaternion(this.qAim);
    if (this.tmpV2.lengthSq() < 1e-6) return false;
    out.copy(this.tmpV2).normalize();
    return true;
  }

  private buildTargets(pose: Pose, p: PlayerSnapshot): void {
    const t = this.targets;
    // The rig already carries `rootPitch` of the torso pitch; the spine carries
    // what is left, so rig + spine sum to the authored `pose.body.x`.
    this.euler.set(pose.body.x - this.rootPitch, 0, pose.body.z + p.lean * 0.2);
    this.qBody.setFromEuler(this.euler);

    // torso: one rigid segment, so every spine joint points the same way
    this.tmpV.set(0, 1, 0).applyQuaternion(this.qBody).normalize();
    t.spine.copy(this.tmpV);
    t.spine1.copy(this.tmpV);
    t.spine2.copy(this.tmpV);

    this.euler.set(pose.head.x, 0, 0);
    this.qJoint.setFromEuler(this.euler);
    t.neck.set(0, 1, 0).applyQuaternion(this.qJoint).applyQuaternion(this.qBody).normalize();
    t.head.copy(t.neck);
    // HEAD YAW IS NOT EXPRESSIBLE AS A DIRECTION TARGET. The solver points each
    // bone at a direction, and a head turn is a rotation ABOUT the neck axis,
    // which leaves that direction untouched — feeding pose.head.y through
    // `limbDir` would do literally nothing. So it is carried separately and
    // applied in `walk` as a twist about the head bone's own rest axis, which is
    // exactly a head turn and leaves `poseReport`'s errDeg untouched (a twist
    // about restDir maps restDir to itself).
    this.headTwist = pose.head.y;

    const mir = this.asset.mirrored;
    const armL = mir ? t.armR : t.armL;
    const foreL = mir ? t.foreR : t.foreL;
    const armR = mir ? t.armL : t.armR;
    const foreR = mir ? t.foreL : t.foreR;
    const upLegL = mir ? t.upLegR : t.upLegL;
    const legL = mir ? t.legR : t.legL;
    const upLegR = mir ? t.upLegL : t.upLegR;
    const legR = mir ? t.legL : t.legR;
    const footL = mir ? t.footR : t.footL;
    const footR = mir ? t.footL : t.footR;

    this.limbDir(armL, pose.shoulderL, null);
    this.limbDir(foreL, pose.shoulderL, pose.elbowL);
    this.limbDir(armR, pose.shoulderR, null);
    this.limbDir(foreR, pose.shoulderR, pose.elbowR);
    this.limbDir(upLegL, pose.hipL, null);
    this.limbDir(legL, pose.hipL, pose.kneeL);
    this.limbDir(upLegR, pose.hipR, null);
    this.limbDir(legR, pose.hipR, pose.kneeR);
    // The ankle is authored RELATIVE TO THE SHIN (poses.ts), so it composes onto
    // the knee flex exactly the way the knee composes onto the hip: ankle 0
    // makes the foot a straight continuation of the shin, and the value is how
    // far past that the toe is carried.
    this.lastAnkleL = ankleOf(pose, 'L');
    this.lastAnkleR = ankleOf(pose, 'R');
    this.limbDir(footL, pose.hipL, pose.kneeL + this.lastAnkleL);
    this.limbDir(footR, pose.hipR, pose.kneeR + this.lastAnkleR);

    // The gripping arm reaches for the real anchor instead of the pose, so the
    // hand stays on the web line however the arc swings around.
    if ((this.gripL || this.gripR) && p.anchorPosition) {
      const upper = this.gripL ? this.asset.shoulderL : this.asset.shoulderR;
      const armT = this.gripL ? armL : armR;
      const foreT = this.gripL ? foreL : foreR;
      this.tmpV.set(p.anchorPosition.x, p.anchorPosition.y, p.anchorPosition.z);
      if (this.aimAt(armT, upper, this.tmpV)) foreT.copy(armT);
    }
  }

  /**
   * Walk the skeleton top-down, converting each solved bone's body-space target
   * into a local rotation. `accum` is the rotation from the current bone's
   * PARENT space into body space, so it has to be rebuilt from the final
   * (already blended) local rotations as we descend — which is why this is one
   * traversal and not a per-bone lookup.
   */
  private solve(dt: number, w: number): void {
    const kPose = 1 - Math.exp(-T.poseBlendRate * dt);
    this.qAccum.copy(this.asset.baseQuat);
    this.walk(this.asset.skeletonRoot, this.qAccum, kPose, w, 0);
  }

  /**
   * Roll `this.qSolve` about the already-aimed direction `dir` (in the bone's
   * PARENT space) until the bone-local axis `soleRest` — which pointed along
   * body +X at bind — points back along body +X again, minus whatever component
   * runs along `dir` itself. `scale` blends the correction in, and exists so a
   * critic can A/B the twisted and untwisted ankle in one session
   * (`__GAUNTLET__.setAnkleRollScale`).
   */
  private rollToSole(soleRest: THREE.Vector3, dir: THREE.Vector3, scale: number): void {
    // where the sole axis actually ends up after the aim, in parent space
    const have = this.tmpV2.copy(soleRest).applyQuaternion(this.qSolve);
    have.addScaledVector(dir, -have.dot(dir));
    if (have.lengthSq() < 1e-8) return;
    have.normalize();
    // where it should be: body +X carried into parent space, same projection
    const want = this.tmpV3.set(1, 0, 0).applyQuaternion(this.qInv);
    want.addScaledVector(dir, -want.dot(dir));
    if (want.lengthSq() < 1e-8) return;
    want.normalize();
    const angle = Math.atan2(
      this.tmpV4.crossVectors(have, want).dot(dir),
      THREE.MathUtils.clamp(have.dot(want), -1, 1),
    );
    if (Math.abs(angle) < 1e-5) return;
    this.qRoll.setFromAxisAngle(dir, angle * scale);
    this.qSolve.premultiply(this.qRoll);
  }

  private walk(bone: THREE.Object3D, accum: THREE.Quaternion, kPose: number, w: number, depth: number): void {
    const entry = this.asset.solved.get(bone);
    // `drive` 0 restores the pre-ankle-channel behaviour for the feet only: the
    // bone is skipped entirely, so it keeps whatever the mixer wrote. See
    // ankleRollDebug.
    if (entry && !(entry.soleRest && ankleRollDebug.drive <= 0)) {
      this.qInv.copy(accum).invert();
      this.tmpV.copy(this.targets[entry.role]).applyQuaternion(this.qInv).normalize();
      this.qSolve.setFromUnitVectors(entry.restDir, this.tmpV);
      // THE FOOT GETS A ROLL AS WELL AS A DIRECTION. Everything above is a
      // minimal-arc aim, which pins where a bone POINTS and says nothing about
      // how it is rolled about its own axis; the roll it happens to come out
      // with drifts as the target direction moves. On a shin that is invisible.
      // On a foot it is the twisted ankle: the sole ends up facing wherever the
      // shortest arc left it, and further out of true the further the leg is
      // swung. `rollToSole` adds the one rotation about the aimed direction that
      // carries the sole's medial-lateral axis back onto body +X, so the sole
      // faces somewhere deliberate. A twist about `tmpV` maps `tmpV` to itself,
      // so the aim — and therefore poseReport's errDeg — is untouched by it.
      if (entry.soleRest && ankleRollDebug.roll > 0) {
        this.rollToSole(entry.soleRest, this.tmpV, ankleRollDebug.roll);
      }
      // temporal smoothing lives on our own copy, so the mixer never fights it
      entry.smoothed.slerp(this.qSolve, kPose);
      bone.quaternion.slerp(entry.smoothed, w);
      // …then the head look, as a twist about the bone's own axis (see
      // buildTargets). Scaled by the same authority, so a shipped clip that owns
      // the body keeps its own head.
      if (entry.role === 'head' && Math.abs(this.headTwist) > 1e-4) {
        this.qTwist.setFromAxisAngle(entry.restDir, this.headTwist * w);
        bone.quaternion.multiply(this.qTwist);
      }
    }
    const kids = this.asset.walkPlan.get(bone);
    if (!kids || kids.length === 0) return;
    // Depth is bounded by the rig (hips -> shin is 3); the guard only exists so
    // a malformed asset cannot hang a frame.
    if (depth > 24) return;
    const child = this.accumStack[depth] ??= new THREE.Quaternion();
    child.copy(accum).multiply(bone.quaternion);
    for (const c of kids) this.walk(c, child, kPose, w, depth + 1);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) mat.dispose();
    });
  }
}
