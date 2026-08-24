import * as THREE from 'three';
import type { PlayerSnapshot } from '../contracts';
import { makeRng } from '../contracts';
import { FX_TUNING as T } from './tuning';
import { cameraHandle } from '../camera/cameraHandle';
import { inputHandle } from '../input/inputHandle';

/**
 * OWNED BY: feel-builder.
 * Cheap screen-space speed cues (VISUAL_FEEDBACK.md). Critique-driven:
 *  - streaks ALIGN to the screen-projected travel direction, not fixed spokes
 *  - tinted toward the scene/fog colour so midnight never blows out
 *  - low opacity, gated behind speed so it is ZERO at rest
 *  - a clear centre punch so the player silhouette is never overdrawn
 *  - wind wisps stream past the camera against the velocity vector
 */

const OVERLAY_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const OVERLAY_FRAG = `
uniform float uSpeed;
uniform float uDive;
uniform float uProx;
uniform float uDiveCue;
uniform float uAspect;
uniform float uMaxOpacity;
uniform vec3 uTint;
uniform vec2 uTravel;   // screen-space unit direction of travel
varying vec2 vUv;

void main() {
  vec2 p = vUv - 0.5;
  p.x *= uAspect;
  float r = length(p);

  // clear centre: the player must never be overdrawn
  float centre = smoothstep(0.0, 0.28, r);

  float speed = uSpeed;
  float dive = uDive;
  float prox = uProx;

  // speed gate: no overlay at rest, ramps in over a narrow band
  float speedGate = smoothstep(0.30, 0.70, speed);
  float diveGate = smoothstep(0.35, 0.75, dive);

  // travel-aligned streak field. perp uses screen position, not normalized
  // angle, so the cue is parallel motion streaks instead of a centre-pinned star.
  float perp = p.x * uTravel.y - p.y * uTravel.x;
  // fine, high-frequency lines parallel to travel
  float lines = pow(abs(sin(perp * 90.0)), 18.0);
  // soft comb of offset streaks
  float comb = pow(abs(sin(perp * 30.0 + 0.5)), 6.0);

  // dive: concentric expansion rings toward screen edge
  float rings = pow(abs(sin(r * 36.0)), 12.0);
  float ringEdge = smoothstep(0.35, 0.9, r);

  float alpha = 0.0;
  alpha += lines * comb * 0.24 * speedGate;
  alpha += rings * ringEdge * 0.32 * diveGate * dive * uDiveCue;
  alpha += smoothstep(0.05, 0.4, -p.y) * prox * 0.15;

  alpha *= centre;
  alpha = clamp(alpha, 0.0, uMaxOpacity);

  gl_FragColor = vec4(uTint, alpha);
}
`;

export class SpeedOverlay {
  private quad: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private wisps: THREE.LineSegments;
  private wispGeo: THREE.BufferGeometry;
  private wispMat: THREE.LineBasicMaterial;
  /** Streak centres — the simulation state the recycle test reads. */
  private wispPos: Float32Array;
  /** Two vertices per streak: centre ± airflow * len / 2. */
  private wispVertPos: Float32Array;
  private wispAnchors: Float32Array;
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private velView = new THREE.Vector3();
  private tint = new THREE.Color(0x9fb6cc);
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uSpeed: { value: 0 },
        uDive: { value: 0 },
        uProx: { value: 0 },
        uDiveCue: { value: 0 },
        uAspect: { value: 1 },
        uMaxOpacity: { value: T.streakOpacity },
        uTint: { value: new THREE.Vector3(0.62, 0.71, 0.8) },
        uTravel: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.renderOrder = 999;
    quad.frustumCulled = false;
    this.quad = quad;
    // The full-screen streak quad is OFF by default: at speed it filled the frame
    // with pale diagonal rays and read as a cheap lens effect rather than motion.
    // Kept behind a flag rather than deleted so it can be brought back and retuned.
    // Speed is still communicated by FOV, camera distance, ground proximity and
    // the 3D wind wisps, which are unaffected by this switch.
    quad.visible = T.screenStreaks;
    if (T.screenStreaks) scene.add(quad);

