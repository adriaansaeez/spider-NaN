/**
 * OWNED BY: city-builder.
 *
 * Pure, deterministic procedural city generation. Every function here is a pure
 * function of (integer coords, seed) — no Math.random(), no global state, no
 * dependence on load order. `genChunk` returns the same data for the same
 * (ci, cj, seed) on every call, so streamed chunks regenerate byte-identically.
 *
 * The street model is a jittered Manhattan grid: avenues run north-south (along Z)
 * with a per-avenue deterministic jitter, streets run east-west (along X) with a
 * per-street jitter. That keeps avenues long and straight (good swing corridors)
 * while making every block a slightly different size.
 *
 * Heights come from a smooth district field: a radial "midtown core" falloff
 * blended with low-frequency value noise, so there is a dense tower cluster near
 * the spawn and low-rise outskirts further out.
 */
import { hashCoords, makeRng } from '../contracts';
import { CITY_TUNING as C } from './tuning';
import type { BuildingArchetype } from './BuildingRegistry';

export type Vec3 = [number, number, number];

/** A building's stacked setback boxes, bottom to top (base footprint = first). */
export interface Tier { baseY: number; topY: number; hw: number; hd: number; }
/** A box instance in the building mesh (roof slabs, AC units, water towers, antennas). Full sizes. */
export interface ExtraBox { x: number; y: number; z: number; w: number; h: number; d: number; color: Vec3; lod: 0 | 1 | 2; }
/** A lit window band on a facade. Full sizes; y is the band's bottom. */
export interface WindowBand { x: number; y: number; z: number; w: number; h: number; d: number; color: Vec3; lod: 0 | 1; }
/** One instanced street-level box (roads, lights, trees, cars, crosswalks). Full sizes. */
export interface DetailItem { kind: number; x: number; y: number; z: number; w: number; h: number; d: number; color: Vec3; }
/** Distant silhouette box for a building. hw/hd are half extents, h is height. */
export interface ImpostorBox { x: number; z: number; hw: number; hd: number; h: number; color: Vec3; }

export type AnchorKind = 'wall' | 'roof' | 'corner';

export interface AnchorCandidate {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  kind: AnchorKind;
  idOffset: number;
}

export interface FacadeProfile {
  atlasFamily: 'apartment' | 'curtain-wall' | 'storefront' | 'service' | 'stone-civic';
  rhythm: 'vertical-bays' | 'curtain-grid' | 'wide-panels' | 'punched-stone';
  bayWidth: number;
  floorHeight: number;
  litRatio: number;
  coolRatio: number;
  streetBand: boolean;
}

export interface BuildingData {
  cx: number; cz: number; hw: number; hd: number; height: number;
  color: Vec3;
  archetype: BuildingArchetype;
  facade: FacadeProfile;
  tiers: Tier[];
  extras: ExtraBox[];
  anchors: AnchorCandidate[];
  structureId: number;
  idBase: number;
  /** Index of this building's first window band in ChunkGen.windows. */
  winStart: number;
  /** How many window bands it owns (0 when `lite`). */
  winCount: number;
  /** runtime: spatial-hash cells this building is registered into (for removal). */
  cells: number[];
  /** runtime: per-query dedupe stamp. */
  stamp: number;
}

export interface ChunkGen {
  ci: number; cj: number;
  i0: number; j0: number;
  x0: number; x1: number; z0: number; z1: number;
  buildings: BuildingData[];
  windows: WindowBand[];
  detail: DetailItem[];
  impostor: ImpostorBox[];
}

// detail item kinds
export const D_ROAD_AV = 0;
export const D_ROAD_ST = 1;
export const D_LIGHT_POLE = 2;
export const D_LIGHT_HEAD = 3;
export const D_TREE_TRUNK = 4;
export const D_TREE_CANOPY = 5;
export const D_CAR = 6;
export const D_CROSSWALK = 7;
export const D_DIVIDER = 8;

const SEED_SALT = 0x7f4a7c15;

/**
 * Low-rise palette. The buildings-visual critic named this "the best thing in
 * the build" — saturated, distinct, unmistakably retro — so it is unchanged.
 */
const FACADE_LOW: Vec3[] = [
  [0.55, 0.57, 0.60], [0.60, 0.63, 0.66], [0.47, 0.50, 0.54],
  [0.66, 0.68, 0.70], [0.42, 0.45, 0.49], [0.70, 0.65, 0.57],
  [0.74, 0.68, 0.57], [0.62, 0.54, 0.44], [0.36, 0.43, 0.53],
  [0.30, 0.36, 0.45], [0.42, 0.49, 0.55], [0.80, 0.72, 0.56],
  [0.59, 0.52, 0.45], [0.50, 0.52, 0.55],
];

/**
 * Tower palette — the same retro language carried upward.
 *
 * The towers used to draw from FACADE_LOW too, yet read as a near-monochrome
 * grey/white field. The reason is VALUE, not hue: a tower presents a large
 * unbroken sunlit face, and at ~0.6-0.8 albedo under the daylight sun ACES
 * compresses it to white, so whatever hue it had stops being visible. These sit
 * at 0.26-0.58 with a deliberate warm/cool axis (brick and ochre against slate
 * and teal, as in reference-pack/frames/sequence_01/001_perch.png), which keeps
 * the sunlit face inside the tonemapper's range and lets the hue survive.
 */
const FACADE_TOWER: Vec3[] = [
  // warm side — brick, terracotta, ochre, sandstone
  [0.52, 0.36, 0.29], [0.58, 0.44, 0.33], [0.47, 0.38, 0.30],
  [0.56, 0.49, 0.38], [0.44, 0.31, 0.26], [0.50, 0.43, 0.34],
  // cool side — slate, steel, teal
  [0.31, 0.38, 0.45], [0.35, 0.44, 0.46], [0.26, 0.33, 0.40],
  [0.38, 0.45, 0.44], [0.30, 0.40, 0.38], [0.42, 0.47, 0.51],
  // neutrals that keep a few pale towers in the mix for contrast
  [0.55, 0.55, 0.54], [0.46, 0.44, 0.42],
];

/** Above this height a building draws from FACADE_TOWER. ~17 storeys. */
const TOWER_COLOR_HEIGHT = 60;

export const CAR_COLORS: Vec3[] = [
  [1.0, 0.83, 0.14], [0.92, 0.92, 0.95], [0.16, 0.17, 0.20],
  [0.78, 0.16, 0.15], [0.16, 0.36, 0.62], [0.62, 0.64, 0.68],
];

const TREE_GREEN: Vec3[] = [
  [0.24, 0.42, 0.21], [0.30, 0.47, 0.24], [0.26, 0.40, 0.28],
];
const TRUNK: Vec3 = [0.30, 0.22, 0.14];

// ---------------------------------------------------------------------------
// street grid
// ---------------------------------------------------------------------------

/** World X of avenue index i. Pure function of i — avenues stay long + straight. */
export function avenueX(i: number, seed: number): number {
  const r = hashCoords(i, -9871, seed) / 4294967296;
  return i * C.avenueSpacing + (r - 0.5) * 2 * C.avenueJitter;
}

