/**
 * OWNED BY: city-builder.
 *
 * Full day/night cycle driven by the sun's elevation angle. Dawn, dusk and
 * night retain the authored phase ramps. During full daylight the actual sky
 * material is sampled toward the sun, zenith and nadir to keep direct and
 * hemispheric light in the same colour world as the sky.
 *
 *  - procedural SkyDome gradient with a sun disc/glow and night stars
 *  - a minimum ambient floor keeps building mid-tones from collapsing to black
 *    at night and sunset (AGENTS.md rule 4: no extra lights, no post-processing)
 *  - fog colour is driven from the time-of-day horizon ramp, and fog density is
 *    altitude-based so the street canyon closes in while high perches keep a
 *    layered skyline
 *  - emissive building windows fade in at dusk and glow at night
 *
 * __GAUNTLET__.setTimeOfDay(t) pauses the cycle and jumps to t (0..1).
 */
import * as THREE from 'three';
import type { System, UpdateContext } from '../contracts';
import { SkyDome } from './SkyDome';
import { isClassicMode, onClassicModeChange } from '../core/ClassicMode';

// phase design colours (sRGB hex from VISUAL_SPEC.md palette targets)
const NIGHT_TOP = 0x1f1d21;
const NOON_TOP = 0x8eb7cf;
const RISE_TOP = 0xb8896f;
const SET_TOP = 0x8a533e;
const NIGHT_BOTTOM = 0x372f2e;
const NOON_BOTTOM = 0xb7c9c8;
const RISE_BOTTOM = 0x916253;
const SET_BOTTOM = 0xa56e50;

const SKY_SAMPLE_SECONDS = 1.5;
const DAYLIGHT_SAMPLE_START = Math.sin(20 * Math.PI / 180);
const SHADOW_MAP_SIZE = 2048;
const SHADOW_HALF_EXTENT = 320;
const SHADOW_CAMERA_DISTANCE = 850;
const SHADOW_CAMERA_NEAR = 360;
const SHADOW_CAMERA_FAR = 1350;
const SHADOW_FOCUS_LEAD = 60;
const SHADOW_FOCUS_Y_MIN = 35;
const SHADOW_FOCUS_Y_MAX = 95;
const SHADOW_FADE_START = -0.04;
const SHADOW_FADE_FULL = 0.12;

// --- distance fog ----------------------------------------------------------
// Fog belongs to the EYE, so the ramp below is driven by the render camera's
// altitude, continuously, and rate-limited. The previous three-band ternary
// driven by the player's y snapped `far` 480 -> 1000 in a single frame twice in
// eleven seconds of ordinary swinging, deleting or restoring whole ranks of
// towers instantly (docs/critique/BUILDINGS_VISUAL.md §1).
/** Altitudes the ramp interpolates between; below/above these it is flat. */
const FOG_ALT_LOW = 8;
const FOG_ALT_HIGH = 150;
/** Street-canyon end of the ramp: enough haze to give the canyon depth. */
const FOG_NEAR_LOW = 45;
const FOG_FAR_LOW = 700;
/**
 * Open-sky end. `far` stops just inside the impostor ring so the ring's outer
 * boundary is still hidden: impostorChunkRadius 4 * 3 blocks * ~85 m puts the
 * nearest ring edge ~1020 m out in the worst case.
 */
const FOG_NEAR_HIGH = 160;
const FOG_FAR_HIGH = 1020;
/** Night no longer buries the city (`far` used to collapse to 320 m); it only
 *  pulls `near` in, so lit windows read further out than daylight silhouettes. */
const FOG_NIGHT_NEAR_SCALE = 0.6;
const FOG_NIGHT_FAR_SCALE = 0.95;
/** Altitude easing time constant, seconds — smooths a fast dive or launch. */
const FOG_ALT_TAU = 0.35;
/** Belt-and-braces rate caps on the resulting planes, metres per second. */
const FOG_NEAR_RATE = 150;
const FOG_FAR_RATE = 900;

