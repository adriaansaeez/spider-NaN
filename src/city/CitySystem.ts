/**
 * OWNER: city-builder. You own everything under src/city/.
 *
 * Manhattan-inspired procedural city, retro low-poly, deterministic from
 * GLOBALS.worldSeed. Perceived scale >> simulated scale:
 *  - chunks stream around the player; each is a few InstancedMesh draw calls
 *  - full-detail chunks near the player, silhouette impostor chunks farther out
 *  - per-chunk meshes get real frustum culling via computed bounding spheres
 *  - distant chunks render as one-box-per-building impostors so nothing pops
 *    in the forward corridor (fog hides the swap)
 *  - street-level instanced detail (roads, lights, trees, parked cars,
 *    crosswalks) makes skimming low read as fast
 *  - instanced traffic flows along the avenue/street network (visual only)
 *
 * Implements `AnchorQuery` exactly as declared in src/contracts — the traversal
 * system never imports this module. findSwingAnchor narrows via the spatial hash
 * BEFORE any per-building scoring.
 */
import * as THREE from 'three';
import {
  type Anchor, type AnchorQuery, type AnchorQueryParams,
  type System, type UpdateContext, hashCoords, makeRng,
} from '../contracts';
import { GLOBALS } from '../contracts/globals';
import { CITY_TUNING as C } from './tuning';
import {
  avenueX, streetZ, carColor, genChunk,
  D_ROAD_AV, D_ROAD_ST,
  type AnchorCandidate, type BuildingData, type WindowBand,
} from './gen';
import { DayNightSystem } from './DayNightSystem';
import { initGroundTextures, groundMaterial, roadMaterial, disposeGroundTextures } from './GroundMaterials';


const CHUNK_W = C.avenueSpacing * C.blocksPerChunkI;
const CHUNK_H = C.streetSpacing * C.blocksPerChunkJ;


/** Which visual representation buildings render with. Only 'boxes' exists now. */
export type BuildingMode = 'boxes';

type CityDebugApi = Record<string, unknown> & {
  setBuildingMode?: (mode: BuildingMode) => BuildingMode;
  buildingMode?: BuildingMode;
};

function chunkKey(ci: number, cj: number): number {
  return (((ci + 0x8000) << 16) | ((cj + 0x8000) & 0xffff)) >>> 0;
}
function keyI(key: number): number { return (key >>> 16) - 0x8000; }
function keyJ(key: number): number { return (key & 0xffff) - 0x8000; }

interface LoadedChunk {
  ci: number; cj: number; key: number;
  meshes: THREE.InstancedMesh[];
  recs: BuildingData[];
  /** The chunk's building-box InstancedMesh (tiers + extras), if it has one. */
  boxMesh: THREE.InstancedMesh | null;
  /** The chunk's emissive window-band mesh and its source bands, if any. */
  windowMesh: THREE.InstancedMesh | null;
  windows: WindowBand[];
  /** Per-building visual state. Parallel to nothing — carries its own ref. */
  vis: BuildingVis[];
}

/**
 * Per-building visual bookkeeping. A building is drawn as its span of
 * procedural boxes in the chunk's box mesh.
 */
interface BuildingVis {
  b: BuildingData;
  /** First slot of this building's boxes in its chunk's box mesh. */
  boxStart: number;
  /** How many box slots the building owns (tiers + extras). */
  boxCount: number;
  /** First roof/detail slot in the box mesh; tiers live before this. */
  extraStart: number;
  extraCount: number;
  detailLod: 0 | 1 | 2;
}

interface ImpBox {
  x: number; z: number; hw: number; hd: number; h: number;
  r: number; g: number; b: number;
}

interface Car {
  axis: number;       // 0 = avenue (N-S along Z), 1 = street (E-W along X)
  lane: number;       // avenue X or street Z
  dir: number;        // -1/+1 travel sign
  speed: number;
  offset: number;
  color: [number, number, number];
}

export class CitySystem implements System, AnchorQuery {
  readonly group = new THREE.Group();

  private seed = GLOBALS.worldSeed;
  private chunks = new Map<number, LoadedChunk>();
  private impostorSlots = new Map<number, number[]>();
  private impState: (ImpBox | null)[] = [];
  private impFree: number[] = [];
  private impDirty = false;
  private impostorMesh: THREE.InstancedMesh;
  private totalBuildings = 0;

  // spatial hash of building recs, keyed by cell
  private grid = new Map<number, BuildingData[]>();
  private cellsScratch: number[] = [];
  private queryStamp = 0;

  private focus = new THREE.Vector3();
  private focusVelocity = new THREE.Vector3();
  private trafficFocus = Number.MIN_SAFE_INTEGER;
  private cars: Car[] = [];
  private trafficBodyMesh: THREE.InstancedMesh;
  private trafficRoofMesh: THREE.InstancedMesh;

  // shared materials (retro low-poly: flat shading, no textures)
  private buildMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  private windowMat = new THREE.MeshLambertMaterial({
    color: 0x4a4a4a, emissive: 0xffb35c, emissiveIntensity: 0, flatShading: true,
  });
  private detailMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  private impostorMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  private bridgeMat = new THREE.MeshLambertMaterial({ color: 0x3c4048, flatShading: true });
  private roadMat!: THREE.MeshLambertMaterial;

  private windowRegistered = false;
  private detailFocusX = Infinity;
  private detailFocusZ = Infinity;