/** World Z of street index j. Pure function of j. */
export function streetZ(j: number, seed: number): number {
  const r = hashCoords(-7717, j, seed) / 4294967296;
  return j * C.streetSpacing + (r - 0.5) * 2 * C.streetJitter;
}

// ---------------------------------------------------------------------------
// district field
// ---------------------------------------------------------------------------

function smooth(t: number): number { return t * t * (3 - 2 * t); }

/** Smooth value noise on a coarse grid — deterministic district blobs. */
function valueNoise2D(x: number, z: number, cell: number, seed: number): number {
  const xi = Math.floor(x / cell);
  const zi = Math.floor(z / cell);
  const fx = x / cell - xi;
  const fz = z / cell - zi;
  const sx = smooth(fx);
  const sz = smooth(fz);
  const a = hashCoords(xi, zi, seed) / 4294967296;
  const b = hashCoords(xi + 1, zi, seed) / 4294967296;
  const c = hashCoords(xi, zi + 1, seed) / 4294967296;
  const d = hashCoords(xi + 1, zi + 1, seed) / 4294967296;
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** 0..1 urban intensity: midtown core falloff blended with district noise. */
function zoneAt(x: number, z: number, seed: number): number {
  const dx = x - C.coreX;
  const dz = z - C.coreZ;
  const core = Math.exp(-(dx * dx + dz * dz) / (C.coreRadius * C.coreRadius));
  const noise = valueNoise2D(x, z, C.districtCell, seed);
  return Math.max(core, noise * 0.55);
}

// ---------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------

function jitterColor(rng: () => number, base: Vec3): Vec3 {
  return [
    base[0] + (rng() - 0.5) * 0.1,
    base[1] + (rng() - 0.5) * 0.1,
    base[2] + (rng() - 0.5) * 0.1,
  ];
}

function facadeColor(rng: () => number, height: number): Vec3 {
  const table = height > TOWER_COLOR_HEIGHT ? FACADE_TOWER : FACADE_LOW;
  return jitterColor(rng, table[Math.floor(rng() * table.length)]);
}

export function carColor(rng: () => number): Vec3 {
  return CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)];
}

function treeColor(rng: () => number): Vec3 {
  return TREE_GREEN[Math.floor(rng() * TREE_GREEN.length)];
}

function darken(c: Vec3, f: number): Vec3 {
  return [c[0] * f, c[1] * f, c[2] * f];
}

// ---------------------------------------------------------------------------
// buildings
// ---------------------------------------------------------------------------

/**
 * Storey count for a building, drawn from a height-class distribution that
 * blends from low-rise outskirts toward a dense tall/landmark core. Matches the
 * VISUAL_SPEC height bins (2-5 / 6-14 / 15-35 / 36-70 storeys).
 */
function storeysFor(
  cx: number, cz: number, rng: () => number, seed: number, scale: number, archetype: BuildingArchetype,
): number {
  const s = zoneAt(cx, cz, seed);
  const civic = archetype === 'civic-institutional';
  const service = archetype === 'low-rise-service';
  const office = archetype === 'office-commercial';
  const wLow = service ? 0.68 : civic ? 0.28 : 0.38 * (1 - s) + 0.20 * s;
  const wMid = service ? 0.28 : civic ? 0.54 : 0.46 * (1 - s) + 0.40 * s;
  const wTall = service ? 0.04 : civic ? 0.15 : office ? 0.12 * (1 - s) + 0.34 * s : 0.12 * (1 - s) + 0.28 * s;
  const wLand = service ? 0 : civic ? 0.03 : office ? 0.04 * (1 - s) + 0.13 * s : 0.04 * (1 - s) + 0.08 * s;
  const r = rng() * (wLow + wMid + wTall + wLand);
  let storeys: number;
  // Every bin raised 25% (owner's call: low buildings hurt the swing loop, and
  // raising heights is preferred to retuning the balance). Math.floor(rng() * N)
  // consumes ONE draw whatever N is, so widening the spans does not shift the rng
  // stream and the city stays deterministic.
  if (r < wLow) storeys = C.minStoreys + Math.floor(rng() * 5);   // 20-24
  else if (r < wLow + wMid) storeys = 8 + Math.floor(rng() * 11);   // 8-18
  else if (r < wLow + wMid + wTall) storeys = 19 + Math.floor(rng() * 26); // 19-44
  else storeys = 45 + Math.floor(rng() * 44);                    // 45-88 landmark
  const cap = service ? C.serviceMaxStoreys : civic ? 30 : C.landmarkMaxStoreys;
  // The floor is applied AFTER `scale`, not just to the bin: `heightScale` runs
  // as low as 0.8, which took a 4-storey draw back down to 3 (10.5 m) and put the
  // building under the traversal minimum again. Clamping the bin alone would have
  // left the dead zones exactly where they were.
  storeys = Math.max(C.minStoreys, Math.min(Math.round(storeys * scale), cap));
  return storeys * C.storeyHeight;
}

/** Setback tiers: tall towers step in, giving the classic tiered skyline. */
function tiersFor(h: number, hw: number, hd: number, rng: () => number, archetype: BuildingArchetype): Tier[] {
  const storey = C.storeyHeight;
  const snap = (v: number) => Math.max(storey * 2, Math.round(v / storey) * storey);
  if (archetype === 'low-rise-service') {
    const top = h > 22 && rng() < 0.55
      ? { baseY: snap(h * 0.62), topY: h, hw: hw * (0.56 + rng() * 0.12), hd: hd * (0.58 + rng() * 0.12) }
      : null;
    return top ? [{ baseY: 0, topY: top.baseY, hw, hd }, top] : [{ baseY: 0, topY: h, hw, hd }];
  }
  if (archetype === 'civic-institutional') {
    if (h > 70) {
      const shoulder = snap(h * 0.5);
      const upper = snap(h * 0.78);
      return [
        { baseY: 0, topY: shoulder, hw, hd },
        { baseY: shoulder, topY: upper, hw: hw * 0.86, hd: hd * 0.86 },
        { baseY: upper, topY: h, hw: hw * 0.68, hd: hd * 0.68 },
      ];
    }
    if (h > 32) {
      const crown = snap(h * 0.78);
      return [
        { baseY: 0, topY: crown, hw, hd },
        { baseY: crown, topY: h, hw: hw * 0.88, hd: hd * 0.88 },
      ];
    }
    return [{ baseY: 0, topY: h, hw, hd }];
  }
  if (h > 110) {
    const module = Math.max(storey * 7, snap(24.5 + rng() * 14));
    const y1 = snap(Math.min(h * 0.48, module * Math.max(2, Math.floor(h * 0.48 / module))));
    const y2 = snap(Math.min(h * 0.72, y1 + module * Math.max(1, Math.floor((h * 0.24) / module))));
    const y3 = snap(Math.min(h * 0.88, y2 + module));
    return [
      { baseY: 0, topY: y1, hw, hd },
      { baseY: y1, topY: y2, hw: hw * 0.84, hd: hd * 0.84 },
      { baseY: y2, topY: y3, hw: hw * 0.7, hd: hd * 0.7 },
      { baseY: y3, topY: h, hw: hw * 0.56, hd: hd * 0.56 },
    ];
  }
  if (h > 55) {
    const y1 = snap(h * (0.62 + rng() * 0.1));
    const y2 = snap(h * (0.84 + rng() * 0.04));
    return [
      { baseY: 0, topY: y1, hw, hd },
      { baseY: y1, topY: y2, hw: hw * 0.84, hd: hd * 0.84 },
      { baseY: y2, topY: h, hw: hw * 0.68, hd: hd * 0.68 },
    ];
  }
  if (h > 25) {
    const y = snap(h * (0.70 + rng() * 0.12));
    return [
      { baseY: 0, topY: y, hw, hd },
      { baseY: y, topY: h, hw: hw * 0.82, hd: hd * 0.82 },
    ];
  }
  return [{ baseY: 0, topY: h, hw, hd }];
}