// --- classic mode ----------------------------------------------------------
// The first build had NO distance fog at all. Rather than swapping `scene.fog`
// to null (which forces every material in the scene to recompile, twice per
// toggle), the fog planes are parked past the camera's far plane (4000 m): the
// fog term is exactly zero for every fragment that can be drawn, so the result
// is identical and the toggle costs nothing.
const CLASSIC_FOG_NEAR = 4000;
const CLASSIC_FOG_FAR = 8000;

interface SkyLightSample {
  sun: THREE.Color;
  zenith: THREE.Color;
  nadir: THREE.Color;
}

function makeSkyLightSample(): SkyLightSample {
  return {
    sun: new THREE.Color(0xfff0d6),
    zenith: new THREE.Color(0x8f9fae),
    nadir: new THREE.Color(0x3f464c),
  };
}

function copySkyLightSample(target: SkyLightSample, source: SkyLightSample): void {
  target.sun.copy(source.sun);
  target.zenith.copy(source.zenith);
  target.nadir.copy(source.nadir);
}

export class DayNightSystem implements System {
  static instance: DayNightSystem | null = null;

  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  timeOfDay = 0.58;
  /** Full cycle length in seconds. */
  cycleSeconds = 240;
  paused = false;

  private sun = new THREE.DirectionalLight(0xffffff, 3);
  private hemi = new THREE.HemisphereLight(0xbfd4ff, 0x39404a, 0.5);
  private skyDome = new SkyDome();
  private sunDir = new THREE.Vector3();
  private shadowFocus = new THREE.Vector3();
  private shadowFocusSource = new THREE.Vector3();
  private shadowFocusVelocity = new THREE.Vector3();
  private shadowViewFocus = new THREE.Vector3();
  private shadowWorldOffset = new THREE.Vector3();
  private shadowMatrix = new THREE.Matrix4();
  private shadowViewRight = new THREE.Vector3();
  private shadowViewUp = new THREE.Vector3();
  private windowMats: THREE.MeshLambertMaterial[] = [];
  private windowGlow = 0;

  // fog distance state (see the FOG_* constants above)
  /** Eased camera altitude the fog ramp reads. */
  private fogAlt = 0;
  private fogNear = FOG_NEAR_LOW;
  private fogFar = FOG_FAR_LOW;
  /** Night weight published by apply() for the render-time fog update. */
  private fogNight = 0;
  private fogSnap = true;
  private fogLastMs = 0;

  /** Classic mode: no distance fog, no dynamic shadows. See core/ClassicMode. */
  private classic = isClassicMode();
  private unsubscribeClassic: () => void;