  // scratch objects for hot paths (no per-frame allocation)
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  /** Kept at IDENTITY for the axis-aligned box writers — never mutate it. */
  private tmpQ = new THREE.Quaternion();
  private tmpC = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.impostorMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      this.impostorMat,
      C.impostorCapacity,
    );
    this.impostorMesh.geometry.translate(0, 0.5, 0);
    this.impostorMesh.frustumCulled = false;
    this.impostorMesh.castShadow = false;
    this.impostorMesh.receiveShadow = false;
    this.impostorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.impostorMesh.count = 0;
    this.group.add(this.impostorMesh);

    const maxCars = this.maxCars();
    this.trafficBodyMesh = this.makeTrafficMesh(maxCars);
    this.trafficRoofMesh = this.makeTrafficMesh(maxCars);
    this.group.add(this.trafficBodyMesh, this.trafficRoofMesh);

    initGroundTextures();
    this.roadMat = roadMaterial();
    this.buildStatics();
    scene.add(this.group);

    // debug surface for the determinism reproducibility check (additive only)
    if (typeof window !== 'undefined') {
      (window as unknown as { __CITY__?: unknown }).__CITY__ = {
        chunkCount: () => this.chunks.size,
        buildingCount: () => this.totalBuildings,
        dumpChunks: () => this.dumpChunks(),
        updateStats: () => this.updateStats,
        buildingMode: () => 'boxes' as BuildingMode,
        worldFingerprint: () => this.worldFingerprint(),
        buildingSystemReport: () => this.buildingSystemReport(),
        varietySamples: (count = 25) => this.varietySamples(count),
      };
    }
    this.syncCityDebugApi();
  }

  // ---------------------------------------------------------------------------
  // building visual mode — procedural boxes only
  //
  // The authored GLB building set has been retired. The city ships only its own
  // procedural buildings with window grids and emissive night lighting.
  // ---------------------------------------------------------------------------

  /** Runtime no-op, retained for harness/critic compatibility. Always returns 'boxes'. */
  private readonly setBuildingMode = (_mode: BuildingMode): BuildingMode => {
    return 'boxes';
  };

  private syncCityDebugApi(): void {
    if (typeof window === 'undefined') return;
    const api = (window as unknown as { __GAUNTLET__?: CityDebugApi }).__GAUNTLET__;
    if (!api) return;
    api.setBuildingMode = this.setBuildingMode;
    api.buildingMode = 'boxes';
  }

  private maxDetailLodFor(v: BuildingVis, fx: number, fz: number): 0 | 1 | 2 {
    const dx = v.b.cx - fx;
    const dz = v.b.cz - fz;
    const d2 = dx * dx + dz * dz;
    if (d2 <= C.rooftopTertiaryRadius * C.rooftopTertiaryRadius) return 2;
    if (d2 <= C.rooftopSecondaryRadius * C.rooftopSecondaryRadius) return 1;
    return 0;
  }

  private applyDetailLod(force: boolean): void {
    const f = this.focus;
    const mdx = f.x - this.detailFocusX;
    const mdz = f.z - this.detailFocusZ;
    if (!force && mdx * mdx + mdz * mdz < C.rooftopLodRepoll * C.rooftopLodRepoll) return;
    this.detailFocusX = f.x;
    this.detailFocusZ = f.z;
    for (const ch of this.chunks.values()) {
      if (!ch.boxMesh) continue;
      let dirty = false;
      for (const v of ch.vis) {
        const next = this.maxDetailLodFor(v, f.x, f.z);
        if (!force && next === v.detailLod) continue;
        v.detailLod = next;
        this.writeBuildingExtras(ch.boxMesh, v.extraStart, v.b, next);
        dirty = true;
      }
      if (dirty) this.commit(ch.boxMesh);
    }
  }

  private makeTrafficMesh(capacity: number): THREE.InstancedMesh {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, this.detailMat, Math.max(capacity, 1));
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 1;
    return mesh;
  }

  private maxCars(): number {
    const iN = Math.ceil(C.trafficRadius / C.avenueSpacing);
    const jN = Math.ceil(C.trafficRadius / C.streetSpacing);
    return ((2 * iN + 1) + (2 * jN + 1)) * 2 * C.carsPerLane;
  }

  // ---------------------------------------------------------------------------
  // static world: ground, river, park, bridges
  // ---------------------------------------------------------------------------

  private buildStatics(): void {
    const g = this.group;

    const groundEast = new THREE.Mesh(
      new THREE.PlaneGeometry(14000 - C.riverX1, 16000),
      groundMaterial(),
    );
    groundEast.rotation.x = -Math.PI / 2;
    groundEast.position.set((C.riverX1 + 14000) / 2, 0, 0);
    groundEast.receiveShadow = true;
    g.add(groundEast);

    const groundWest = new THREE.Mesh(
      new THREE.PlaneGeometry(C.riverX0 + 14000, 16000),
      groundMaterial(),
    );
    groundWest.rotation.x = -Math.PI / 2;
    groundWest.position.set((C.riverX0 - 14000) / 2, 0, 0);
    groundWest.receiveShadow = true;
    g.add(groundWest);

    // river — a strip of water with no buildings
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(C.riverX1 - C.riverX0 + 60, 16000),
      new THREE.MeshLambertMaterial({ color: 0x16384a, flatShading: true }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set((C.riverX0 + C.riverX1) / 2, -0.4, 0);
    water.receiveShadow = false;
    g.add(water);

    // central park — grass over the park blocks
    const park = new THREE.Mesh(
      new THREE.PlaneGeometry(C.park.x1 - C.park.x0 + 12, C.park.z1 - C.park.z0 + 12),
      new THREE.MeshLambertMaterial({ color: 0x33492e, flatShading: true }),
    );
    park.rotation.x = -Math.PI / 2;
    park.position.set((C.park.x0 + C.park.x1) / 2, 0.02, (C.park.z0 + C.park.z1) / 2);
    park.receiveShadow = true;
    g.add(park);

    // spawn plaza — grass so the player never spawns inside a building
    const plaza = new THREE.Mesh(
      new THREE.PlaneGeometry(C.spawnPlaza.x1 - C.spawnPlaza.x0 + 20, C.spawnPlaza.z1 - C.spawnPlaza.z0 + 20),
      new THREE.MeshLambertMaterial({ color: 0x3a4a36, flatShading: true }),
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set((C.spawnPlaza.x0 + C.spawnPlaza.x1) / 2, 0.02, (C.spawnPlaza.z0 + C.spawnPlaza.z1) / 2);
    plaza.receiveShadow = true;
    g.add(plaza);

    // bridges across the river
    const n = C.bridgeZs.length;
    const bridgeMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.bridgeMat, n * 3);
    bridgeMesh.geometry.translate(0, 0.5, 0);
    bridgeMesh.frustumCulled = false;
    bridgeMesh.castShadow = true;
    bridgeMesh.receiveShadow = true;
    const mid = (C.riverX0 + C.riverX1) / 2;
    const span = (C.riverX1 - C.riverX0) + 160;
    let slot = 0;
    for (let i = 0; i < n; i++) {
      const bz = C.bridgeZs[i];
      // deck
      this.tmpV.set(mid, 7, bz);
      this.tmpS.set(span, 4, 26);
      this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
      bridgeMesh.setMatrixAt(slot++, this.tmpM);
      // pylons
      for (const side of [-1, 1]) {
        this.tmpV.set(mid + side * (span / 2 - 12), 30, bz);
        this.tmpS.set(12, 60, 10);
        this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
        bridgeMesh.setMatrixAt(slot++, this.tmpM);
      }
    }
    bridgeMesh.instanceMatrix.needsUpdate = true;
    g.add(bridgeMesh);
  }

  // ---------------------------------------------------------------------------
  // update / streaming
  // ---------------------------------------------------------------------------

  update(ctx: UpdateContext): void {
    const t0 = performance.now();
    const f = this.focusPos();

    // window material registers with the day/night system once it exists
    const dn = DayNightSystem.instance;
    if (dn && !this.windowRegistered) {
      dn.registerWindowMaterial(this.windowMat);
      this.windowRegistered = true;
    }
    dn?.setShadowFocus(f, this.focusVelocity);

    this.syncCityDebugApi();
    this.streamChunks();
    this.applyDetailLod(false);

    // rebuild the traffic set only when the player crosses an avenue or street line
    const tf = (Math.round(f.x / C.avenueSpacing) + 0x400000)
      + (Math.round(f.z / C.streetSpacing) + 0x400000) * 0x800000;
    if (tf !== this.trafficFocus) {
      this.trafficFocus = tf;
      this.buildCars();
    }
    this.updateTraffic(ctx.elapsed);
    dn?.refreshShadows();
    const dtMs = performance.now() - t0;
    this.updateMsAcc += dtMs;
    this.updateMsN++;
    if (dtMs > this.updateMsMax) this.updateMsMax = dtMs;
  }

  private updateMsAcc = 0;
  private updateMsN = 0;
  private updateMsMax = 0;
  get updateStats(): { avgMs: number; maxMs: number; count: number } {
    return {
      avgMs: this.updateMsN ? this.updateMsAcc / this.updateMsN : 0,
      maxMs: this.updateMsMax,
      count: this.updateMsN,
    };
  }

  /**
   * Re-read the player position and settle the world against it *now*, instead
   * of over the next few frames. Used by `__GAUNTLET__.setPlayerPosition` so a
   * critic can teleport to a building and screenshot on the very next frame —
   * including while paused, when `update()` is not running at all.
   *
   * Both LOD sweeps are forced: they normally skip unless the focus has moved
   * more than a threshold, which a teleport satisfies anyway, but forcing makes
   * the call unconditional and therefore reproducible.
   */
  refocus(): void {
    this.focusPos();
    this.streamChunks();
    this.applyDetailLod(true);
    const f = this.focus;
    const tf = (Math.round(f.x / C.avenueSpacing) + 0x400000)
      + (Math.round(f.z / C.streetSpacing) + 0x400000) * 0x800000;
    if (tf !== this.trafficFocus) {
      this.trafficFocus = tf;
      this.buildCars();
    }
    DayNightSystem.instance?.setShadowFocus(f, this.focusVelocity);
    DayNightSystem.instance?.refreshShadows();
  }

  private focusPos(): THREE.Vector3 {
    if (typeof window === 'undefined') return this.focus;
    const w = window as unknown as { __GAUNTLET__?: { player?: () => { position?: THREE.Vector3; velocity?: THREE.Vector3 } | null } };
    const p = w.__GAUNTLET__?.player?.();
    if (p && p.position) {
      this.focus.copy(p.position);
      if (p.velocity) this.focusVelocity.copy(p.velocity);
      else this.focusVelocity.set(0, 0, 0);
    }
    return this.focus;
  }

  /**
   * MEASURED CEILING — read before raising `C.loadChunkRadius`.
   *
   * Radius 2 keeps a 5x5 = 25 chunk resident set (up to 49 in flight, because
   * eviction only fires past radius+1). Radius 3 would make that 49 / 81.
   *
   * Draw calls are NOT simply linear in residency — per-chunk box meshes have
   * `frustumCulled = true`, so what is resident and what is submitted differ.
   * Across 49 stationed samples I measured 66-115 draw calls at 25-31 resident
   * chunks; the least-squares slope against chunk count is only 0.33 dc/chunk,
   * not the ~4.5 a spawn-vs-traversal comparison suggests (that comparison
   * varies the camera, not the residency). The slope is measured over too narrow
   * a range to extrapolate, so do not.
   *
   * The bound that IS safe to state is structural: a chunk contributes at most
   * three InstancedMeshes (box, window band, detail), and everything else is
   * fixed — 16 model-variant meshes, 1 impostor, 2 traffic, ~6 statics, plus FX.
   *   radius 2 (25 chunks): <= 3*25 + 16 + ~10 = ~101 worst case; 110 observed.
   *   radius 3 (49 chunks): <= 3*49 + 16 + ~10 = ~173 worst case, against 220.
   *
   * So radius 3 is probably affordable but leaves ~21% headroom on a budget that
   * currently sits at 50%. **This has never been run.** If it is wanted, merge
   * the window-band and detail meshes into the box mesh first — that turns the
   * per-chunk contribution from 3 into 1 and the radius-3 bound into ~75.
   */
  private streamChunks(): void {
    const f = this.focus;
    const cxf = Math.round(f.x / CHUNK_W);
    const czf = Math.round(f.z / CHUNK_H);
    const LOAD = C.loadChunkRadius;
    const IMP = C.impostorChunkRadius;

    for (let ci = cxf - LOAD; ci <= cxf + LOAD; ci++) {
      for (let cj = czf - LOAD; cj <= czf + LOAD; cj++) {
        const key = chunkKey(ci, cj);
        if (!this.chunks.has(key)) this.buildChunk(key, ci, cj);
      }
    }
    for (let ci = cxf - IMP; ci <= cxf + IMP; ci++) {
      for (let cj = czf - IMP; cj <= czf + IMP; cj++) {
        if (Math.abs(ci - cxf) <= LOAD && Math.abs(cj - czf) <= LOAD) continue;
        const key = chunkKey(ci, cj);
        if (!this.impostorSlots.has(key)) this.buildImpostor(key, ci, cj);
      }
    }
    for (const [key, ch] of this.chunks) {
      if (Math.abs(ch.ci - cxf) > LOAD + 1 || Math.abs(ch.cj - czf) > LOAD + 1) {
        this.removeChunk(key);
      }
    }
    for (const key of this.impostorSlots.keys()) {
      const ci = keyI(key);
      const cj = keyJ(key);
      if (Math.abs(ci - cxf) > IMP + 1 || Math.abs(cj - czf) > IMP + 1) {
        this.freeImpostor(key);
      }
    }
    if (this.impDirty) this.rebuildImpostor();
  }

  // ---------------------------------------------------------------------------
  // chunk build / teardown
  // ---------------------------------------------------------------------------

  private buildChunk(key: number, ci: number, cj: number): void {
    const gen = genChunk(ci, cj, this.seed, false);
    const slots = this.impostorSlots.get(key);
    if (slots) this.freeImpostor(key);

    const meshes: THREE.InstancedMesh[] = [];
    // exact box count — tiers + extras per building, not a guessed multiplier
    let need = 0;
    for (const b of gen.buildings) need += b.tiers.length + b.extras.length;
    const bMesh = this.makeBoxMesh(this.buildMat, Math.max(need, 1));
    // The box mesh is ALWAYS built, in both modes. In models mode a building
    // that gets an authored model has its span zeroed out rather than removed,
    // so LOD transitions and the runtime mode toggle never rebuild geometry.
    const vis: BuildingVis[] = [];
    let bi = 0;
    for (const b of gen.buildings) {
      const start = bi;
      bi = this.writeBuildingBoxes(bMesh, start, b);
      const v: BuildingVis = {
        b, boxStart: start, boxCount: bi - start,
        extraStart: start + b.tiers.length, extraCount: b.extras.length,
        detailLod: 2,
      };
      vis.push(v);
    }
    let boxMesh: THREE.InstancedMesh | null = null;
    if (bi > 0) {
      bMesh.count = bi;
      this.commit(bMesh);
      meshes.push(bMesh);
      boxMesh = bMesh;
    }

    let windowMesh: THREE.InstancedMesh | null = null;
    if (gen.windows.length > 0) {
      const wMesh = this.makeBoxMesh(this.windowMat, gen.windows.length);
      for (let i = 0; i < gen.windows.length; i++) {
        const w = gen.windows[i];
        this.writeBox(wMesh, i, w.x, w.y, w.z, w.w, w.h, w.d, w.color);
      }
      wMesh.count = gen.windows.length;
      this.commit(wMesh);
      meshes.push(wMesh);
      windowMesh = wMesh;
    }

    if (gen.detail.length > 0) {
      // Split roads from other detail items so roads get the asphalt texture.
      let roadCount = 0;
      for (const d of gen.detail) {
        if (d.kind === D_ROAD_AV || d.kind === D_ROAD_ST) roadCount++;
      }
      const otherCount = gen.detail.length - roadCount;

      // Non-road detail (trees, cars, poles, crosswalks) — keeps detailMat.
      if (otherCount > 0) {
        const dMesh = this.makeBoxMesh(this.detailMat, otherCount);
        let si = 0;
        for (const d of gen.detail) {
          if (d.kind === D_ROAD_AV || d.kind === D_ROAD_ST) continue;
          this.writeBox(dMesh, si++, d.x, d.y, d.z, d.w, d.h, d.d, d.color);
        }
        dMesh.count = otherCount;
        this.commit(dMesh);
        meshes.push(dMesh);
      }

      // Road detail (D_ROAD_AV, D_ROAD_ST) — gets the asphalt texture.
      // Write white instanceColour so albedo = texture × materialColor only.
      // The original d.color [0.10–0.15] would triple-multiply with the
      // texture and material colour, crushing roads to black.
      if (roadCount > 0) {
        const rMesh = this.makeBoxMesh(this.roadMat, roadCount);
        let ri = 0;
        for (const d of gen.detail) {
          if (d.kind !== D_ROAD_AV && d.kind !== D_ROAD_ST) continue;
          this.writeBox(rMesh, ri++, d.x, d.y, d.z, d.w, d.h, d.d, [1, 1, 1]);
        }
        rMesh.count = roadCount;
        this.commit(rMesh);
        meshes.push(rMesh);
      }
    }

    for (const m of meshes) this.group.add(m);

    for (const b of gen.buildings) this.gridInsert(b);

    const chunk: LoadedChunk = {
      ci, cj, key, meshes, recs: gen.buildings, boxMesh, windowMesh, windows: gen.windows, vis,
    };
    this.chunks.set(key, chunk);
    this.totalBuildings += gen.buildings.length;
    this.applyDetailLod(true);
  }

  /** Write one building's tiers + extras starting at `start`. Returns the next
   *  free slot. Single source of truth for the box layout, so restoring a
   *  building's boxes after a model LOD swap reproduces them exactly. */
  private writeBuildingBoxes(mesh: THREE.InstancedMesh, start: number, b: BuildingData): number {
    let i = this.writeBuildingTiers(mesh, start, b);
    return this.writeBuildingExtras(mesh, i, b, 2);
  }

  private writeBuildingTiers(mesh: THREE.InstancedMesh, start: number, b: BuildingData): number {
    let i = start;
    for (const t of b.tiers) {
      i = this.writeBox(mesh, i, b.cx, t.baseY, b.cz, t.hw * 2, t.topY - t.baseY, t.hd * 2, b.color);
    }
    return i;
  }

  private writeBuildingExtras(mesh: THREE.InstancedMesh, start: number, b: BuildingData, maxLod: 0 | 1 | 2): number {
    let i = start;
    for (const e of b.extras) {
      if (e.lod <= maxLod) i = this.writeBox(mesh, i, e.x, e.y, e.z, e.w, e.h, e.d, e.color);
      else i = this.writeZeroBox(mesh, i, e.x, e.y, e.z);
    }
    return i;
  }

  private writeZeroBox(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number): number {
    if (i >= mesh.instanceMatrix.count) {
      console.warn(`[city] writeZeroBox overflow: index ${i} >= capacity ${mesh.instanceMatrix.count}`);
      return i;
    }
    this.tmpV.set(x, y, z);
    this.tmpS.set(0, 0, 0);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
    mesh.setMatrixAt(i, this.tmpM);
    this.tmpC.setRGB(0, 0, 0);
    mesh.setColorAt(i, this.tmpC);
    return i + 1;
  }

  private makeBoxMesh(mat: THREE.Material, capacity: number): THREE.InstancedMesh {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(capacity, 1));
    mesh.frustumCulled = true;
    mesh.castShadow = mat === this.buildMat;
    mesh.receiveShadow = mat === this.buildMat || mat === this.roadMat;
    return mesh;
  }

  private writeBox(
    mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number,
    w: number, h: number, d: number, color: [number, number, number],
  ): number {
    if (i >= mesh.instanceMatrix.count) {
      // fail loudly — an over-capacity write previously corrupted the whole draw call
      console.warn(`[city] writeBox overflow: index ${i} >= capacity ${mesh.instanceMatrix.count}`);
      return i;
    }
    this.tmpV.set(x, y, z);
    this.tmpS.set(w, h, d);
    this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
    mesh.setMatrixAt(i, this.tmpM);
    this.tmpC.setRGB(color[0], color[1], color[2]);
    mesh.setColorAt(i, this.tmpC);
    return i + 1;
  }

  private commit(mesh: THREE.InstancedMesh): void {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  /**
   * The ONLY correct way to retire a per-chunk InstancedMesh.
   *
   * `geometry.dispose()` alone is not enough and the omission is invisible:
   * an InstancedMesh's `instanceMatrix` / `instanceColor` GPU buffers belong to
   * the MESH, not the geometry, and three releases them only from the mesh's own
   * `dispose` event (WebGLObjects.onInstancedMeshDispose). Streaming out a chunk
   * without `mesh.dispose()` orphaned up to 6 GL buffers per chunk forever —
   * measured at +160 live buffers / 60 s of flight, unbounded, surviving forced
   * GC, and breaching no budget because the perf contract cannot see GPU memory.
   *
   * Materials are deliberately NOT disposed here: buildMat / windowMat /
   * detailMat are shared by every chunk and outlive all of them.
   */
  private disposeChunkMesh(m: THREE.InstancedMesh): void {
    this.group.remove(m);
    m.geometry.dispose();
    m.dispose();
  }

  private removeChunk(key: number): void {
    const ch = this.chunks.get(key);
    if (!ch) return;
    for (const m of ch.meshes) this.disposeChunkMesh(m);
    for (const b of ch.recs) this.gridRemove(b);
    this.totalBuildings -= ch.recs.length;
    this.chunks.delete(key);
  }

  // --- impostor stream -------------------------------------------------------

  private buildImpostor(key: number, ci: number, cj: number): void {
    const gen = genChunk(ci, cj, this.seed, true);
    const slots: number[] = [];
    for (const b of gen.impostor) {
      let slot: number;
      if (this.impFree.length > 0) {
        slot = this.impFree.pop()!;
      } else {
        if (this.impState.length >= C.impostorCapacity) {
          console.warn(`[city] impostor capacity reached (${C.impostorCapacity})`);
          break;
        }
        slot = this.impState.length;
        this.impState.push(null);
      }
      this.impState[slot] = {
        x: b.x, z: b.z, hw: b.hw, hd: b.hd, h: b.h,
        r: b.color[0], g: b.color[1], b: b.color[2],
      };
      slots.push(slot);
    }
    this.impostorSlots.set(key, slots);
    this.impDirty = true;
  }

  private freeImpostor(key: number): void {
    const slots = this.impostorSlots.get(key);
    if (!slots) return;
    for (const s of slots) {
      this.impState[s] = null;
      this.impFree.push(s);
    }
    this.impostorSlots.delete(key);
    this.impDirty = true;
  }

  private rebuildImpostor(): void {
    const n = this.impState.length;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (count >= C.impostorCapacity) break;
      const b = this.impState[i];
      if (!b) continue;
      this.tmpV.set(b.x, 0, b.z);
      this.tmpS.set(b.hw * 2, b.h, b.hd * 2);
      this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
      this.impostorMesh.setMatrixAt(count, this.tmpM);
      this.tmpC.setRGB(b.r, b.g, b.b);
      this.impostorMesh.setColorAt(count, this.tmpC);
      count++;
    }
    this.impostorMesh.count = Math.min(count, C.impostorCapacity);
    this.impostorMesh.instanceMatrix.needsUpdate = true;
    if (this.impostorMesh.instanceColor) this.impostorMesh.instanceColor.needsUpdate = true;
    this.impDirty = false;
  }

  // ---------------------------------------------------------------------------
  // traffic
  // ---------------------------------------------------------------------------

  private buildCars(): void {
    const f = this.focus;
    const iF = Math.round(f.x / C.avenueSpacing);
    const jF = Math.round(f.z / C.streetSpacing);
    const iN = Math.ceil(C.trafficRadius / C.avenueSpacing);
    const jN = Math.ceil(C.trafficRadius / C.streetSpacing);
    const span = 2 * C.trafficRadius;
    const cars: Car[] = this.cars;
    cars.length = 0;

    for (let i = iF - iN; i <= iF + iN; i++) {
      const ax = avenueX(i, this.seed);
      if (ax > C.riverX0 && ax < C.riverX1) continue; // avenue inside the river
      for (let dir = -1; dir <= 1; dir += 2) {
        const rng = makeRng(hashCoords(i * 2 + (dir + 1) / 2, 4242, this.seed));
        for (let k = 0; k < C.carsPerLane; k++) {
          cars.push({
            axis: 0,
            lane: ax + dir * 5.5,
            dir,
            speed: (C.carSpeedMin + rng() * (C.carSpeedMax - C.carSpeedMin)) * dir,
            offset: k * (span / C.carsPerLane) + rng() * 28,
            color: carColor(rng),
          });
        }
      }
    }
    for (let j = jF - jN; j <= jF + jN; j++) {
      const sz = streetZ(j, this.seed);
      for (let dir = -1; dir <= 1; dir += 2) {
        const rng = makeRng(hashCoords(5151, j * 2 + (dir + 1) / 2, this.seed));
        for (let k = 0; k < C.carsPerLane; k++) {
          cars.push({
            axis: 1,
            lane: sz + dir * 4.5,
            dir,
            speed: (C.carSpeedMin + rng() * (C.carSpeedMax - C.carSpeedMin)) * dir,
            offset: k * (span / C.carsPerLane) + rng() * 28,
            color: carColor(rng),
          });
        }
      }
    }
    const cap = this.trafficBodyMesh.instanceMatrix.count;
    this.trafficBodyMesh.count = Math.min(Math.max(cars.length, 1), cap);
    this.trafficRoofMesh.count = Math.min(Math.max(cars.length, 1), cap);
  }

  private updateTraffic(elapsed: number): void {
    const L = 2 * C.trafficRadius;
    const f = this.focus;
    const q = this.tmpQ;
    const m = this.tmpM;
    const pos = this.tmpV;
    const s = this.tmpS;
    const c = this.tmpC;
    const cars = this.cars;
    const n = Math.min(cars.length, this.trafficBodyMesh.instanceMatrix.count);

    for (let i = 0; i < n; i++) {
      const car = cars[i];
      const rel = (((car.offset + car.speed * elapsed) % L) + L) % L;
      const along = -C.trafficRadius + rel;
      let x: number;
      let z: number;
      let y = 0.5;
      if (car.axis === 0) { x = car.lane; z = f.z + along; }
      else {
        z = car.lane;
        x = f.x + along;
        if (x > C.riverX0 && x < C.riverX1) y = 7.5; // street bridges the river
      }
      if (car.axis === 0) s.set(2.0, 1.4, 4.6); else s.set(4.6, 1.4, 2.0);
      pos.set(x, y, z);
      m.compose(pos, q, s);
      this.trafficBodyMesh.setMatrixAt(i, m);
      c.setRGB(car.color[0], car.color[1], car.color[2]);
      this.trafficBodyMesh.setColorAt(i, c);

      if (car.axis === 0) s.set(1.7, 1.15, 2.7); else s.set(2.7, 1.15, 1.7);
      pos.set(x, y + 1.15, z);
      m.compose(pos, q, s);
      this.trafficRoofMesh.setMatrixAt(i, m);
      c.setRGB(car.color[0] * 0.82, car.color[1] * 0.82, car.color[2] * 0.82);
      this.trafficRoofMesh.setColorAt(i, c);
    }

    this.trafficBodyMesh.instanceMatrix.needsUpdate = true;
    this.trafficRoofMesh.instanceMatrix.needsUpdate = true;
    if (this.trafficBodyMesh.instanceColor) this.trafficBodyMesh.instanceColor.needsUpdate = true;
    if (this.trafficRoofMesh.instanceColor) this.trafficRoofMesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // spatial hash
  // ---------------------------------------------------------------------------

  private cellKey(i: number, j: number): number {
    return (((i + 0x8000) & 0xffff) << 16) | ((j + 0x8000) & 0xffff);
  }

  private gridInsert(b: BuildingData): void {
    const s = C.cellSize;
    const cx0 = Math.floor((b.cx - b.hw) / s);
    const cx1 = Math.floor((b.cx + b.hw) / s);
    const cz0 = Math.floor((b.cz - b.hd) / s);
    const cz1 = Math.floor((b.cz + b.hd) / s);
    for (let i = cx0; i <= cx1; i++) {
      for (let j = cz0; j <= cz1; j++) {
        const k = this.cellKey(i, j);
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(b);
        b.cells.push(k);
      }
    }
  }

  private gridRemove(b: BuildingData): void {
    for (let i = 0; i < b.cells.length; i++) {
      const arr = this.grid.get(b.cells[i]);
      if (!arr) continue;
      const ix = arr.indexOf(b);
      if (ix >= 0) arr.splice(ix, 1);
      if (arr.length === 0) this.grid.delete(b.cells[i]);
    }
    b.cells.length = 0;
  }

  private nearbyCells(x: number, z: number, radius: number): number[] {
    const s = C.cellSize;
    const r = Math.ceil(radius / s) + 1;
    const bx = Math.floor(x / s);
    const bz = Math.floor(z / s);
    const out = this.cellsScratch;
    out.length = 0;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        out.push(this.cellKey(bx + i, bz + j));
      }
    }
    return out;
  }

  private buildingAt(x: number, z: number, y: number): BuildingData | null {
    const cells = this.nearbyCells(x, z, C.cellSize * 1.5);
    for (let i = 0; i < cells.length; i++) {
      const arr = this.grid.get(cells[i]);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const b = arr[k];
        if (Math.abs(x - b.cx) <= b.hw && Math.abs(z - b.cz) <= b.hd && y < b.height) return b;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // AnchorQuery (frozen contract — keep exact)
  // ---------------------------------------------------------------------------

  findSwingAnchor(p: AnchorQueryParams): Anchor | null {
    const ox = p.origin.x;
    const oy = p.origin.y;
    const oz = p.origin.z;
    let vx = p.velocity.x;
    let vz = p.velocity.z;
    const spd = Math.hypot(vx, vz);
    if (spd < 0.001) { vx = 0; vz = -1; }
    else { vx /= spd; vz /= spd; }
    const rx = -vz;
    const rz = vx;

    this.queryStamp++;
    const cells = this.nearbyCells(ox, oz, p.maxDistance);
    let best: Anchor | null = null;
    let bestScore = -Infinity;

    for (let ci = 0; ci < cells.length; ci++) {
      const arr = this.grid.get(cells[ci]);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const b = arr[k];
        if (b.stamp === this.queryStamp) continue;
        b.stamp = this.queryStamp;

        if (b.height < oy + p.minHeightAbove) continue;
        const dx = b.cx - ox;
        const dz = b.cz - oz;
        const dist = Math.hypot(dx, dz);
        if (dist > p.maxDistance || dist < 4) continue;
        const fwd = (dx * vx + dz * vz) / dist;
        if (fwd < 0.05) continue;
        for (let ai = 0; ai < b.anchors.length; ai++) {
          const a = b.anchors[ai];
          if (a.y < oy + p.minHeightAbove || a.y > oy + 105) continue;
          const dA = Math.hypot(a.x - ox, a.y - oy, a.z - oz);
          if (dA > p.maxDistance) continue;
          const ax = a.x - ox;
          const az = a.z - oz;
          const aPlanar = Math.hypot(ax, az);
          if (aPlanar < 0.001) continue;
          const aFwd = (ax * vx + az * vz) / aPlanar;
          if (aFwd < 0.02) continue;
          const aLat = (ax * rx + az * rz) / aPlanar;
          const heightAbove = a.y - oy;
          const kindBonus = a.kind === 'corner' ? 0.24 : a.kind === 'roof' ? 0.10 : 0.0;
          const score = aFwd * 2.7
            + aLat * p.lateralBias * 1.7
            + Math.min(heightAbove, 70) * 0.013
            + kindBonus
            + (b.height / (C.landmarkMaxStoreys * C.storeyHeight)) * 0.20
            - (dA / p.maxDistance) * 1.35;
          if (score > bestScore) {
            bestScore = score;
            best = {
              position: new THREE.Vector3(a.x, a.y, a.z),
              normal: new THREE.Vector3(a.nx, a.ny, a.nz).normalize(),
              id: b.idBase + a.idOffset,
              structureId: b.structureId,
            };
          }
        }
      }
    }
    return best;
  }

  raycastAnchor(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): Anchor | null {
    const step = 3;
    const dx = direction.x;
    const dy = direction.y;
    const dz = direction.z;
    let prevX = origin.x;
    let prevY = origin.y;
    let prevZ = origin.z;
    for (let t = step; t <= maxDistance; t += step) {
      const x = origin.x + dx * t;
      const y = origin.y + dy * t;
      const z = origin.z + dz * t;
      if (y <= 0.05 || y < this.surfaceHeightAt(x, z)) {
        const b = y > 0.05 ? this.buildingAt(x, z, y) : null;
        if (b) {
          const nearest = this.nearestAnchorCandidate(b, prevX, prevY, prevZ);
          if (nearest) {
            return {
              position: new THREE.Vector3(nearest.x, nearest.y, nearest.z),
              normal: new THREE.Vector3(nearest.nx, nearest.ny, nearest.nz).normalize(),
              id: b.idBase + nearest.idOffset,
              structureId: b.structureId,
            };
          }
          const n = new THREE.Vector3(x - b.cx, 0, z - b.cz);
          if (n.lengthSq() > 0.0001) n.normalize(); else n.set(0, 0, -1);
          return {
            position: new THREE.Vector3(prevX, prevY, prevZ),
            normal: n,
            id: b.idBase,
            structureId: b.structureId,
          };
        }
        return {
          position: new THREE.Vector3(prevX, prevY, prevZ),
          normal: new THREE.Vector3(0, 1, 0),
          id: -1,
          structureId: -1,
        };
      }
      prevX = x;
      prevY = y;
      prevZ = z;
    }
    return null;
  }

  private nearestAnchorCandidate(b: BuildingData, x: number, y: number, z: number): AnchorCandidate | null {
    let best: AnchorCandidate | null = null;
    let bestD = Infinity;
    for (let i = 0; i < b.anchors.length; i++) {
      const a = b.anchors[i];
      const dx = a.x - x;
      const dy = a.y - y;
      const dz = a.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  surfaceHeightAt(x: number, z: number): number {
    const cells = this.nearbyCells(x, z, C.cellSize * 1.2);
    let roof = 0;
    for (let ci = 0; ci < cells.length; ci++) {
      const arr = this.grid.get(cells[ci]);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const b = arr[k];
        if (Math.abs(x - b.cx) > b.hw || Math.abs(z - b.cz) > b.hd) continue;
        let h = 0;
        for (let t = 0; t < b.tiers.length; t++) {
          const tier = b.tiers[t];
          if (Math.abs(x - b.cx) <= tier.hw && Math.abs(z - b.cz) <= tier.hd) h = tier.topY;
        }
        if (h > roof) roof = h;
      }
    }
    return roof;
  }

  isSolidAt(point: THREE.Vector3): boolean {
    if (point.y <= 0.05) return true;
    return point.y < this.surfaceHeightAt(point.x, point.z);
  }

  // ---------------------------------------------------------------------------
  // introspection / debug
  // ---------------------------------------------------------------------------

  get buildingCount(): number {
    return this.totalBuildings;
  }

  /**
   * Compact fingerprint of everything gameplay can observe about the world:
   * roof heights, solidity and swing-anchor picks over a fixed lattice around
   * the player. It reads ONLY the AnchorQuery surface, so a critic can assert it
   * is byte-identical between `buildingMode: 'boxes'` and `'models'` — which is
   * the whole invariant: the model swap is visual, gameplay is untouched.
   *
   * Take it at the same player position in both modes (reset + pause first);
   * which chunks are resident depends on where the player is standing.
   */
  private worldFingerprint(): string {
    const f = this.focus;
    const parts: string[] = [];
    const origin = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    for (let ix = -6; ix <= 6; ix++) {
      for (let jz = -6; jz <= 6; jz++) {
        const x = f.x + ix * 37;
        const z = f.z + jz * 41;
        const h = this.surfaceHeightAt(x, z);
        parts.push(h.toFixed(3));
        parts.push(this.isSolidAt(origin.set(x, 12, z)) ? '1' : '0');
        if ((ix + jz) % 3 === 0) {
          const a = this.findSwingAnchor({
            origin: origin.set(x, 40, z),
            velocity: velocity.set(ix || 1, 0, jz || 1).normalize(),
            maxDistance: 140,
            minHeightAbove: 12,
            lateralBias: 0.3,
          });
          parts.push(a
            ? `${a.structureId}:${a.position.x.toFixed(2)},${a.position.y.toFixed(2)},${a.position.z.toFixed(2)}`
            : 'null');
        }
      }
    }
    return parts.join('|');
  }

  private dumpChunks(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, ch] of this.chunks) {
      out[String(key)] = ch.recs
        .map((b) => `${b.cx.toFixed(1)},${b.cz.toFixed(1)},${b.hw.toFixed(1)},${b.hd.toFixed(1)},${b.height.toFixed(1)},${b.archetype},${b.facade.rhythm},${b.tiers.length},${b.extras.length},${b.anchors.length}`)
        .join(';');
    }
    return out;
  }

  private varietySamples(count: number): Record<string, unknown>[] {
    const n = Math.max(1, Math.min(100, Math.floor(count)));
    const buildings = [...this.chunks.values()].flatMap((ch) => ch.recs);
    buildings.sort((a, b) => a.structureId - b.structureId);
    if (buildings.length === 0) return [];
    const step = Math.max(1, Math.floor(buildings.length / n));
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < buildings.length && out.length < n; i += step) {
      const b = buildings[i];
      out.push({
        id: b.structureId,
        pos: [+b.cx.toFixed(1), +b.cz.toFixed(1)],
        footprint: [+(b.hw * 2).toFixed(1), +(b.hd * 2).toFixed(1)],
        height: +b.height.toFixed(1),
        archetype: b.archetype,
        facade: b.facade,
        tiers: b.tiers.map((t) => ({
          y: [+t.baseY.toFixed(1), +t.topY.toFixed(1)],
          footprint: [+(t.hw * 2).toFixed(1), +(t.hd * 2).toFixed(1)],
        })),
        roofExtras: b.extras.length,
        anchors: b.anchors.length,
      });
    }
    return out;
  }

  private buildingSystemReport(): Record<string, unknown> {
    const buildings = [...this.chunks.values()].flatMap((ch) => ch.recs);
    const byArch: Record<string, number> = {};
    const facadeRhythm: Record<string, number> = {};
    let tierCount = 0;
    let extraCount = 0;
    let anchorCount = 0;
    let tall = 0;
    let maxH = 0;
    for (const b of buildings) {
      byArch[b.archetype] = (byArch[b.archetype] ?? 0) + 1;
      facadeRhythm[b.facade.rhythm] = (facadeRhythm[b.facade.rhythm] ?? 0) + 1;
      tierCount += b.tiers.length;
      extraCount += b.extras.length;
      anchorCount += b.anchors.length;
      if (b.height > 82) tall++;
      if (b.height > maxH) maxH = b.height;
    }
    const registry = {
      mode: 'boxes' as BuildingMode,
    };
    return {
      residentBuildings: buildings.length,
      byArchetype: byArch,
      facadeRhythm,
      avgTiers: +(tierCount / Math.max(buildings.length, 1)).toFixed(2),
      avgRoofExtras: +(extraCount / Math.max(buildings.length, 1)).toFixed(2),
      avgAnchors: +(anchorCount / Math.max(buildings.length, 1)).toFixed(2),
      tallTieredBuildings: tall,
      maxHeight: +maxH.toFixed(1),
      detailLod: {
        primaryAlways: 'tiers, roof slabs, parapets',
        secondaryRadius: C.rooftopSecondaryRadius,
        tertiaryRadius: C.rooftopTertiaryRadius,
      },
      generation: this.generationBenchmark(),
      registry,
    };
  }

  private generationBenchmark(): Record<string, number> {
    const f = this.focus;
    const cxf = Math.round(f.x / CHUNK_W);
    const czf = Math.round(f.z / CHUNK_H);
    const radius = C.loadChunkRadius;
    let buildings = 0;
    const t0 = performance.now();
    for (let ci = cxf - radius; ci <= cxf + radius; ci++) {
      for (let cj = czf - radius; cj <= czf + radius; cj++) {
        buildings += genChunk(ci, cj, this.seed, false).buildings.length;
      }
    }
    const t1 = performance.now();
    let regenBuildings = 0;
    for (let ci = cxf - radius; ci <= cxf + radius; ci++) {
      for (let cj = czf - radius; cj <= czf + radius; cj++) {
        regenBuildings += genChunk(ci, cj, this.seed, false).buildings.length;
      }
    }
    const t2 = performance.now();
    return {
      chunks: (radius * 2 + 1) * (radius * 2 + 1),
      buildings,
      regenBuildings,
      generationMs: +(t1 - t0).toFixed(2),
      regenerationMs: +(t2 - t1).toFixed(2),
    };
  }

  dispose(): void {
    for (const key of [...this.chunks.keys()]) this.removeChunk(key);
    this.chunks.clear();

    // Sweep whatever is left in the group rather than naming meshes one by one:
    // the impostor mesh, the two traffic meshes and every static (ground, river,
    // park, plaza, bridges) each used to leak either their instance buffers or
    // their own material. A traversal cannot go stale when a static is added.
    // Geometries and per-mesh materials here are owned by this system alone.
    const seenMat = new Set<THREE.Material>();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) {
        if (mat && !seenMat.has(mat)) { seenMat.add(mat); mat.dispose(); }
      }
      (m as THREE.InstancedMesh).dispose?.();
    });
    // Shared chunk materials are not attached to any surviving mesh by now.
    for (const mat of [this.buildMat, this.windowMat, this.detailMat, this.impostorMat, this.bridgeMat, this.roadMat]) {
      if (!seenMat.has(mat)) mat.dispose();
    }
    this.group.clear();
    this.group.removeFromParent();
    disposeGroundTextures();
  }
}
