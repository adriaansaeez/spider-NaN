/**
 * Ground surface materials — textured asphalt (roads) and pavement (sidewalks).
 *
 * Wiring (done in CitySystem.ts):
 *   1. Constructor: initGroundTextures() → starts async texture load
 *   2. buildStatics(): groundMaterial() × 2 → ground planes
 *   3. Chunk load: roadMaterial() → road detail InstancedMesh
 *   4. dispose(): call disposeGroundTextures() to free GPU texture memory
 *
 * Albedo model:
 *   The texture IS the albedo. material.color stays white (0xffffff) so
 *   the final surface colour = textureSample × materialColour × light.
 *   For instanced road boxes, instanceColour is also set to [1,1,1] to
 *   avoid the triple-multiply that crushed roads to black.
 *
 * Real-world scale:
 *   Pavement: 13 pavers × 0.2 m = 2.6 m per texture tile
 *   Asphalt:  ~4 m per texture tile (crack network scale)
 *   Ground plane: ~14 000 m wide → texture repeats ~5 400 times (mipmaps handle it)
 *   Road boxes: world-space UVs override texture repeat; one tile = 4 m world scale
 *
 * Road world-space UVs:
 *   Road detail boxes are 1×1×1 BoxGeometry scaled by instance matrix. The
 *   shared asphalt texture has repeat(3500, 4000) sized for the 14 km ground
 *   plane. On a 22 m avenue that gives one tile per 6 mm — sub-pixel, mipped
 *   to flat grey.  The road material uses onBeforeCompile to replace vUv with
 *   world-space XZ / 4 so one texture tile covers exactly 4 m regardless of
 *   instance scale.  Cost: zero geometry, zero draw calls, zero extra memory.
 */
import * as THREE from 'three';
import { isClassicMode, onClassicModeChange } from '../core/ClassicMode';

// ---------------------------------------------------------------------------
// Fallback flat colours (used until textures load, then discarded)
// ---------------------------------------------------------------------------
const FALLBACK_GROUND_COLOR = new THREE.Color(0x1a1c1f);
const FALLBACK_ROAD_COLOR = new THREE.Color(0x121314);

/** Asphalt texture tile size in metres — road world-space UV scaling. */
const ASPHALT_TILE_METRES = 4;

// ---------------------------------------------------------------------------
// Classic mode — the flat, pre-texture ground of the first build
// ---------------------------------------------------------------------------
// The texture is the albedo (see the header), so classic mode is exactly the
// inverse operation: drop the map and put the albedo back in material.color.
// Road boxes carry a WHITE instanceColour (CitySystem writes [1,1,1] for
// D_ROAD_*), so the material colour alone is the road's albedo in both modes.
const CLASSIC_PAVEMENT_COLOR = new THREE.Color(0x3a3f47);
const CLASSIC_ASPHALT_COLOR = new THREE.Color(0x2a2d33);

// ---------------------------------------------------------------------------
// Anisotropic filtering — detect hardware maximum
// ---------------------------------------------------------------------------
function detectMaxAnisotropy(): number {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 1;
    const ext =
      gl.getExtension('EXT_texture_filter_anisotropic') ??
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    if (!ext) return 1;
    const max = gl.getParameter((ext as { MAX_TEXTURE_MAX_ANISOTROPY_EXT: number }).MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
    // Lose the temporary context immediately to free GPU resources.
    const lose = gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null;
    lose?.loseContext?.();
    return max;
  } catch { return 1; }
}

// ---------------------------------------------------------------------------
// Texture loading (async, with missing-file fallback)
// ---------------------------------------------------------------------------
const loader = new THREE.TextureLoader();

function loadGroundTexture(
  url: string,
  repeatX: number,
  repeatY: number,
  anisotropy = 1,
): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeatX, repeatY);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = anisotropy;
        resolve(tex);
      },
      undefined,
      () => resolve(null),
    );
  });
}

// ---------------------------------------------------------------------------
// Texture state + material patching
// ---------------------------------------------------------------------------
let pavementTex: THREE.Texture | null = null;
let asphaltTex: THREE.Texture | null = null;
let materialsReady = false;

/** Materials that need patching when textures arrive. */
const groundMats: THREE.MeshLambertMaterial[] = [];
const roadMats: THREE.MeshLambertMaterial[] = [];

/**
 * EVERY material handed out, textured or not. `groundMats`/`roadMats` above are
 * a one-shot queue — a material created after the texture landed never enters
 * them — so the classic toggle needs its own complete registry to switch both
 * directions. Both lists are small and bounded (two ground planes, one shared
 * road material), so this costs nothing.
 */
const allGroundMats: THREE.MeshLambertMaterial[] = [];
const allRoadMats: THREE.MeshLambertMaterial[] = [];

/** Live classic state; read at module scope so boot and toggle share one path. */
let classicGround = isClassicMode();
let classicSubscribed = false;

/** Flat, untextured retro ground: the map goes away, the colour comes back. */
function applyClassicMat(mat: THREE.MeshLambertMaterial, color: THREE.Color): void {
  mat.map = null;
  mat.color.copy(color);
  mat.needsUpdate = true;
}

/** Undo applyClassicMat: back to texture-as-albedo, or the flat fallback if the
 *  texture never loaded (fresh clone without `npm run assets`). */
function applyTexturedGroundMat(mat: THREE.MeshLambertMaterial): void {
  if (pavementTex) patchGroundMat(mat, pavementTex);
  else { mat.map = null; mat.color.copy(FALLBACK_GROUND_COLOR); mat.needsUpdate = true; }
}

function applyTexturedRoadMat(mat: THREE.MeshLambertMaterial): void {
  if (asphaltTex) patchRoadMat(mat, asphaltTex);
  else { mat.map = null; mat.color.copy(FALLBACK_ROAD_COLOR); mat.needsUpdate = true; }
}