  // The renderer is captured from Object3D.onBeforeRender, avoiding a new
  // cross-system contract solely for a slow-changing sky probe.
  private renderer: THREE.WebGLRenderer | null = null;
  private sampleScene = new THREE.Scene();
  private sampleSky: THREE.Mesh;
  private sampleCamera = new THREE.OrthographicCamera(-0.25, 0.25, 0.25, -0.25, 0.1, 200);
  private sampleZenithDir = new THREE.Vector3(0, 1, 0);
  private sampleNadirDir = new THREE.Vector3(0, -1, 0);
  private sampleTarget = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
  });
  private samplePixel = new Uint8Array(4);
  private sampleRaw = makeSkyLightSample();
  private sampleFrom = makeSkyLightSample();
  private sampleTo = makeSkyLightSample();
  private sampleCurrent = makeSkyLightSample();
  private sampleElapsed = Number.POSITIVE_INFINITY;
  private sampleBlend = 1;
  private snapNextSample = true;

  // scratch colours to keep apply() allocation-free
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();
  private c3 = new THREE.Color();
  private c4 = new THREE.Color();
  private c5 = new THREE.Color();
  private tmpB = new THREE.Color();
  private neutral = new THREE.Color();

  constructor(private scene: THREE.Scene) {
    DayNightSystem.instance = this;
    this.skyDome.mesh.scale.setScalar(3600);
    scene.add(this.sun, this.hemi, this.skyDome.mesh);
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun.target);
    this.configureShadows();

    scene.fog = new THREE.Fog(0xa9bcd2, 80, 480);
    scene.background = new THREE.Color(0x0a0e16);

    // Clone geometry/material only: sampling exactly the live sky shader keeps
    // the derived light valid when its photographic layer or grading changes.
    this.sampleSky = this.skyDome.mesh.clone();
    this.sampleSky.position.set(0, 0, 0);
    this.sampleSky.scale.setScalar(100);
    this.sampleSky.frustumCulled = false;
    this.sampleScene.add(this.sampleSky);
    this.sampleTarget.texture.colorSpace = THREE.NoColorSpace;
    this.sampleCamera.position.set(0, 0, 0);
    this.sampleCamera.up.set(0, 0, 1);

    const priorBeforeRender = this.skyDome.mesh.onBeforeRender;
    this.skyDome.mesh.onBeforeRender = (renderer, renderScene, camera, geometry, material, group) => {
      if (renderer instanceof THREE.WebGLRenderer) this.renderer = renderer;
      // The eye is only defined at render time, and the render loop keeps
      // drawing while the sim is paused — so the fog distance is driven from
      // here rather than from update(). The sky dome is a 3600-unit sphere the
      // camera sits inside, so it is drawn on every frame the scene is drawn.
      // (The sky probe uses a clone made above this assignment, so it never
      // re-enters here with the 1x1 sample camera.)
      this.updateFogDistance(camera.position.y);
      priorBeforeRender.call(this.skyDome.mesh, renderer, renderScene, camera, geometry, material, group);
    };

    // Classic mode is applied through the same two paths a normal frame uses
    // (updateFogDistance for the fog planes, updateShadowRig for the sun), so
    // there is exactly one implementation of each and toggling cannot drift
    // from booting. `fogSnap` makes the return trip land on the eased value the
    // current altitude implies rather than crawling back at the rate cap.
    this.unsubscribeClassic = onClassicModeChange((on) => {
      this.classic = on;
      this.fogSnap = true;
      this.refreshShadows();
    });

    this.apply();
  }

  private configureShadows(): void {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.bias = -0.00012;
    this.sun.shadow.normalBias = 0.16;
    this.sun.shadow.radius = 1;
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_HALF_EXTENT;
    cam.right = SHADOW_HALF_EXTENT;
    cam.top = SHADOW_HALF_EXTENT;
    cam.bottom = -SHADOW_HALF_EXTENT;
    cam.near = SHADOW_CAMERA_NEAR;
    cam.far = SHADOW_CAMERA_FAR;
    cam.updateProjectionMatrix();
  }

  /** CitySystem registers its shared window material; glow is applied here (works while paused). */
  registerWindowMaterial(mat: THREE.MeshLambertMaterial): void {
    if (!this.windowMats.includes(mat)) {
      this.windowMats.push(mat);
      mat.emissiveIntensity = this.windowGlow;
    }
  }

  /**
   * Continuous, camera-driven, rate-limited distance fog.
   *
   * Three things had to change together, because fixing only one leaves the
   * snap in place: the altitude -> distance mapping is a smoothstep rather than
   * three bands, its input is the render camera rather than the player (whose
   * altitude changes while the view does not), and both the input and the
   * output are eased so a dive or a launch ramps instead of cutting.
   */
  private updateFogDistance(cameraY: number): void {
    const fog = this.scene.fog as THREE.Fog;
    if (this.classic) {
      fog.near = CLASSIC_FOG_NEAR;
      fog.far = CLASSIC_FOG_FAR;
      // Keep the eased state snapping on the way back out, so leaving classic
      // mode restores the exact planes this altitude would already be at.
      this.fogSnap = true;
      this.fogLastMs = 0;
      return;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    // real-time dt: this runs at render rate, which is not the sim tick rate
    let dt = this.fogLastMs > 0 ? (now - this.fogLastMs) / 1000 : 1 / 60;
    this.fogLastMs = now;
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60; // tab-switch / first frame guard

    if (this.fogSnap) this.fogAlt = cameraY;
    else this.fogAlt += (cameraY - this.fogAlt) * (1 - Math.exp(-dt / FOG_ALT_TAU));

    const k = THREE.MathUtils.smoothstep(this.fogAlt, FOG_ALT_LOW, FOG_ALT_HIGH);
    const night = this.fogNight;
    const targetNear = THREE.MathUtils.lerp(FOG_NEAR_LOW, FOG_NEAR_HIGH, k)
      * THREE.MathUtils.lerp(1, FOG_NIGHT_NEAR_SCALE, night);
    const targetFar = THREE.MathUtils.lerp(FOG_FAR_LOW, FOG_FAR_HIGH, k)
      * THREE.MathUtils.lerp(1, FOG_NIGHT_FAR_SCALE, night);

    if (this.fogSnap) {
      this.fogNear = targetNear;
      this.fogFar = targetFar;
      this.fogSnap = false;
    } else {
      const dn = THREE.MathUtils.clamp(targetNear - this.fogNear, -FOG_NEAR_RATE * dt, FOG_NEAR_RATE * dt);
      const df = THREE.MathUtils.clamp(targetFar - this.fogFar, -FOG_FAR_RATE * dt, FOG_FAR_RATE * dt);
      this.fogNear += dn;
      this.fogFar += df;
    }
    fog.near = this.fogNear;
    fog.far = this.fogFar;
  }

  setTimeOfDay(t: number): void {
    this.timeOfDay = ((t % 1) + 1) % 1;
    // A telemetry jump must settle to the exact same fog as arriving there
    // naturally, so critics never capture a frame mid-ease.
    this.fogSnap = true;
    // Direct telemetry jumps are sparse and must settle to the exact same light
    // regardless of the path taken to this time of day.
    this.sampleElapsed = Number.POSITIVE_INFINITY;
    this.snapNextSample = true;
    this.apply();
  }

  /** Refresh the fitted shadow volume after synchronous critic teleports. */
  refreshShadows(): void {
    const elev = this.sunDir.y;
    const shadowStrength = THREE.MathUtils.smoothstep(elev, SHADOW_FADE_START, SHADOW_FADE_FULL);
    this.updateShadowRig(elev, shadowStrength);
  }

  setShadowFocus(position: THREE.Vector3, velocity?: THREE.Vector3): void {
    this.shadowFocusSource.copy(position);
    if (velocity) this.shadowFocusVelocity.copy(velocity);
    else this.shadowFocusVelocity.set(0, 0, 0);
  }

  private updateShadowRig(elev: number, shadowStrength: number): void {
    this.shadowFocus.copy(this.shadowFocusSource);
    this.shadowWorldOffset.set(this.shadowFocusVelocity.x, 0, this.shadowFocusVelocity.z);
    const speed = this.shadowWorldOffset.length();
    if (speed > 4) {
      this.shadowFocus.addScaledVector(this.shadowWorldOffset, Math.min(SHADOW_FOCUS_LEAD, speed * 0.75) / speed);
    }
    this.shadowFocus.y = THREE.MathUtils.clamp(
      this.shadowFocusSource.y * 0.25 + 30,
      SHADOW_FOCUS_Y_MIN,
      SHADOW_FOCUS_Y_MAX,
    );

    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(this.sunDir, SHADOW_CAMERA_DISTANCE);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();

    const cam = this.sun.shadow.camera;
    cam.position.copy(this.sun.position);
    cam.lookAt(this.sun.target.position);
    cam.updateMatrixWorld(true);
    this.shadowMatrix.copy(cam.matrixWorld).invert();
    this.shadowViewFocus.copy(this.shadowFocus).applyMatrix4(this.shadowMatrix);

    const texel = (SHADOW_HALF_EXTENT * 2) / SHADOW_MAP_SIZE;
    const snapX = Math.round(this.shadowViewFocus.x / texel) * texel;
    const snapY = Math.round(this.shadowViewFocus.y / texel) * texel;
    const dx = snapX - this.shadowViewFocus.x;
    const dy = snapY - this.shadowViewFocus.y;
    this.shadowViewRight.setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(dx);
    this.shadowViewUp.setFromMatrixColumn(cam.matrixWorld, 1).multiplyScalar(dy);
    this.shadowFocus.add(this.shadowViewRight).add(this.shadowViewUp);

    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(this.sunDir, SHADOW_CAMERA_DISTANCE);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();

    // Classic mode had no dynamic shadows at all. Dropping the sun's cast flag
    // (rather than renderer.shadowMap.enabled) is enough: with no shadow-casting
    // light the shadow pass does not run, and the flag is restored by the very
    // next updateShadowRig when classic turns off.
    const canCast = !this.classic && elev > SHADOW_FADE_START && shadowStrength > 0.001;
    this.sun.castShadow = canCast;
    this.sun.shadow.autoUpdate = canCast;
    this.sun.shadow.needsUpdate = canCast;
    this.sun.shadow.intensity = shadowStrength;
  }

  private sampleDirection(out: THREE.Color, direction: THREE.Vector3): boolean {
    const renderer = this.renderer;
    if (!renderer) return false;

    this.sampleCamera.lookAt(direction);
    renderer.setRenderTarget(this.sampleTarget);
    renderer.clear();
    renderer.render(this.sampleScene, this.sampleCamera);
    renderer.readRenderTargetPixels(this.sampleTarget, 0, 0, 1, 1, this.samplePixel);

    const r = this.samplePixel[0];
    const g = this.samplePixel[1];
    const b = this.samplePixel[2];
    if (this.samplePixel[3] === 0 || r + g + b < 3) return false;
    // SkyDome writes an sRGB-encoded pixel; Color converts it back to the
    // linear-light values expected by three.js light colours.
    out.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    return true;
  }

  private captureSkyLight(): boolean {
    const renderer = this.renderer;
    if (!renderer) return false;

    const priorTarget = renderer.getRenderTarget();
    const priorAutoClear = renderer.autoClear;
    const priorXr = renderer.xr.enabled;
    renderer.autoClear = true;
    renderer.xr.enabled = false;

    let valid = false;
    try {
      const sunOk = this.sampleDirection(this.sampleRaw.sun, this.sunDir);
      const zenithOk = this.sampleDirection(this.sampleRaw.zenith, this.sampleZenithDir);
      const nadirOk = this.sampleDirection(this.sampleRaw.nadir, this.sampleNadirDir);
      valid = sunOk && zenithOk && nadirOk;
    } finally {
      renderer.setRenderTarget(priorTarget);
      renderer.autoClear = priorAutoClear;
      renderer.xr.enabled = priorXr;
    }

    if (!valid) return false;
    if (this.snapNextSample) {
      copySkyLightSample(this.sampleFrom, this.sampleRaw);
      copySkyLightSample(this.sampleTo, this.sampleRaw);
      copySkyLightSample(this.sampleCurrent, this.sampleRaw);
      this.sampleBlend = 1;
      this.snapNextSample = false;
    } else {
      copySkyLightSample(this.sampleFrom, this.sampleCurrent);
      copySkyLightSample(this.sampleTo, this.sampleRaw);
      this.sampleBlend = 0;
    }
    this.sampleElapsed = 0;
    return true;
  }

  private updateSampleBlend(): void {
    const u = THREE.MathUtils.smoothstep(this.sampleBlend, 0, 1);
    this.sampleCurrent.sun.lerpColors(this.sampleFrom.sun, this.sampleTo.sun, u);
    this.sampleCurrent.zenith.lerpColors(this.sampleFrom.zenith, this.sampleTo.zenith, u);
    this.sampleCurrent.nadir.lerpColors(this.sampleFrom.nadir, this.sampleTo.nadir, u);
  }

  /** Preserve sampled hue while setting a stable lighting-energy target. */
  private setLuminance(out: THREE.Color, source: THREE.Color, target: number): void {
    out.copy(source);
    const luma = source.r * 0.2126 + source.g * 0.7152 + source.b * 0.0722;
    if (luma > 0.001) out.multiplyScalar(target / luma);
    const peak = Math.max(out.r, out.g, out.b);
    if (peak > 1) out.multiplyScalar(1 / peak);
  }

  /**
   * Physical sky sampling becomes implausibly blue once the sun clears roughly
   * 20 degrees. Retain its hue relationship, but pull high-sun ambient toward
   * a same-luminance warm neutral and cap the blue/red ratio.
   */
  private correctHighSunBlue(color: THREE.Color, elevation: number): void {
    const correction = THREE.MathUtils.smoothstep(elevation, DAYLIGHT_SAMPLE_START, 0.82);
    if (correction <= 0) return;
    const luma = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
    this.neutral.setRGB(luma * 1.08, luma * 1.02, luma * 0.92);
    color.lerp(this.neutral, correction * 0.42);
    color.b = Math.min(color.b, Math.max(color.r * 1.35, color.g * 1.18));
  }

  /** 4-way colour blend, allocation-free: out = N*wN + D*wD + R*wR + S*wS (linear). */
  private blend4(
    out: THREE.Color, hN: number, wN: number, hD: number, wD: number,
    hR: number, wR: number, hS: number, wS: number,
  ): void {
    out.setHex(hN).multiplyScalar(wN);
    out.add(this.tmpB.setHex(hD).multiplyScalar(wD));
    out.add(this.tmpB.setHex(hR).multiplyScalar(wR));
    out.add(this.tmpB.setHex(hS).multiplyScalar(wS));
  }

  private apply(): void {
    const t = this.timeOfDay;
    const ang = (t - 0.25) * Math.PI * 2;
    // the sun never quite reaches the zenith so the day sky keeps a blue top
    const elev = Math.sin(ang) * 0.86;
    const cosA = Math.cos(ang);
    // day falls off fast as the sun nears the horizon so dawn/dusk read clearly
    const day = THREE.MathUtils.smoothstep(elev, -0.05, 0.5);
    const dusk = Math.exp(-(elev * elev) * 30);
    const night = THREE.MathUtils.clamp(-elev * 3.2, 0, 1);
    const wDay = day;
    const wDusk = dusk * (1 - day);
    const wNight = Math.max(0, 1 - wDay - wDusk);
    const rising = Math.max(0, cosA);   // sun east of zenith (dawn side)
    const setting = Math.max(0, -cosA); // sun west of zenith (dusk side)
    const wRise = wDusk * rising;
    const wSet = wDusk * setting;

    // sun direction: rises in +X, arcs overhead, sets in -X
    this.sunDir.set(cosA * 0.94, elev, 0.34).normalize();
    const shadowStrength = THREE.MathUtils.smoothstep(elev, SHADOW_FADE_START, SHADOW_FADE_FULL);
    this.updateShadowRig(elev, shadowStrength);

    // Authored baseline: this remains authoritative at dawn/dusk/night.
    // Day intensity stays moderate so up-facing surfaces (road/roof/car top) never
    // clip; the hemisphere carries the overall brightness (see below).
    this.blend4(this.c1, 0x8fb4ff, wNight, 0xfff0d6, wDay, 0xffb45e, wRise, 0xff8a3d, wSet);
    this.sun.color.copy(this.c1);
    this.sun.intensity = 0.5 * wNight + 1.0 * wDay + 0.75 * wRise + 0.85 * wSet;

    // hemisphere ambient — the value floor. Sky colour is what lights up-facing
    // surfaces (roads take the sky tint), so it is authored moderately dark and
    // warmed per phase; ground colour lights vertical facades.
    this.blend4(this.c3, 0x3a4350, wNight, 0x8f9fae, wDay, 0xa8846a, wRise, 0xd07040, wSet);
    this.blend4(this.c4, 0x1c1f26, wNight, 0x3f464c, wDay, 0x4a3c34, wRise, 0x45322a, wSet);
    this.hemi.color.copy(this.c3);
    this.hemi.groundColor.copy(this.c4);
    this.hemi.intensity = 0.95 * wNight + 1.05 * wDay + 1.0 * wRise + 1.15 * wSet;

    // ACES protects daylight highlights but compresses low-light Lambert
    // values. Phase-specific energy compensation preserves the already graded
    // dawn/dusk/night exposure without changing their colours.
    const lowLightLift = 1 + 0.4 * wRise + 1.0 * wSet + 3.0 * wNight;
    this.sun.intensity *= lowLightLift;
    this.hemi.intensity *= lowLightLift;

    // Fog COLOUR is a function of time of day and belongs here. Fog DISTANCE is
    // a function of the eye's altitude and is driven per render frame by
    // updateFogDistance(); this only publishes the night weight it needs.
    this.blend4(this.c2, NIGHT_BOTTOM, wNight, NOON_BOTTOM, wDay, RISE_BOTTOM, wRise, SET_BOTTOM, wSet);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.c2);
    this.fogNight = night;
    (this.scene.background as THREE.Color).copy(this.c2);

    // sky dome: zenith vs horizon per phase, sun disc/glow, night stars
    this.blend4(this.c1, NIGHT_TOP, wNight, NOON_TOP, wDay, RISE_TOP, wRise, SET_TOP, wSet);
    this.blend4(this.c2, NIGHT_BOTTOM, wNight, NOON_BOTTOM, wDay, RISE_BOTTOM, wRise, SET_BOTTOM, wSet);
    this.blend4(this.c5, 0x9fb8e8, wNight, 0xfff0d6, wDay, 0xffb45e, wRise, 0xff8a3d, wSet);
    this.skyDome.state = {
      top: this.c1,
      bottom: this.c2,
      sunColor: this.c5,
      sunDir: this.sunDir,
      sunIntensity: 0.18 * wNight + 1.4 * wDay + 0.85 * wRise + 0.95 * wSet,
      night,
    };

    // Sample only while the derived result can influence the frame. Three tiny
    // readbacks happen every 1.5 simulation seconds, never every render frame.
    const daylightMix = THREE.MathUtils.smoothstep(elev, 0.28, 0.62) * wDay;
    if (daylightMix > 0.001 && this.sampleElapsed >= SKY_SAMPLE_SECONDS) {
      this.captureSkyLight();
    }
    this.updateSampleBlend();

    if (daylightMix > 0.001 && this.sampleElapsed < Number.POSITIVE_INFINITY) {
      this.setLuminance(this.c1, this.sampleCurrent.sun, 0.92);
      this.correctHighSunBlue(this.c1, elev);
      this.sun.color.lerp(this.c1, daylightMix);
      this.sun.intensity = THREE.MathUtils.lerp(this.sun.intensity, 1.75, daylightMix);

      this.setLuminance(this.c3, this.sampleCurrent.zenith, 0.42);
      this.correctHighSunBlue(this.c3, elev);
      this.hemi.color.lerp(this.c3, daylightMix);

      this.setLuminance(this.c4, this.sampleCurrent.nadir, 0.14);
      this.correctHighSunBlue(this.c4, elev);
      this.hemi.groundColor.lerp(this.c4, daylightMix);
      this.hemi.intensity = THREE.MathUtils.lerp(this.hemi.intensity, 1.25, daylightMix);

      // The fog horizon follows the lower-sky sample during full daylight, but
      // dawn/dusk retain their independently graded ramps.
      this.setLuminance(this.c2, this.sampleCurrent.nadir, 0.48);
      this.correctHighSunBlue(this.c2, elev);
      fog.color.lerp(this.c2, daylightMix * 0.65);
      (this.scene.background as THREE.Color).copy(fog.color);
    }

    // The sky's horizon band is painted as a modulation OF the fog colour (see
    // SkyDome's header), so it is pushed here — after every adjustment to
    // fog.color above — and never as part of `state`. `state` is applied before
    // captureSkyLight() renders this same material for the light probe, and the
    // probe's nadir sample is what feeds fog.color: routing the horizon colour
    // through `state` would close that loop and let the fog chase itself.
    this.skyDome.horizonColor = fog.color;

    // windows come on as the day fades
    this.windowGlow = THREE.MathUtils.clamp(1 - day * 1.3, 0, 1);
    for (let i = 0; i < this.windowMats.length; i++) {
      this.windowMats[i].emissiveIntensity = this.windowGlow;
    }
  }

  update(ctx: UpdateContext): void {
    if (!this.paused) {
      this.timeOfDay = (this.timeOfDay + ctx.dt / this.cycleSeconds) % 1;
    }
    this.sampleElapsed += ctx.dt;
    this.sampleBlend = Math.min(1, this.sampleBlend + ctx.dt / SKY_SAMPLE_SECONDS);
    // keep the sky dome centred on the camera rig (fog altitude is read from the
    // render camera in updateFogDistance, not from the player)
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __GAUNTLET__?: { player?: () => { position?: THREE.Vector3 } | null } };
      const p = w.__GAUNTLET__?.player?.();
      if (p && p.position) {
        this.skyDome.mesh.position.set(p.position.x, 0, p.position.z);
      }
    }
    this.apply();
  }

  dispose(): void {
    this.unsubscribeClassic();
    this.skyDome.dispose();
    this.sampleTarget.dispose();
  }
}