function archetypeFor(cx: number, cz: number, hw: number, hd: number, rng: () => number, seed: number): BuildingArchetype {
  const zone = zoneAt(cx, cz, seed);
  const aspect = Math.max(hw, hd) / Math.max(Math.min(hw, hd), 1e-4);
  const civicField = valueNoise2D(cx + 1700, cz - 900, 520, seed ^ 0x5c1a712f);
  const r = rng();
  if (civicField > 0.72 && zone > 0.32 && r < 0.42) return 'civic-institutional';
  if (aspect > 1.75 && r < 0.62) return 'low-rise-service';
  if (zone > 0.58 && r < 0.68) return 'office-commercial';
  if (r < 0.17 && zone < 0.48) return 'low-rise-service';
  return 'residential-mixed-use';
}

function facadeFor(archetype: BuildingArchetype, rng: () => number): FacadeProfile {
  if (archetype === 'office-commercial') {
    return {
      atlasFamily: 'curtain-wall', rhythm: rng() < 0.65 ? 'curtain-grid' : 'vertical-bays',
      bayWidth: 3.6 + rng() * 2.4, floorHeight: C.storeyHeight,
      litRatio: 0.22 + rng() * 0.18, coolRatio: 0.42 + rng() * 0.36, streetBand: rng() < 0.55,
    };
  }
  if (archetype === 'low-rise-service') {
    return {
      atlasFamily: rng() < 0.45 ? 'storefront' : 'service', rhythm: 'wide-panels',
      bayWidth: 5.5 + rng() * 3.5, floorHeight: C.storeyHeight * (1.05 + rng() * 0.25),
      litRatio: 0.10 + rng() * 0.12, coolRatio: 0.20 + rng() * 0.25, streetBand: true,
    };
  }
  if (archetype === 'civic-institutional') {
    return {
      atlasFamily: 'stone-civic', rhythm: 'punched-stone',
      bayWidth: 4.5 + rng() * 2.0, floorHeight: C.storeyHeight * 1.18,
      litRatio: 0.12 + rng() * 0.12, coolRatio: 0.10 + rng() * 0.18, streetBand: rng() < 0.35,
    };
  }
  return {
    atlasFamily: 'apartment', rhythm: rng() < 0.78 ? 'vertical-bays' : 'curtain-grid',
    bayWidth: 2.8 + rng() * 1.8, floorHeight: C.storeyHeight,
    litRatio: 0.18 + rng() * 0.20, coolRatio: 0.20 + rng() * 0.26, streetBand: rng() < 0.6,
  };
}

// ---------------------------------------------------------------------------
// facades
// ---------------------------------------------------------------------------

/**
 * Standoff between a band and its wall. The old value was 0.6 m with a 0.8 m
 * deep box, so a band protruded ~1 m and visibly floated clear of the facade —
 * on the tower behind, it hung detached in open sky. 8 cm reads as flush while
 * still clearing the depth buffer at skyline range.
 */
const BAND_INSET = 0.08;

/**
 * COUPLING — the shared window material lives in CitySystem.ts, which this
 * builder does not own.
 *
 * That material is `color: 0x4a4a4a` (linear 0.0684) and three.js multiplies it
 * by the per-instance colour for the DIFFUSE term only. Unlit in daylight that
 * put every band at ~0.07 linear against ~0.5 facades — the near-black gashes
 * the critic saw. Per-instance colours are therefore divided by this constant,
 * so the numbers written below are the LINEAR ALBEDO a band actually presents.
 * If that material's base colour changes, this constant must change with it, or
 * every band in the city scales by the difference.
 */
const WINDOW_MAT_ALBEDO = 0.0684;

  /**
   * Above this height a building's unlit bands can be ExtraBoxes rather than
   * window mesh entries. The distinction keeps the night skyline from going
   * candy-striped — the emissive material is shared and has a single intensity,
   * so every band in the window mesh lights up.
   */
const REVEAL_AS_EXTRA_HEIGHT = 90;

/**
 * Hard cap on band rows per building, so the tallest landmark stays bounded.
 *
 * MUST stay above (tallest building / band step) or the top of a landmark loses
 * its windows and reads as the blank-facade bug fa2ed9a fixed: rows accumulate
 * from the ground up ACROSS tiers, so exhausting the budget leaves the TOP bare.
 * At 88 storeys the tallest tower is 308 m and a curtain-grid step is
 * 2 floors x 3.5 m = 7 m, i.e. 44 rows; 40 would have left the top 28 m blank.
 * 50 covers 350 m.
 */
const MAX_BANDS = 50;

/** Hard cap on windows across one face, the horizontal twin of MAX_BANDS. A 46 m
 *  face at a 2.8 m residential bay wants 16; past ~14 the extra mullions are
 *  thinner than the gap between them at any distance you actually see them. */
const MAX_BAYS = 14;

/** Narrowest face that still gets divided. Below this a single pier would leave
 *  two slits rather than two windows, so the face keeps one full-width opening. */
const MIN_GRIDDABLE_FACE = 5.5;

/** Bays per face for every tier: [alongX, alongZ]. Windows per face = bays. */
function planWindowGrid(b: BuildingData): Array<[number, number]> {
  const bay = Math.max(2.2, b.facade.bayWidth);
  // A face gets at least two windows as soon as it is wide enough to hold two,
  // even when its bay width says otherwise. Rounding down instead cost the
  // narrow faces of every slab tower their piers — a 12.6 m deep, 119 m tall
  // office block at a 5.6 m bay took floor(2.25) = 2 bays on its wide faces and
  // floor(1.9) = 1 on the narrow ones above the first setback, so one face pair
  // kept full-width ribbons all the way up (.scratch/win-grid/crop_med2.png).
  const bays = (face: number) =>
    Math.max(face >= MIN_GRIDDABLE_FACE ? 2 : 1, Math.min(MAX_BAYS, Math.round(face / bay)));
  const plan: Array<[number, number]> = b.tiers.map((t) => [bays(t.hw * 2), bays(t.hd * 2)]);
  let want = 0;
  for (const [nx, nz] of plan) want += nx - 1 + (nz - 1);
  if (want <= C.windowGridMaxPiers) return plan;
  // Over the cap: coarsen the whole building EVENLY rather than spending the
  // budget on the first tier and leaving the rest as bare ribbons. A tower with
  // fewer, wider windows still reads as a grid; a tower whose upper half or
  // whose side faces lost their piers reads as the bug this replaced.
  const s = C.windowGridMaxPiers / want;
  return plan.map(([nx, nz]) => [
    Math.max(1, Math.round((nx - 1) * s) + 1),
    Math.max(1, Math.round((nz - 1) * s) + 1),
  ]);
}