    // wind wisps — fixed count, deterministic layout
    const n = T.wispCount;
    this.wispPos = new Float32Array(n * 3);
    this.wispAnchors = new Float32Array(n * 3);
    const rng = makeRng(0xfeed);
    for (let i = 0; i < n; i++) {
      const az = rng() * Math.PI * 2;
      const rad = 2 + rng() * T.wispSpread;
      const depth = (rng() - 0.35) * T.wispSpread;
      const y = (rng() - 0.5) * T.wispSpread * 0.6;
      this.wispAnchors[i * 3] = Math.cos(az) * rad;
      this.wispAnchors[i * 3 + 1] = y;
      this.wispAnchors[i * 3 + 2] = depth;
    }
    // One streak per wisp, 2 vertices each. The geometry spans the CENTRE P
    // plus/minus the airflow direction u scaled by len/2, so P (the simulation
    // state) is untouched and the recycle test keeps working as it did.
    this.wispVertPos = new Float32Array(n * 6);
    this.wispGeo = new THREE.BufferGeometry();
    this.wispGeo.setAttribute('position', new THREE.BufferAttribute(this.wispVertPos, 3));
    this.wispMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.wisps = new THREE.LineSegments(this.wispGeo, this.wispMat);
    this.wisps.frustumCulled = false;
    this.wisps.renderOrder = 998;
    scene.add(this.wisps);
  }

  update(p: PlayerSnapshot, dt: number): void {
    const cam = cameraHandle.camera;
    if (!cam) return;

    // --- overlay quad: snap to the camera, cover the frustum at overlayDist ---
    this.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    if (T.screenStreaks) {
      this.tmpV.copy(cam.position).addScaledVector(this.fwd, T.overlayDist);
      this.quad.position.copy(this.tmpV);
      this.quad.quaternion.copy(cam.quaternion);
      const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * T.overlayDist;
      const halfW = halfH * cam.aspect;
      this.quad.scale.set(halfW, halfH, 1);
    }

    const speed = p.speed;
    const speedT = THREE.MathUtils.clamp(speed / T.overlaySpeedRef, 0, 1);
    const diveT = THREE.MathUtils.clamp(-p.velocity.y / T.overlayDiveRef, 0, 1);
    const proxT = THREE.MathUtils.clamp(1 - p.altitude / 26, 0, 1);
    const engaged = inputHandle.used.web || inputHandle.used.dash || inputHandle.used.jump
      || p.state === 'WEB_ATTACH' || p.state === 'SWING' || p.state === 'RELEASE' || p.state === 'DASH';

    // --- screen-space travel direction (project velocity into view space) ---
    this.velView.copy(p.velocity).applyQuaternion(cam.quaternion.clone().invert());
    // view space: +x right, +y up; NDC x right, y down -> flip y
    let tx = this.velView.x, ty = -this.velView.y;
    const tlen = Math.hypot(tx, ty);
    if (tlen > 1e-3) { tx /= tlen; ty /= tlen; }
    else { tx = 1; ty = 0; }

    // --- tint from the scene fog colour (time-of-day driven) ---
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      this.tint.copy(fog.color);
      // lift the tint so the additive glow reads on any backdrop, not just dark
      this.tint.lerp(new THREE.Color(0xffffff), 0.25);
    }

    const u = this.mat.uniforms;
    if (T.screenStreaks) {
    u.uSpeed.value = speedT;
    u.uDive.value = diveT;
    u.uProx.value = proxT;
    u.uDiveCue.value = engaged ? 1 : 0;
    u.uAspect.value = cam.aspect;
    u.uMaxOpacity.value = T.streakOpacity + T.proximityOpacity * proxT;
    (u.uTint.value as THREE.Vector3).set(this.tint.r, this.tint.g, this.tint.b);
    (u.uTravel.value as THREE.Vector2).set(tx, ty);
    }

    // --- wind wisps: stream past the camera against the velocity vector ---
    const speed3 = Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z);
    const wind = speed3 > T.wispGateSpeed;
    this.wispMat.opacity = wind ? Math.min(1, speed3 / T.wispOpacityRefSpeed) * T.wispOpacity : 0;
    // Tint the streaks toward the scene/fog colour so midnight never blows out.
    this.wispMat.color.copy(this.tint);

    const invSpeed = speed3 > 1 ? 1 / speed3 : 0;
    const ux = -p.velocity.x * invSpeed;
    const uy = -p.velocity.y * invSpeed;
    const uz = -p.velocity.z * invSpeed;

    // Streak length stretches with speed — a constant-length streak is the
    // giveaway that the effect is fake.
    const len = THREE.MathUtils.clamp(
      speed3 * T.streakSeconds,
      T.streakMinLength,
      T.streakMaxLength,
    );
    const hx = ux * len * 0.5;
    const hy = uy * len * 0.5;
    const hz = uz * len * 0.5;

    for (let i = 0; i < T.wispCount; i++) {
      const i3 = i * 3;
      let x = this.wispPos[i3];
      let y = this.wispPos[i3 + 1];
      let z = this.wispPos[i3 + 2];
      // drift opposite the travel direction
      x += ux * speed3 * dt;
      y += uy * speed3 * dt;
      z += uz * speed3 * dt;
      // recycle when they fall too far behind the camera
      this.tmpV.set(x - cam.position.x, y - cam.position.y, z - cam.position.z);
      if (this.tmpV.dot(this.fwd) < -6) {
        const a = this.wispAnchors[i3];
        const b = this.wispAnchors[i3 + 1];
        const c = this.wispAnchors[i3 + 2];
        this.tmpV2.set(
          cam.position.x + a,
          cam.position.y + b,
          cam.position.z + c,
        );
        x = this.tmpV2.x; y = this.tmpV2.y; z = this.tmpV2.z;
      }
      this.wispPos[i3] = x;
      this.wispPos[i3 + 1] = y;
      this.wispPos[i3 + 2] = z;
      const i6 = i * 6;
      this.wispVertPos[i6] = x - hx;
      this.wispVertPos[i6 + 1] = y - hy;
      this.wispVertPos[i6 + 2] = z - hz;
      this.wispVertPos[i6 + 3] = x + hx;
      this.wispVertPos[i6 + 4] = y + hy;
      this.wispVertPos[i6 + 5] = z + hz;
    }
    (this.wispGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.quad.geometry.dispose();
    this.mat.dispose();
    this.wispGeo.dispose();
    this.wispMat.dispose();
  }
}
