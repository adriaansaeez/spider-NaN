/**
 * OWNED BY: city-builder.
 *
 * Retro sky dome — authored phase colours + sun disc from DayNightSystem,
 * with photographic day / night plates (public/assets/sky.webp and
 * sky-night.webp). Day plate is high-sun only; night plate cross-fades in
 * through dusk via the existing `night` factor so sunrise/sunset ramps stay
 * authored. Neither plate replaces the cycle.
 *
 * THE SKY IS A CAPSULE, NOT A LID
 * -------------------------------
 * Both plates are STEREOGRAPHIC discs projected from the zenith, so they carry
 * no horizon data whatsoever — `stereoUV`'s denominator saturates as dir.y -> 0
 * and the sampled radius runs off the plate, where `plateCoverage()` fades it
 * out. That is why the photograph used to be visible only when looking up.
 *
 * The band beneath the plates is therefore owned by a THIRD asset: a wide
 * azimuthal strip (`sky-horizon.webp`, built by tools/build-sky-horizon.mjs
 * from the bottom 38% of the same photograph — the part the day plate crops
 * away). It is authored genuinely seamless and wraps ONCE around the azimuth
 * with plain RepeatWrapping — no mirror axis, no repeat.
 *
 * SKY MUST AGREE WITH FOG, OR YOU TRADE ONE ARTEFACT FOR A WORSE ONE
 * ------------------------------------------------------------------
 * Distance fog owns the skyline and buildings dissolve into `fog.color`. So the
 * strip is not painted as a colour in its own right — it is a UNIT-MEAN
 * MODULATION of the fog colour (divided by HORIZON_MEAN_LUM), and its strength
 * ramps to exactly zero at the fog line. At dir.y = 0 the sky is therefore
 * *identically* fog.color, and the photographic structure only appears as you
 * look up out of the haze. No matching pass, no drift across the cycle: the
 * agreement is algebraic. The low dome below the horizon is blended to the same
 * colour for the same reason — but held OFF at the nadir, because
 * DayNightSystem's downward light probe reads the dome there and feeds
 * fog.color, and letting it read this would close a feedback loop.
 *
 * SkyState is the contract with DayNightSystem — accept exactly these fields
 * and react to them. Both files have one owner; do not widen it from elsewhere.
 */
import * as THREE from 'three';
import { isClassicMode, onClassicModeChange } from '../core/ClassicMode';

export interface SkyState {
  top: THREE.Color;
  bottom: THREE.Color;
  sunColor: THREE.Color;
  sunDir: THREE.Vector3;
  sunIntensity: number;
  night: number;
}

const SKY_URL = '/assets/sky.webp';
const NIGHT_SKY_URL = '/assets/sky-night.webp';
const HORIZON_URL = '/assets/sky-horizon.webp';

/**
 * Mean linear luminance of sky-horizon.webp, printed by
 * tools/build-sky-horizon.mjs. Dividing the sampled strip by this makes it a
 * unit-mean modulation, so `fogColour * strip` averages back to the fog colour
 * instead of brightening or darkening the whole skyline. Re-paste the number if
 * the source photograph is ever re-authored.
 */