/**
 * Vertical wall piers that cut the bands into discrete rectangular windows.
 *
 * A band is one collar box wrapping all four faces of a tier — cheap, follows the
 * setbacks, but it reads as a panoramic ribbon rather than as windows. The fix is
 * NOT one box per window: a 40 m tower at bayWidth 3.6 is ~11 windows a face,
 * ~44 a row, and up to MAX_BANDS rows — ~1700 boxes where the band uses 40, which
 * is millions of triangles across the city against a 900k budget.
 *
 * Instead a pier is a thin box that spans the tier vertically and the WHOLE
 * building horizontally on one axis, standing `windowPierStandoff` proud so it
 * sits in front of the bands. Its long faces are buried inside the building; only
 * its two end caps show, as a vertical strip of wall on the two opposite facades.
 * So a single instance cuts every row on two faces at once, and the grid costs
 * (baysX - 1) + (baysZ - 1) instances per tier instead of rows x bays x 4.
 *
 * What is left between two piers and two bands IS the window: a rectangle on the
 * bay pitch horizontally and the floor pitch vertically.
 *
 * Piers are lod 0 — never distance-culled. That is not a budget concession: a
 * culled extra is written as a ZERO-SCALE instance rather than dropped, so its
 * triangles are already paid for either way and the LOD tier only buys
 * rasterisation. At lod 1 the grid collapsed back into ribbons the moment a tower
 * crossed 480 m, which is the exact defect this replaces, and it was visible on
 * a 101 m tower at 500 m (.scratch/win-grid/lodpop/d500.png against
 * d500_lod0.png). Thin bars at 500 m cost a few pixels; the pop cost the read.
 */
function addWindowPiers(b: BuildingData, t: Tier, yBottom: number, yTop: number, nx: number, nz: number): void {
  const h = yTop - yBottom;
  if (h <= 0) return;
  const bay = Math.max(2.2, b.facade.bayWidth);
  const pierW = Math.min(C.windowPierMaxWidth, Math.max(C.windowPierMinWidth, bay * C.windowPierFraction));
  // Wall colour, a shade down: the pier IS the wall showing between two windows,
  // so it must read as a value step off the facade, never as a dark bar.
  const color: Vec3 = [b.color[0] * 0.94, b.color[1] * 0.94, b.color[2] * 0.96];
  const w = t.hw * 2;
  const d = t.hd * 2;

  // piers running across the depth: visible on the two faces normal to X
  for (let k = 1; k < nz; k++) {
    const z = b.cz - t.hd + (d * k) / nz;
    b.extras.push({
      x: b.cx, y: yBottom, z, w: w + C.windowPierStandoff * 2, h, d: pierW, color, lod: 0,
    });
  }
  // piers running across the width: visible on the two faces normal to Z
  for (let k = 1; k < nx; k++) {
    const x = b.cx - t.hw + (w * k) / nx;
    b.extras.push({
      x, y: yBottom, z: b.cz, w: pierW, h, d: d + C.windowPierStandoff * 2, color, lod: 0,
    });
  }
}

/** Vertical pitch (in floors) and band height (as a fraction of a floor) per
 *  rhythm — this is what makes `facade.rhythm` finally visible on screen. */
function bandRhythm(f: FacadeProfile): { pitch: number; heightFrac: number } {
  if (f.rhythm === 'curtain-grid') return { pitch: 2, heightFrac: 0.48 };
  if (f.rhythm === 'vertical-bays') return { pitch: 2, heightFrac: 0.36 };
  if (f.rhythm === 'punched-stone') return { pitch: 3, heightFrac: 0.28 };
  return { pitch: 2, heightFrac: 0.34 }; // wide-panels
}

/** Glass albedo for a band, as a value step off its own wall rather than a hole. */
function bandAlbedo(wall: Vec3, cool: boolean): Vec3 {
  // glass sits just under its own wall's value — a step, not a void
  const v = 0.86;
  const warmR = cool ? 0.88 : 1.06;
  const coolB = cool ? 1.18 : 0.94;
  return [
    (wall[0] * v * warmR) / WINDOW_MAT_ALBEDO,
    (wall[1] * v) / WINDOW_MAT_ALBEDO,
    (wall[2] * v * coolB) / WINDOW_MAT_ALBEDO,
  ];
}

/**
 * Horizontal ribbon windows on a regular floor pitch, wrapping every face.
 *
 * Three defects are addressed together (BUILDINGS_VISUAL criteria 3-8):
 *
 *  - COUNT. Band count used to be `min(7, h / (floorHeight*6)) * litRatio * 1.8`,
 *    which capped the whole city at 6: a ~48-storey tower carried four bars and
 *    an 11-floor building 1.3. Rows are now `tierHeight / (pitch * floorHeight)`,
 *    so a 48-storey tower carries ~24 and reads as a tall building.
 *  - PLACEMENT. Bands used to pick a random floor and one random face of four,
 *    so with 1-6 bands whole faces were routinely blank — which is why a 108 m
 *    tower filled the frame as one flat grey rectangle. A band is now a single
 *    collar box on a regular pitch, 8 cm proud of the tier it belongs to, so it
 *    wraps all four faces at once. That is also 4x cheaper than four per-face
 *    boxes, and it follows the setbacks instead of floating past them.
 *  - DAYLIGHT VALUE. See `bandAlbedo` / `WINDOW_MAT_ALBEDO`.
 *
 * The collar is the horizontal half of a window. `addWindowPiers` supplies the
 * vertical half on top of it, so what the player sees is a grid of rectangular
 * openings rather than the panoramic ribbon the collar alone produced.
 */
