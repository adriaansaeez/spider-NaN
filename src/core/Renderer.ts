import * as THREE from 'three';

/** FROZEN-ish: lead-owned. Builders may propose changes via `ask`. */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // retro/low-poly identity + perf; do not "fix" visuals by enabling this
      powerPreference: 'high-performance',
      stencil: false,
      // WHY: the street is a stack of near-coplanar slabs inside the first 12 cm
      // above y = 0 (ground plane 0, street top 0.04, avenue top 0.05, crosswalk
      // 0.10, divider 0.12). With a conventional 24-bit perspective depth buffer
      // the depth resolution at distance z is ~z^2 / (near * 2^24): 4.3 cm at
      // 600 m and 12 cm at 1 km with near = 0.5. Every one of those separations
      // loses, so from a few hundred metres up the depth winner flipped per pixel
      // per frame and the whole street lattice shimmered. Measured, with the
      // camera translated by one TENTH of a screen pixel over a frozen scene:
      // 43.6% of asphalt pixels changed between the two frames from 800 m up,
      // and 11.9% of the whole frame at 600 m. After: 8.6% and 2.7%, and the
      // residual is building-edge aliasing, not the road.
      //
      // Raising `near` cannot fix it: holding 5 mm of resolution at 600 m needs
      // near >= 4.3 m, and at 1200 m near >= 17 m — both would clip the chase
      // camera clean through the player. A logarithmic depth buffer distributes
      // precision by log(z) instead of 1/z and holds sub-millimetre resolution
      // across the whole 0.5-4000 m range, so `near` stays at 0.5 and nothing
      // that used to be visible starts clipping.
      //
      // It is not free — it writes gl_FragDepth, which disables early-Z — so it
      // was measured, not assumed: see docs/critique/evidence/asphalt-flicker/.
      logarithmicDepthBuffer: true,
    });
    this.gl.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.gl.setSize(innerWidth, innerHeight);
    this.gl.info.autoReset = false;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    // Keep the low-poly material language, but give daylight a photographic
    // highlight shoulder instead of hard RGB clipping. Explicit sRGB output
    // also makes the lighting result independent of three.js defaults.
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.35;

    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.5, 4000);
    this.camera.position.set(0, 120, 0);

    addEventListener('resize', this.onResize);
  }

  private onResize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.gl.setSize(innerWidth, innerHeight);
  };

  render() {
    this.gl.info.reset();
    this.gl.render(this.scene, this.camera);
  }

  dispose() {
    removeEventListener('resize', this.onResize);
    this.gl.dispose();
  }
}