/** Switch every ground/road material between the textured and classic looks. */
function setClassicGround(on: boolean): void {
  classicGround = on;
  for (const m of allGroundMats) {
    if (on) applyClassicMat(m, CLASSIC_PAVEMENT_COLOR);
    else applyTexturedGroundMat(m);
  }
  for (const m of allRoadMats) {
    if (on) applyClassicMat(m, CLASSIC_ASPHALT_COLOR);
    else applyTexturedRoadMat(m);
  }
}

function patchGroundMat(mat: THREE.MeshLambertMaterial, tex: THREE.Texture): void {
  mat.map = tex;
  mat.color.set(0xffffff);
  mat.needsUpdate = true;
}

function patchRoadMat(mat: THREE.MeshLambertMaterial, tex: THREE.Texture): void {
  mat.map = tex;
  mat.color.set(0xffffff);
  mat.needsUpdate = true;
}

/**
 * Apply world-space UV override to a road material via onBeforeCompile.
 *
 * Declares its own varying (vRoadUv) so the override works even when the
 * material is first compiled without a map (textures load async).  When the
 * map is later assigned, the fragment shader samples via vRoadUv — world-space
 * XZ / ASPHALT_TILE_METRES — so one texture tile covers exactly 4 m in world
 * space, regardless of how each instance box is scaled.
 *
 * The ground planes keep their texture-repeat UVs untouched.
 */
function applyRoadWorldUvs(mat: THREE.MeshLambertMaterial): void {
  mat.onBeforeCompile = (shader) => {
    const tile = ASPHALT_TILE_METRES.toFixed(1);
    // Declare the varying at global scope in both shaders.
    // eslint-disable-next-line no-param-reassign
    shader.vertexShader = shader.vertexShader.replace(
      'void main()',
      `varying vec2 vRoadUv;\nvoid main()`,
    );
    // eslint-disable-next-line no-param-reassign
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main()',
      `varying vec2 vRoadUv;\nvoid main()`,
    );
    // Compute world-space UV from the instance-transformed position. This must
    // not rely on Three's worldPosition helper, which is compiled out for some
    // non-shadow material variants.
    // eslint-disable-next-line no-param-reassign
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec4 roadWorldPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
      roadWorldPosition = instanceMatrix * roadWorldPosition;
      #endif
      roadWorldPosition = modelMatrix * roadWorldPosition;
      vRoadUv = roadWorldPosition.xz / ${tile};`,
    );
    // Sample the diffuse map with world-space UVs instead of model-space vUv.
    // eslint-disable-next-line no-param-reassign
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
      vec4 sampledDiffuseColor = texture2D(map, vRoadUv);
      diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
}

/** Kick off texture loading. Materials created via groundMaterial() / roadMaterial()
 *  are automatically patched when textures finish loading. */
export function initGroundTextures(): void {
  if (!classicSubscribed) {
    classicSubscribed = true;
    onClassicModeChange(setClassicGround);
  }
  if (materialsReady) return;

  const aniso = detectMaxAnisotropy();
  if (aniso > 1) console.log(`[ground] anisotropy: ${aniso}`);

  loadGroundTexture('/assets/pavement.webp', 5385, 6154, aniso).then((t) => {
    pavementTex = t;
    if (t) {
      console.log('[ground] pavement texture loaded');
      // Classic mode owns the look while it is on; the texture is kept so the
      // toggle can hand it back.
      if (!classicGround) for (const m of groundMats) patchGroundMat(m, t);
    }
  });

  loadGroundTexture('/assets/asphalt.webp', 3500, 4000, aniso).then((t) => {
    asphaltTex = t;
    if (t) {
      console.log('[ground] asphalt texture loaded');
      if (!classicGround) for (const m of roadMats) patchRoadMat(m, t);
    }
  });

  materialsReady = true;
}

/** Free GPU texture memory. material.dispose() does NOT free its map. */
export function disposeGroundTextures(): void {
  pavementTex?.dispose();
  asphaltTex?.dispose();
  pavementTex = null;
  asphaltTex = null;
  groundMats.length = 0;
  roadMats.length = 0;
  allGroundMats.length = 0;
  allRoadMats.length = 0;
}

// ---------------------------------------------------------------------------
// Material factories
// ---------------------------------------------------------------------------

/** Material for the two large ground planes. Patched automatically when
 *  the pavement texture finishes loading. Texture carries the albedo. */
export function groundMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: FALLBACK_GROUND_COLOR,
    flatShading: true,
  });
  allGroundMats.push(mat);
  // Classic wins over the texture, and stays winning: the material is still
  // queued below, so turning classic off re-patches it from the loaded texture.
  if (classicGround) applyClassicMat(mat, CLASSIC_PAVEMENT_COLOR);
  else if (pavementTex) patchGroundMat(mat, pavementTex);
  if (!pavementTex) groundMats.push(mat);
  return mat;
}

/** Material for road detail boxes (D_ROAD_AV, D_ROAD_ST). Patched
 *  automatically when the asphalt texture finishes loading.
 *  Uses world-space UVs (onBeforeCompile) so one texture tile = 4 m
 *  regardless of how the instance box is scaled. */
export function roadMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: FALLBACK_ROAD_COLOR,
    flatShading: true,
  });
  applyRoadWorldUvs(mat);
  allRoadMats.push(mat);
  if (classicGround) applyClassicMat(mat, CLASSIC_ASPHALT_COLOR);
  else if (asphaltTex) patchRoadMat(mat, asphaltTex);
  if (!asphaltTex) roadMats.push(mat);
  return mat;
}