function addWindows(g: ChunkGen, b: BuildingData, rng: () => number, lite: boolean): void {
  if (lite) return;
  const f = b.facade;
  const { pitch, heightFrac } = bandRhythm(f);
  // A 2-5 storey building has no room for a 2-floor pitch once the ground floor
  // and the parapet clearance are taken out — it was getting 0.52 bands, i.e.
  // most of them none at all. Short buildings get a band per floor instead.
  const pitchFloors = b.height < 45 ? Math.max(1, pitch - 1) : pitch;
  const step = Math.max(2.2, pitchFloors * f.floorHeight);
  const bandH = Math.max(0.9, f.floorHeight * heightFrac);
  // EVERY building carries a band on EVERY row of every tier. Which MESH the row
  // lands in is the only thing height changes:
  //
  //  - a LIT row goes to the shared emissive window mesh and glows at night;
  //  - an UNLIT row goes to `extras` as a dark reveal box, which never glows.
  //
  // Coverage is therefore total and independent of `litChance`, which is what
  // fixes the defect this replaces. Previously only buildings above 90 m emitted
  // reveals; at or below 90 m a row that lost the `litChance` roll emitted
  // NOTHING, so 45% of rows were bare wall, independently per row. Independent
  // misses cluster into runs: measured over 3965 buildings, the p99 building had
  // a 45.5 m uninterrupted blank stretch and the worst a 63 m civic block with a
  // single band on it — "algunos edificios ... sin ventanas". 100% of offenders
  // were at or below 90 m; the row cap and the per-tier band window were both
  // measured and cleared (.scratch/win-gaps/).
  //
  // Lit fraction still steps at REVEAL_AS_EXTRA_HEIGHT, and deliberately: it is
  // what keeps a tower's night facade sparse. Sub-90 m stays at the value it has
  // always had, so this change adds no glowing bands anywhere — it only fills the
  // gaps between them with reveals, and the night skyline is unchanged.
  const revealAsExtra = b.height > REVEAL_AS_EXTRA_HEIGHT;
  const litChance = revealAsExtra ? Math.min(0.36, f.litRatio * 1.15) : 0.55;
  const reveal: Vec3 = [b.color[0] * 0.56, b.color[1] * 0.59, b.color[2] * 0.66];

  // Piers are what turn the bands into a grid of windows.
  //
  // The old gate also required `revealAsExtra`, on the grounds that a short
  // building's extras "would float off the facade geometry" — that was true when
  // short buildings could be swapped for authored GLB meshes. That building set
  // has since been retired (CitySystem.setBuildingMode is a no-op returning
  // 'boxes'), so every building in the city is now the procedural box the piers
  // were measured against, and the objection no longer applies. Piers are lod 0,
  // and applyDetailLod's floor is lod 0, so they are never distance-culled at any
  // height either. The gate is now purely `windowGridMinHeight`.
  const grid = b.height > C.windowGridMinHeight ? planWindowGrid(b) : null;

  let rows = 0;
  for (let ti = 0; ti < b.tiers.length && rows < MAX_BANDS; ti++) {
    const t = b.tiers[ti];
    // start clear of the ground floor / the setback shoulder, and stop clear of
    // the roof cap so a band never collides with the parapet
    const start = t.baseY + f.floorHeight * (ti === 0 ? 1.1 : 0.8);
    const ceiling = t.topY - bandH - 0.6;
    const w = t.hw * 2 + BAND_INSET * 2;
    const d = t.hd * 2 + BAND_INSET * 2;
    let first = -1;
    let last = -1;
    for (let y = start; y <= ceiling && rows < MAX_BANDS; y += step) {
      rows++;
      if (first < 0) first = y;
      last = y;
      if (rng() >= litChance) {
        b.extras.push({ x: b.cx, y, z: b.cz, w, h: bandH, d, color: reveal, lod: 0 });
        continue;
      }
      const cool = rng() < f.coolRatio;
      g.windows.push({ x: b.cx, y, z: b.cz, w, h: bandH, d, color: bandAlbedo(b.color, cool), lod: 0 });
    }
    // The pier field covers exactly the band field of this tier — never lower
    // than the first row, never above the last one, so it cannot reach the
    // parapet or run past a setback shoulder onto open sky.
    if (grid && first >= 0) addWindowPiers(b, t, first, last + bandH, grid[ti][0], grid[ti][1]);
  }

  // street-level shopfront: still a single wide opening on the front face, which
  // is what gives the pavement its life. Only the standoff changes.
  if (f.streetBand && b.height > 10 && rng() < 0.72) {
    const shopW = Math.max(4, Math.min(b.hw * 1.4, f.bayWidth * (1.1 + rng())));
    g.windows.push({
      x: b.cx + (rng() - 0.5) * b.hw * 0.9, y: 2.2, z: b.cz - b.hd - BAND_INSET,
      w: shopW, h: 2.8, d: 0.2,
      color: bandAlbedo(b.color, rng() < f.coolRatio),
      lod: 0,
    });
  }

  addRoofLights(g, b, rng);
}

function addRooftopKit(extras: ExtraBox[], b: Omit<BuildingData, 'extras' | 'anchors'>, rng: () => number): void {
  const color = b.color;
  const top = b.tiers[b.tiers.length - 1];
  const y = top.topY;
  const roof = darken(color, b.archetype === 'civic-institutional' ? 0.62 : 0.72);
  const cap = b.archetype === 'civic-institutional' ? 1.8 : 1.15;
  extras.push({ x: b.cx, y, z: b.cz, w: top.hw * 2 * 1.04, h: cap, d: top.hd * 2 * 1.04, color: roof, lod: 0 });
  const parapetH = b.archetype === 'civic-institutional' ? 2.4 : 1.25 + rng() * 0.8;
  const parapetT = 0.8 + rng() * 0.45;
  extras.push({ x: b.cx, y: y + cap, z: b.cz + top.hd, w: top.hw * 2 + parapetT, h: parapetH, d: parapetT, color: darken(color, 0.58), lod: 0 });
  extras.push({ x: b.cx, y: y + cap, z: b.cz - top.hd, w: top.hw * 2 + parapetT, h: parapetH, d: parapetT, color: darken(color, 0.58), lod: 0 });
  extras.push({ x: b.cx + top.hw, y: y + cap, z: b.cz, w: parapetT, h: parapetH, d: top.hd * 2 + parapetT, color: darken(color, 0.58), lod: 0 });
  extras.push({ x: b.cx - top.hw, y: y + cap, z: b.cz, w: parapetT, h: parapetH, d: top.hd * 2 + parapetT, color: darken(color, 0.58), lod: 0 });
  const deckY = y + cap;
  // Roof clutter used to be flat at 8-9 pieces regardless of height: a 210 m
  // office tower and a 10 m shop got the same amount of stuff, so the hero
  // tower's roof was a parapet ring plus two grey boxes. Rooftops are the
  // surface the player perches on, so the tall ones should be the busiest.
  const tall = b.height > 90;
  const mid = b.height > 45;

  // MECHANICAL PENTHOUSE — a raised deck over part of the footprint. This is
  // roof *level* rather than roof *props*: it gives the crown a silhouette from
  // alongside, not just clutter seen from above.
  let penthouseTop = deckY;
  if (top.hw > 4 && top.hd > 4 && (tall || rng() < 0.82)) {
    const pw = Math.min(tall ? 16 : 7.5, top.hw * 2 * (tall ? 0.34 + rng() * 0.18 : 0.45 + rng() * 0.22));
    const pd = Math.min(tall ? 14 : 6.5, top.hd * 2 * (tall ? 0.32 + rng() * 0.18 : 0.40 + rng() * 0.22));
    const ph = tall ? 5.0 + rng() * 4.5 : 3.4 + rng() * 3.2;
    const px = b.cx + (rng() - 0.5) * Math.max(0, top.hw * 2 - pw) * 0.75;
    const pz = b.cz + (rng() - 0.5) * Math.max(0, top.hd * 2 - pd) * 0.75;
    extras.push({ x: px, y: deckY + 0.2, z: pz, w: pw, h: ph, d: pd, color: darken(color, 0.50), lod: tall ? 0 : 1 });
    penthouseTop = deckY + 0.2 + ph;
    if (tall) {
      // lift overrun riding the penthouse — the tallest occupied point
      extras.push({
        x: px, y: penthouseTop, z: pz, w: pw * 0.46, h: 2.6 + rng() * 2.4, d: pd * 0.52,
        color: darken(color, 0.42), lod: 1,
      });
    }
  }

  // COOLING PLANT — scales with roof area and height class instead of being flat
  const roofArea = top.hw * 2 * top.hd * 2;
  const density = b.archetype === 'low-rise-service' ? 5.5 : tall ? 13 : mid ? 8 : 6;
  const hvacCount = Math.max(2, Math.min(12, Math.round((roofArea / 1000) * density)));
  for (let i = 0; i < hvacCount; i++) {
    extras.push({
      x: b.cx + (rng() - 0.5) * top.hw * 1.5, y: deckY + 0.1, z: b.cz + (rng() - 0.5) * top.hd * 1.5,
      w: 2.0 + rng() * 3.4, h: 1.0 + rng() * (tall ? 2.6 : 1.6), d: 1.8 + rng() * 3.1,
      color: [0.34 + rng() * 0.08, 0.36 + rng() * 0.08, 0.38 + rng() * 0.08],
      lod: i < 2 ? 0 : i < 5 ? 1 : 2,
    });
  }

  // WATER TANK CLUSTER
  const tanks = tall ? 1 + Math.floor(rng() * 3) : b.height > 42 && rng() < 0.24 ? 1 : 0;
  for (let i = 0; i < tanks; i++) {
    const tankR = 2.2 + rng() * 1.8;
    extras.push({
      x: b.cx + (rng() - 0.5) * top.hw * 1.3, y: deckY + 0.6, z: b.cz + (rng() - 0.5) * top.hd * 1.3,
      w: tankR, h: 5.0 + rng() * 2.6, d: tankR, color: [0.24, 0.25, 0.23], lod: i === 0 ? 0 : 1,
    });
  }

  // MAST — tall towers always get one, and it gets a visible base
  if (b.height > 80 && (tall || rng() < 0.48)) {
    const mx = b.cx + top.hw * 0.35;
    const mz = b.cz - top.hd * 0.35;
    if (tall) extras.push({ x: mx, y: deckY + 0.2, z: mz, w: 2.8, h: 1.4, d: 2.8, color: darken(color, 0.46), lod: 1 });
    extras.push({
      x: mx, y: deckY + (tall ? 1.6 : 1.0), z: mz, w: 0.7,
      h: Math.min(34, b.height * (0.07 + rng() * 0.07)), d: 0.7, color: darken(color, 0.42), lod: tall ? 0 : 2,
    });
  }
}