const HORIZON_MEAN_LUM = 0.1763;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly unsubscribeClassic: () => void;
  private uniforms: {
    top: { value: THREE.Color };
    bottom: { value: THREE.Color };
    sunColor: { value: THREE.Color };
    sunDir: { value: THREE.Vector3 };
    sunIntensity: { value: number };
    night: { value: number };
    skyMap: { value: THREE.Texture };
    hasMap: { value: number };
    nightMap: { value: THREE.Texture };
    hasNightMap: { value: number };
    horizonMap: { value: THREE.Texture };
    hasHorizonMap: { value: number };
    horizonCol: { value: THREE.Color };
    /** 1 = classic mode: procedural gradient only, no photographic plates. */
    classic: { value: number };
  };

  constructor() {
    // 1×1 stubs so the samplers are always bound before the async loads land.
    const stub = new THREE.DataTexture(new Uint8Array([120, 160, 220, 255]), 1, 1);
    stub.needsUpdate = true;
    const nightStub = new THREE.DataTexture(new Uint8Array([8, 10, 18, 255]), 1, 1);
    nightStub.needsUpdate = true;
    const horizonStub = new THREE.DataTexture(new Uint8Array([150, 170, 190, 255]), 1, 1);
    horizonStub.needsUpdate = true;

    this.uniforms = {
      top: { value: new THREE.Color(0x070b16) },
      bottom: { value: new THREE.Color(0x0d1524) },
      sunColor: { value: new THREE.Color(0xffd9a0) },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      sunIntensity: { value: 0 },
      night: { value: 0 },
      skyMap: { value: stub },
      hasMap: { value: 0 },
      nightMap: { value: nightStub },
      hasNightMap: { value: 0 },
      horizonMap: { value: horizonStub },
      hasHorizonMap: { value: 0 },
      // Seeded to the same colour DayNightSystem seeds scene.fog with, so the
      // first frame before apply() runs is already self-consistent.
      horizonCol: { value: new THREE.Color(0xa9bcd2) },
      classic: { value: isClassicMode() ? 1 : 0 },
    };

    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vDir = normalize(wp.xyz - cameraPosition);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 top;
        uniform vec3 bottom;
        uniform vec3 sunColor;
        uniform vec3 sunDir;
        uniform float sunIntensity;
        uniform float night;
        uniform sampler2D skyMap;
        uniform float hasMap;
        uniform sampler2D nightMap;
        uniform float hasNightMap;
        uniform sampler2D horizonMap;
        uniform float hasHorizonMap;
        uniform vec3 horizonCol;
        uniform float classic;

        const float HORIZON_MEAN_LUM = ${HORIZON_MEAN_LUM.toFixed(4)};
        const float INV_TWO_PI = 0.15915494;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        // ShaderMaterial does not auto-decode sRGB textures — convert manually.
        vec3 srgbToLinear(vec3 c) {
          return pow(c, vec3(2.2));
        }

        // Stereographic plate UV from zenith (optional yaw). Not equirect —
        // equirect pinched every azimuth into one texel at dir.y→1 and left a
        // hard join at the atan wrap.
        //
        // PLATE_K sets how fast the sampled radius grows toward the horizon:
        // radius reaches PLATE_S (the inscribed circle, so the plate is never
        // sampled outside its own texture) at elevation sin ~0.16. It was 0.55,
        // which put that limit at ~0.38 and made the disc a lid; 0.827 spreads
        // the same photograph down to ~9 degrees, which is where the horizon
        // strip picks it up. The zenith is ~15% less magnified as a result,
        // which if anything sharpens it.
        const float PLATE_K = 0.827;
        const float PLATE_S = 0.46;

        vec2 stereoUV(vec3 dir, float rotCs, float rotSn) {
          vec3 r = vec3(rotCs * dir.x - rotSn * dir.z, dir.y, rotSn * dir.x + rotCs * dir.z);
          float denom = max(r.y, 0.06) + PLATE_K;
          return vec2(r.x, r.z) / denom * PLATE_S + 0.5;
        }

        /**
         * How much of the plate survives at this elevation, 1 at the zenith and
         * 0 at its rim.
         *
         * This used to be a per-AXIS fade on uv, which is a SQUARE in plate
         * space. Because the plate is rotated by the sun's azimuth, that square
         * cut the photograph off at elevation ~0.31 along the sun-aligned axes
         * but let it survive to ~0.11 on the diagonals — a rim whose height
         * swung ~20 degrees with the yaw you happened to be facing, and read as
         * the edge of a dome. It also left a coverage hole (plate already faded,
         * strip not yet full) through which the flat base gradient showed as a
         * pale ring under the dark one.
         *
         * Radial instead. The stereographic radius depends only on elevation,
         * so the rim is now a circle of constant elevation — parallel to the
         * horizon, identical at every azimuth, and wide enough (elevation ~0.68
         * down to ~0.16, roughly 30 degrees) that there is no edge to see. The
         * zenith photograph above 0.68 is untouched.
         */
        float plateCoverage(float elev) {
          float rho = sqrt(max(1.0 - elev * elev, 0.0));
          // Normalised so 1.0 is exactly the inscribed circle of the plate.
          float radius = rho / (max(elev, 0.06) + PLATE_K);
          return 1.0 - smoothstep(0.55, 1.0, radius);
        }

        void main() {
          // Classic mode: the three photographic layers and the fog-coloured
          // low dome are all gated off by this one factor, leaving exactly the
          // authored gradient + sun disc + procedural stars of the first build.
          float plates = 1.0 - classic;

          vec3 dir = normalize(vDir);
          float h = clamp(dir.y, -0.06, 1.0);
          float t = pow((h + 0.06) / 1.06, 0.62);
          vec3 col = mix(bottom, top, t);
          vec3 tint = mix(bottom, top, t);
          float tintLum = max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 0.08);

          // Plates are zenith discs with NO horizon data (see file header), so
          // they still fade out before the skyline. What changed is that the
          // band they vacate is no longer flat authored colour — the horizon
          // strip below owns it, and the handover is now a pure function of
          // elevation (see plateCoverage) so it looks the same at every azimuth.
          float horizonFade = plateCoverage(dir.y);

          // The strip is an UNCONDITIONAL underlay across the whole handover
          // range, not the plate's complement. Making it complementary left a
          // residual (1-p)*p of flat base gradient showing through the middle of
          // the crossfade — the pale ring. Laying it down at full weight and
          // compositing the plate over it means the only two things that ever
          // meet are two photographs.
          float bandGate = smoothstep(-0.30, -0.03, dir.y) * (1.0 - smoothstep(0.68, 0.92, dir.y));

          // --- Low dome = fog colour ---------------------------------------
          // Buildings dissolve into fog.color, so the sky they dissolve against
          // is that same colour. Held off at the nadir: DayNightSystem's
          // downward probe samples the dome at dir.y = -1 and that sample feeds
          // fog.color, so letting it read horizonCol would close a loop. Held
          // off at altitude too, so the graded zenith keeps its own colour.
          col = mix(col, horizonCol, plates * smoothstep(-0.85, -0.05, dir.y) * (1.0 - smoothstep(0.35, 0.80, dir.y)));

          // --- Horizon strip (wraps the world; this is the capsule) ---------
          float bandW = bandGate * hasHorizonMap * plates;
          if (bandW > 0.001) {
            // ONE wrap around the azimuth, plain Repeat. The strip is built
            // genuinely seamless (256 px wrap cross-fade in
            // tools/build-sky-horizon.mjs), so there is no mirror and no
            // repeat. Two mirrored wraps were also seamless, but put a mirror
            // axis every 90 degrees, and once the strip covered enough
            // elevation to hide the plate handover that folded the whole sky
            // symmetrically about the screen centre. Do NOT clamp this uv.
            float az = atan(dir.z, dir.x);
            // v: image bottom (v=0) is the lowest elevation of the crop. The
            // exponent compresses the photograph toward the skyline the way
            // perspective does, so cloud banks recede instead of stacking.
            // The divisor spans the whole handover (up to elevation ~0.68) so
            // the strip still has real content everywhere the plate is less
            // than opaque; clamping it lower left the strip's top row smeared
            // vertically underneath the middle of the crossfade. The exponent
            // is re-solved (0.46/0.80 -> 0.68/0.69) to keep the mapping at the
            // skyline itself, which was already right, essentially unchanged.
            float ev = clamp((dir.y + 0.03) / 0.68, 0.0, 1.0);
            vec2 buv = vec2(az * INV_TWO_PI, pow(ev, 0.69));

            vec3 hp = srgbToLinear(texture2D(horizonMap, buv).rgb);
            // Unit-mean modulation, not a colour: fogColour * strip averages
            // back to fogColour, so the strip adds structure without ever
            // disagreeing about what colour the skyline is.
            //
            // Split into unit-mean LUMINANCE and unit-luma CHROMA. Luminance is
            // the cloud structure and always applies; chroma is the
            // photograph's own opinion about hue and is admitted only in
            // proportion to daylight. Passing the raw RGB through instead put
            // blue photographic sky into the dawn ramp's warm horizon — the
            // authored sunrise/sunset ramps must keep owning hue.
            float hLum = dot(hp, vec3(0.2126, 0.7152, 0.0722));
            vec3 hChroma = hp / max(hLum, 1e-4);
            float chromaKeep = 0.12 + 0.5 * smoothstep(0.12, 0.45, sunDir.y);
            vec3 hmod = (hLum / HORIZON_MEAN_LUM) * mix(vec3(1.0), hChroma, chromaKeep);

            // Strength is 0 AT the fog line and ramps in over ~8 degrees, which
            // is what makes the sky/fog join algebraically invisible rather
            // than matched by eye. Night keeps a little less contrast so the
            // clouds read as dark banks rather than daylight cumulus.
            float amt = smoothstep(0.0, 0.15, dir.y) * 0.88 * (1.0 - 0.45 * night);
            vec3 band = horizonCol * mix(vec3(1.0), hmod, amt);

            // The horizon brightens toward the sun's azimuth. This is what
            // makes dawn and dusk feel like they surround you, and it keeps the
            // strip responding to light rather than sitting there unlit.
            vec2 dAz = normalize(vec2(dir.x, dir.z) + 1e-5);
            vec2 sAz = normalize(vec2(sunDir.x, sunDir.z) + 1e-5);
            float toSun = pow(max(dot(dAz, sAz), 0.0), 3.0);
            band = mix(band, band * sunColor * 1.3, 0.32 * toSun * clamp(sunIntensity, 0.0, 1.5));

            col = mix(col, band, bandW);
          }

          // --- Day plate (high sun only; dies before dusk owns the ramp) ---
          // smoothstep starts after dawn (~elev 0.12) and is full by mid-morning,
          // so 0.25 / 0.75 keep the authored sunrise/sunset ramps.
          float dayPhoto = smoothstep(0.12, 0.48, sunDir.y) * (1.0 - night) * hasMap * plates;
          float photoW = dayPhoto * horizonFade;

          if (photoW > 0.001) {
            // Rotate so the photo's bright axis tracks the scene sun.
            vec3 sN = normalize(sunDir);
            float sunAz = atan(sN.z, sN.x);
            vec2 uv = stereoUV(dir, cos(-sunAz), sin(-sunAz));
            // No second, uv-space edge term: plateCoverage already carries the
            // rim, and it does so as a function of elevation alone. Multiplying
            // a per-axis uv fade in on top is exactly what made the rim rotate
            // with the sun's azimuth.
            float w = photoW;

            // skyMap is uploaded as NoColorSpace — bytes are raw sRGB, decode here once.
            vec3 photo = srgbToLinear(texture2D(skyMap, clamp(uv, 0.0, 1.0)).rgb);
            photo *= tint / tintLum;
            // Soft lift from sunColour keeps noon warm without washing the blue.
            photo = mix(photo, photo * sunColor * 1.15, 0.18 * clamp(sunIntensity, 0.0, 1.5));

            col = mix(col, photo, w);
            photoW = w; // sun-scale uses the plate-aware weight below
          }

          // --- Night plate (photographic starfield) ---
          // Cross-fade IN across dusk via SkyState.night (0 at elev≥0, 1 by
          // elev≈-0.31). A wide smoothstep keeps t≈0.75 (sunset, night≈0) on
          // the authored ramp, lets ~0.78 still read warm haze with stars only
          // at the zenith, and reaches full plate by deep night (~0.86+).
          // Day plate already carries (1-night), so the two never fight.
          float nightPhoto = smoothstep(0.08, 0.92, night) * hasNightMap * plates;
          float nightW = 0.0;
          if (nightPhoto * horizonFade > 0.001) {
            // World-fixed (no sun azimuth spin) — stars stay put as the sun sets.
            vec2 uvN = stereoUV(dir, 1.0, 0.0);
            nightW = nightPhoto * horizonFade;

            vec3 np = srgbToLinear(texture2D(nightMap, clamp(uvN, 0.0, 1.0)).rgb);
            // Same tint contract as the day plate so the navy base agrees with
            // authored night colours (daylight sampling is elev-gated elsewhere;
            // this still keeps the dome from fighting the graded top/bottom).
            np *= tint / max(tintLum, 0.04);
            // Mild contrast restore: LinearFilter without mips softens 1px stars;
            // lift the bright tail so points still read without blooming.
            float lum = dot(np, vec3(0.2126, 0.7152, 0.0722));
            np += np * smoothstep(0.04, 0.35, lum) * 0.55;

            col = mix(col, np, nightW);
          }

          // Sun disc + halo. Drawn AFTER the photo so the disc sits on top of
          // photographed clouds (no "sun behind a cloud that was baked in").
          // Intensity falls off a little under the photo so we do not double-up
          // a blown-out white core on an already bright cumulus.
          float cosA = dot(dir, normalize(sunDir));
          float disc = smoothstep(0.9994, 1.0, cosA);
          float halo = pow(max(cosA, 0.0), 26.0);
          float sunScale = mix(1.0, 0.72, photoW);
          col += sunColor * (disc * 2.4 + halo * 0.35) * sunIntensity * sunScale;

          // Procedural starfield — only as fallback when the night plate is
          // absent or still fading in. Fades out against nightW so we never
          // stack two star densities.
          if (night > 0.3 && nightW < 0.95) {
            vec2 suv = vec2(
              atan(dir.z, dir.x) * 3.0,
              acos(clamp(dir.y, -1.0, 1.0)) * 2.0
            );
            float star = step(0.9990, hash(floor(suv * 48.0)));
            float proc = (night - 0.3) * 0.9 * (1.0 - nightW);
            col += vec3(0.75, 0.82, 1.0) * star * proc;
          }

          // custom ShaderMaterial is not auto-gamma-corrected, so encode sRGB
          col = pow(col, vec3(1.0 / 2.2));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
    this.mesh.frustumCulled = false;

    new THREE.TextureLoader().load(
      SKY_URL,
      (tex) => {
        // NoColorSpace: ShaderMaterial does not run three's sRGB sampling path, and an
        // SRGBColorSpace upload would hardware-decode then get pow(2.2)'d again below —
        // that double-decode crushed noon to near-black in verification.
        tex.colorSpace = THREE.NoColorSpace;
        // Clamp both axes: stereographic plate, not a wrap-around panorama.
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = 4;
        this.uniforms.skyMap.value = tex;
        this.uniforms.hasMap.value = 1;
      },
      undefined,
      () => {
        // Missing asset (fresh clone without npm run assets): stay procedural.
        this.uniforms.hasMap.value = 0;
      },
    );

    new THREE.TextureLoader().load(
      NIGHT_SKY_URL,
      (tex) => {
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        // Starfield is high-frequency: mip chains average points to grey by
        // level 3–4 and LOD switches crawl under camera yaw. Prefer a higher
        // base resolution (2048×1024) with NO mipmaps over a twinkling mess.
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 1;
        this.uniforms.nightMap.value = tex;
        this.uniforms.hasNightMap.value = 1;
      },
      undefined,
      () => {
        this.uniforms.hasNightMap.value = 0;
      },
    );

    new THREE.TextureLoader().load(
      HORIZON_URL,
      (tex) => {
        tex.colorSpace = THREE.NoColorSpace;
        // Plain Repeat: the strip is authored seamless by
        // tools/build-sky-horizon.mjs and sampled once around the azimuth, so
        // there is no mirror axis to fold the sky about. ClampToEdge on T
        // because the strip's top and bottom rows are elevation limits, not a
        // tile.
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        // The strip is sampled at a grazing angle across the whole azimuth, so
        // anisotropy is what keeps it from smearing to mush near the skyline.
        tex.anisotropy = 4;
        this.uniforms.horizonMap.value = tex;
        this.uniforms.hasHorizonMap.value = 1;
      },
      undefined,
      () => {
        // Missing asset: the low dome still resolves to the fog colour, so the
        // skyline stays joined — it just loses the photographic cloud banks.
        this.uniforms.hasHorizonMap.value = 0;
      },
    );

    // The plates keep loading and keep their `has*Map` flags whatever classic
    // does, so turning it back off restores the photographic sky exactly.
    this.unsubscribeClassic = onClassicModeChange((on) => {
      this.uniforms.classic.value = on ? 1 : 0;
    });
  }

  /** Drop the classic-mode subscription. */
  dispose(): void {
    this.unsubscribeClassic();
  }

  /**
   * The colour the skyline resolves to. DayNightSystem pushes `scene.fog.color`
   * here every frame AFTER its daylight sample lerp, which is what keeps the
   * sky/fog agreement exact across the whole cycle. Separate from `state`
   * deliberately: `state` is applied before the light probe renders this same
   * material, and the probe must not see a fog-derived colour.
   */
  set horizonColor(c: THREE.Color) {
    this.uniforms.horizonCol.value.copy(c);
  }

  set state(s: SkyState) {
    this.uniforms.top.value.copy(s.top);
    this.uniforms.bottom.value.copy(s.bottom);
    this.uniforms.sunColor.value.copy(s.sunColor);
    this.uniforms.sunDir.value.copy(s.sunDir);
    this.uniforms.sunIntensity.value = s.sunIntensity;
    this.uniforms.night.value = s.night;
  }
}