/**
 * Roof lighting. Every roof deck in the city was an unlit near-black plane at
 * night, which is the worst surface to lose because it is the one the player
 * perches on.
 *
 * These go into the WINDOW mesh, because that is the only emissive material in
 * the city — Lambert does not bounce light, so a "lit" roof is a small number of
 * bright shapes reading against a dark deck, not a deck that has been brightened.
 */
function addRoofLights(g: ChunkGen, b: BuildingData, rng: () => number): void {
  const top = b.tiers[b.tiers.length - 1];
  const cap = b.archetype === 'civic-institutional' ? 1.8 : 1.15;
  const deckY = top.topY + cap;
  const warm: Vec3 = [1.10 / WINDOW_MAT_ALBEDO, 0.74 / WINDOW_MAT_ALBEDO, 0.36 / WINDOW_MAT_ALBEDO];
  const red: Vec3 = [1.05 / WINDOW_MAT_ALBEDO, 0.16 / WINDOW_MAT_ALBEDO, 0.13 / WINDOW_MAT_ALBEDO];

  // access-shed doorway — a small lit slot at deck level
  if (top.hw > 3 && top.hd > 3) {
    g.windows.push({
      x: b.cx + (rng() - 0.5) * top.hw * 1.1, y: deckY + 0.3, z: b.cz + top.hd * 0.62,
      w: 1.5, h: 2.1, d: 0.25, color: warm, lod: 0,
    });
  }
  // deck perimeter strips, inside the parapet: two thin runs so the roof edge
  // reads as a lit shape from above and from alongside
  if (top.hw > 5 && top.hd > 5) {
    g.windows.push({
      x: b.cx, y: deckY + 0.15, z: b.cz + top.hd * 0.9,
      w: top.hw * 1.5, h: 0.3, d: 0.4, color: warm, lod: 0,
    });
    if (b.height > 60) {
      g.windows.push({
        x: b.cx - top.hw * 0.9, y: deckY + 0.15, z: b.cz,
        w: 0.4, h: 0.3, d: top.hd * 1.5, color: warm, lod: 0,
      });
    }
  }
  // red obstruction light on the crown of anything tall enough to need one
  if (b.height > 80) {
    g.windows.push({
      x: b.cx + top.hw * 0.35, y: deckY + Math.min(35, b.height * 0.1) + 1.4, z: b.cz - top.hd * 0.35,
      w: 0.9, h: 0.9, d: 0.9, color: red, lod: 0,
    });
  }
}

function buildAnchors(b: BuildingData): AnchorCandidate[] {
  const out: AnchorCandidate[] = [];
  let id = 0;
  for (let i = 0; i < b.tiers.length; i++) {
    const t = b.tiers[i];
    const y = Math.min(t.topY - 1.2, Math.max(t.baseY + 8, t.topY - C.storeyHeight));
    out.push({ x: b.cx + t.hw, y, z: b.cz, nx: 1, ny: 0, nz: 0, kind: 'wall', idOffset: id++ });
    out.push({ x: b.cx - t.hw, y, z: b.cz, nx: -1, ny: 0, nz: 0, kind: 'wall', idOffset: id++ });
    out.push({ x: b.cx, y, z: b.cz + t.hd, nx: 0, ny: 0, nz: 1, kind: 'wall', idOffset: id++ });
    out.push({ x: b.cx, y, z: b.cz - t.hd, nx: 0, ny: 0, nz: -1, kind: 'wall', idOffset: id++ });
    if (i === b.tiers.length - 1 || t.topY > 35) {
      out.push({ x: b.cx + t.hw * 0.72, y: t.topY + 1.2, z: b.cz + t.hd * 0.72, nx: 0.7, ny: 0.2, nz: 0.7, kind: 'corner', idOffset: id++ });
      out.push({ x: b.cx - t.hw * 0.72, y: t.topY + 1.2, z: b.cz - t.hd * 0.72, nx: -0.7, ny: 0.2, nz: -0.7, kind: 'corner', idOffset: id++ });
    }
  }
  const top = b.tiers[b.tiers.length - 1];
  out.push({ x: b.cx, y: top.topY + 1.6, z: b.cz, nx: 0, ny: 1, nz: 0, kind: 'roof', idOffset: id++ });
  return out;
}

function addBuilding(
  g: ChunkGen, cx: number, cz: number, hw: number, hd: number,
  rng: () => number, seed: number, heightScale: number, lite: boolean,
): void {
  const archetype = archetypeFor(cx, cz, hw, hd, rng, seed);
  const h = storeysFor(cx, cz, rng, seed, heightScale, archetype);
  const color = facadeColor(rng, h);
  const facade = facadeFor(archetype, rng);
  const tiers = tiersFor(h, hw, hd, rng, archetype);
  const extras: ExtraBox[] = [];
  if (!lite) {
    addRooftopKit(extras, { cx, cz, hw, hd, height: h, color, archetype, facade, tiers, structureId: 0, idBase: 0, winStart: 0, winCount: 0, cells: [], stamp: 0 }, rng);
  }
  const b: BuildingData = {
    cx, cz, hw, hd, height: h, color, archetype, facade, tiers, extras, anchors: [],
    structureId: 0, idBase: 0, winStart: g.windows.length, winCount: 0, cells: [], stamp: 0,
  };
  b.anchors = buildAnchors(b);
  g.buildings.push(b);
  // impostor silhouette boxes only for buildings tall enough to clear the
  // horizon fog — low-rise mass is invisible at impostor distance and just
  // burns instancing budget
  if (h > 30) g.impostor.push({ x: cx, z: cz, hw, hd, h, color });
  addWindows(g, b, rng, lite);
  b.winCount = g.windows.length - b.winStart;
}

// ---------------------------------------------------------------------------
// street-level detail
// ---------------------------------------------------------------------------

/**
 * Road slab TOP faces (0.05 avenue / 0.04 street) are the visible asphalt and are
 * NOT moved by anything here — gameplay street level is the analytic y <= 0.05
 * test in CitySystem.isSolidAt, and the swing nadir budget is measured off it.
 *
 * The BOTTOM faces are buried at ROAD_SUBGRADE instead of sitting at y = 0,
 * where they were *exactly* coplanar with the two ground planes. A coplanar pair
 * z-fights at any depth precision, so this had to go on principle — but be
 * honest about what it bought: measured on its own it did NOT move the altitude
 * flicker (it is a down-facing face, back-culled from any camera above the
 * street). The fix for that was the logarithmic depth buffer in core/Renderer.
 * See docs/critique/evidence/asphalt-flicker/. The bottom face is never visible,
 * so pushing it down costs nothing.
 */
const ROAD_SUBGRADE = -0.6;

function pushRoads(g: ChunkGen, aL: number, aR: number, sB: number, sT: number): void {
  // asphalt albedo ~0.10-0.14 — dark enough that up-facing surfaces don't blow
  // out under the midday sun while still taking the time-of-day light tint
  g.detail.push({ kind: D_ROAD_AV, x: aL, y: ROAD_SUBGRADE, z: (sB + sT) / 2, w: C.avenueWidth, h: 0.05 - ROAD_SUBGRADE, d: sT - sB, color: [0.13, 0.14, 0.15] });
  g.detail.push({ kind: D_ROAD_ST, x: (aL + aR) / 2, y: ROAD_SUBGRADE, z: sB, w: aR - aL, h: 0.04 - ROAD_SUBGRADE, d: C.streetWidth, color: [0.10, 0.11, 0.12] });
}

function pushAvenueLights(g: ChunkGen, aL: number, sB: number, sT: number, rng: () => number): void {
  const nL = Math.max(1, Math.round((sT - sB - 16) / 90));
  const lightOff = rng() * 45;
  for (let k = 0; k < nL; k++) {
    const lz = sB + 10 + k * 90 + lightOff;
    if (lz < sB + 4 || lz > sT - 4) continue;
    g.detail.push({ kind: D_LIGHT_POLE, x: aL + C.avenueWidth / 2 + 1.2, y: 0, z: lz, w: 0.5, h: 8, d: 0.5, color: [0.18, 0.20, 0.23] });
    g.detail.push({ kind: D_LIGHT_HEAD, x: aL + C.avenueWidth / 2 + 2.2, y: 7.6, z: lz, w: 2.6, h: 0.5, d: 0.9, color: [0.42, 0.47, 0.52] });
  }
}

function pushParkedCars(g: ChunkGen, aL: number, sB: number, sT: number, rng: () => number): void {
  if (rng() < 0.35) return;
  const nP = Math.max(1, Math.round((sT - sB - 14) / 34));
  const pOff = rng() * 12;
  for (let k = 0; k < nP; k++) {
    const pz = sB + 10 + k * 34 + pOff;
    if (pz < sB + 8 || pz > sT - 8) continue;
    g.detail.push({ kind: D_CAR, x: aL + C.avenueWidth / 2 + 3.4, y: 0.1, z: pz, w: 2.1, h: 1.35, d: 4.6, color: carColor(rng) });
  }
}

function pushDividers(g: ChunkGen, aL: number, sB: number, sT: number, rng: () => number): void {
  const nD = Math.max(1, Math.round((sT - sB - 20) / 40));
  const dOff = rng() * 30;
  for (let k = 0; k < nD; k++) {
    const dz = sB + 8 + k * 40 + dOff;
    if (dz < sB + 6 || dz > sT - 6) continue;
    // bottom at 0.02, NOT 0.05: 0.05 is exactly the avenue slab's top face.
    // Same hygiene as ROAD_SUBGRADE above (and the same caveat — this was not
    // what fixed the altitude flicker). The top stays at 0.12, so the divider
    // reads identically from the street.
    g.detail.push({ kind: D_DIVIDER, x: aL, y: 0.02, z: dz, w: 6, h: 0.10, d: 0.7, color: [0.80, 0.66, 0.28] });
  }
}

function pushStreetTrees(g: ChunkGen, aL: number, aR: number, sB: number, rng: () => number): void {
  const nT = Math.max(1, Math.round((aR - aL - 20) / 44));
  const tOff = rng() * 30;
  for (let k = 0; k < nT; k++) {
    const tx = aL + 20 + k * 44 + tOff;
    if (tx < aL + 8 || tx > aR - 8) continue;
    const sz = sB + C.streetWidth / 2 + 1.6;
    g.detail.push({ kind: D_TREE_TRUNK, x: tx, y: 0, z: sz, w: 0.7, h: 3.2, d: 0.7, color: TRUNK });
    g.detail.push({ kind: D_TREE_CANOPY, x: tx, y: 3.2, z: sz, w: 4.2, h: 4.2, d: 4.2, color: treeColor(rng) });
  }
}

function pushCrosswalk(g: ChunkGen, aL: number, sB: number, rng: () => number): void {
  if (rng() < 0.45) return;
  for (let k = 0; k < 3; k++) {
    g.detail.push({ kind: D_CROSSWALK, x: aL, y: 0.03, z: sB - 5 + k * 3.4, w: 2.2, h: 0.07, d: C.avenueWidth + 4, color: [0.88, 0.88, 0.88] });
  }
}

function pushParkTrees(g: ChunkGen, aL: number, aR: number, sB: number, sT: number, rng: () => number): void {
  const cx0 = aL + C.avenueWidth / 2 + C.sidewalk + 6;
  const cx1 = aR - C.avenueWidth / 2 - C.sidewalk - 6;
  const cz0 = sB + C.streetWidth / 2 + C.sidewalk + 6;
  const cz1 = sT - C.streetWidth / 2 - C.sidewalk - 6;
  for (let tx = cx0; tx <= cx1; tx += 26) {
    for (let tz = cz0; tz <= cz1; tz += 26) {
      const jx = tx + (rng() - 0.5) * 8;
      const jz = tz + (rng() - 0.5) * 8;
      const big = rng() < 0.18;
      g.detail.push({ kind: D_TREE_TRUNK, x: jx, y: 0, z: jz, w: big ? 0.9 : 0.7, h: big ? 6 : 3.6, d: big ? 0.9 : 0.7, color: TRUNK });
      g.detail.push({ kind: D_TREE_CANOPY, x: jx, y: big ? 6 : 3.6, z: jz, w: big ? 9 : 5.4, h: big ? 9 : 5.4, d: big ? 9 : 5.4, color: treeColor(rng) });
    }
  }
}

function addParkBlock(g: ChunkGen, aL: number, aR: number, sB: number, sT: number, rng: () => number, lite: boolean): void {
  if (lite) return;
  pushRoads(g, aL, aR, sB, sT);
  pushAvenueLights(g, aL, sB, sT, rng);
  pushParkTrees(g, aL, aR, sB, sT, rng);
}

function addBlockDetail(
  g: ChunkGen, aL: number, aR: number, sB: number, sT: number, rng: () => number, lite: boolean,
): void {
  if (lite) return;
  pushRoads(g, aL, aR, sB, sT);
  pushAvenueLights(g, aL, sB, sT, rng);
  pushStreetTrees(g, aL, aR, sB, rng);
  pushParkedCars(g, aL, sB, sT, rng);
  pushDividers(g, aL, sB, sT, rng);
  pushCrosswalk(g, aL, sB, rng);
}

// ---------------------------------------------------------------------------
// chunk generation
// ---------------------------------------------------------------------------

function overlapsPark(x0: number, x1: number, z0: number, z1: number): boolean {
  return x1 > C.park.x0 && x0 < C.park.x1 && z1 > C.park.z0 && z0 < C.park.z1;
}

function overlapsSpawnPlaza(x0: number, x1: number, z0: number, z1: number): boolean {
  return x1 > C.spawnPlaza.x0 && x0 < C.spawnPlaza.x1 && z1 > C.spawnPlaza.z0 && z0 < C.spawnPlaza.z1;
}

function overlapsRiver(x0: number, x1: number): boolean {
  return x1 > C.riverX0 && x0 < C.riverX1;
}

/**
 * Generate every building/detail/impostor for chunk (ci, cj).
 * Pure function of (ci, cj, seed). `lite` skips windows/extras/street detail,
 * used for far impostor chunks where only silhouette data is needed.
 */
export function genChunk(ci: number, cj: number, seed: number, lite = false): ChunkGen {
  const i0 = ci * C.blocksPerChunkI;
  const j0 = cj * C.blocksPerChunkJ;
  const g: ChunkGen = {
    ci, cj, i0, j0,
    x0: avenueX(i0, seed),
    x1: avenueX(i0 + C.blocksPerChunkI, seed),
    z0: streetZ(j0, seed),
    z1: streetZ(j0 + C.blocksPerChunkJ, seed),
    buildings: [], windows: [], detail: [], impostor: [],
  };

  for (let di = 0; di < C.blocksPerChunkI; di++) {
    for (let dj = 0; dj < C.blocksPerChunkJ; dj++) {
      const i = i0 + di;
      const j = j0 + dj;
      const aL = avenueX(i, seed);
      const aR = avenueX(i + 1, seed);
      const sB = streetZ(j, seed);
      const sT = streetZ(j + 1, seed);
      const lotX0 = aL + C.avenueWidth / 2 + C.sidewalk;
      const lotX1 = aR - C.avenueWidth / 2 - C.sidewalk;
      const lotZ0 = sB + C.streetWidth / 2 + C.sidewalk;
      const lotZ1 = sT - C.streetWidth / 2 - C.sidewalk;
      const W = lotX1 - lotX0;
      const D = lotZ1 - lotZ0;
      if (W < 16 || D < 10) continue; // degenerate lot from avenue jitter

      const rng = makeRng(hashCoords(i, j, seed ^ SEED_SALT));

      if (overlapsSpawnPlaza(lotX0, lotX1, lotZ0, lotZ1)) {
        addParkBlock(g, aL, aR, sB, sT, rng, lite);
        continue;
      }
      if (overlapsPark(lotX0, lotX1, lotZ0, lotZ1)) {
        addParkBlock(g, aL, aR, sB, sT, rng, lite);
        continue;
      }
      if (overlapsRiver(lotX0, lotX1)) continue; // water — no buildings, no roads

      const lotCx = (lotX0 + lotX1) / 2;
      const lotCz = (lotZ0 + lotZ1) / 2;
      const zone = zoneAt(lotCx, lotCz, seed);
      const roll = rng();
      const superTower = zone > 0.7 && roll < 0.08;

      if (superTower || (zone > 0.5 && roll < 0.4)) {
        // single tower filling most of the lot
        const hw = W / 2 - 2 - rng() * 4;
        const hd = D / 2 - 2 - rng() * 4;
        const ox = (rng() - 0.5) * (W - hw * 2 - 4);
        const oz = (rng() - 0.5) * (D - hd * 2 - 4);
        addBuilding(g, lotCx + ox, lotCz + oz, hw, hd, rng, seed, superTower ? 1.3 : 1, lite);
      } else if (roll < 0.72) {
        // row: 2-3 buildings along the longer axis for a dense facade rhythm
        const n = rng() < 0.5 ? 2 : 3;
        if (W >= D) {
          const gap = (n - 1) * 3;
          const seg = (W - gap) / n;
          for (let k = 0; k < n; k++) {
            addBuilding(g, lotX0 + gap / 2 + seg * (k + 0.5), lotCz, seg / 2 - 1.5, D / 2 - 2, rng, seed, 1, lite);
          }
        } else {
          const gap = (n - 1) * 3;
          const seg = (D - gap) / n;
          for (let k = 0; k < n; k++) {
            addBuilding(g, lotCx, lotZ0 + gap / 2 + seg * (k + 0.5), W / 2 - 2, seg / 2 - 1.5, rng, seed, 1, lite);
          }
        }
      } else {
        // cluster: four smaller boxes in a 2x2 grid
        const hw = W / 4 - 1.5;
        const hd = D / 4 - 1.5;
        const xs = [lotX0 + W / 4, lotX0 + W * 0.75];
        const zs = [lotZ0 + D / 4, lotZ0 + D * 0.75];
        for (let a = 0; a < 2; a++) {
          for (let b = 0; b < 2; b++) {
            addBuilding(g, xs[a], zs[b], hw, hd, rng, seed, 0.8 + rng() * 0.35, lite);
          }
        }
      }

      addBlockDetail(g, aL, aR, sB, sT, rng, lite);
    }
  }

  // stable per-building identity, independent of load order
  const key = (((ci + 0x8000) * 0x10000 + (cj + 0x8000)) >>> 0) * 4096;
  for (let k = 0; k < g.buildings.length; k++) {
    const b = g.buildings[k];
    b.structureId = key + k;
    b.idBase = b.structureId * 16;
  }

  return g;
}
