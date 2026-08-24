/**
 * OWNED BY: city-builder. Only the city builder edits this file.
 *
 * All units are metres; world Y is up and street level is y = 0.
 * Every constant here feeds deterministic generation keyed on GLOBALS.worldSeed.
 *
 * Proportions follow docs/VISUAL_SPEC.md "City Density and Scale":
 *  - block size ~72 m, road width ~18 m, sidewalk ~5 m
 *  - facade offset from travel centreline ~14 m
 */
export const CITY_TUNING = {
  // --- street grid ----------------------------------------------------------
  /** Mean centre-to-centre spacing of north-south avenues. */
  avenueSpacing: 85,
  /** Per-avenue jitter so block sizes vary while avenues stay long + straight. */
  avenueJitter: 10,
  /** Road surface width of an avenue. */
  avenueWidth: 22,
  /** Mean centre-to-centre spacing of east-west streets. */
  streetSpacing: 75,
  /** Per-street jitter. */
  streetJitter: 8,
  /** Road surface width of a street. */
  streetWidth: 16,
  /** Setback between the road edge and building footprints. */
  sidewalk: 5,

  // --- chunking / streaming -------------------------------------------------
  /** A chunk is this many block cells per side. */
  blocksPerChunkI: 3,
  blocksPerChunkJ: 3,
  /** Full-detail chunks are streamed within this radius of the player's chunk. */
  loadChunkRadius: 2,
  /** Impostor (silhouette) chunks are streamed within this radius. */
  impostorChunkRadius: 4,
  /** Impostor capacity — one silhouette box per building, capped well above the ring. */
  impostorCapacity: 8192,
  /** Anchor-query spatial hash cell size. */
  cellSize: 60,

  // --- height zoning (storey-based) -------------------------------------------
  /** One storey, metres (VISUAL_SPEC storey convention). */
  storeyHeight: 3.5,
  /**
   * Floor on a building's storey count, applied after `heightScale`.
   *
   * TRAVERSAL CONSTRAINT, not an art choice. A building's highest anchor is its
   * roof anchor at `topY + 1.6` (gen.ts buildAnchors), so building height is what
   * decides whether a street-level web press finds anything to hang from. The low
   * bin used to start at 2 storeys and `heightScale` could take that to 0.8x, so
   * the shortest buildings in the city were 7 m — and whole low-rise districts had
   * nothing legal to swing from. The traversal side sizes its street-level gates
   * off a 12 m smallest usable building (swing/tuning.ts groundPullMinRope); 4
   * storeys = 14 m clears that by 2 m.
   *
   * DOUBLED TWICE at the owner's request: 4 -> 8 -> 16. The shortest building in
   * the city is now 56 m, up from the original 14 m.
   *
   * This is well past a traversal constraint now — the 12 m street-level web gate
   * is cleared by 44 m — so the number is an ART decision, not a physics one. Two
   * consequences worth knowing: the low bin (16-19 storeys) now sits INSIDE the
   * "tall" bin's 15-35 range, so three of the four VISUAL_SPEC bins have merged
   * into one population, and the city no longer has a low-rise band at all.
   *
   * The other three bins (6-14 / 15-35 / 36-70) are untouched as written, but the
   * post-scale `Math.max` floor lifts every draw below 16 up to 16, so the 6-14
   * bin no longer produces anything below 16 either.
   */
  minStoreys: 20,
  /**
   * Storey cap for the `low-rise-service` archetype (storefronts, sheds, depots).
   *
   * Tracks `minStoreys`: 9 -> 13 -> 21. A cap BELOW the floor is degenerate —
   * `Math.max(min, Math.min(draw, cap))` collapses to the floor and the whole
   * archetype becomes one height — so this has to move every time the floor does.
   * 21 keeps the ~6-value span the original 9 gave above a 2-4 storey floor.
   *
   * The civic cap (24, still inline in gen.ts) is now only 8 storeys above the
   * floor and is heading the same way; the landmark cap (70) is unaffected.
   */
  serviceMaxStoreys: 26,
  /** Downtown core centre (near the player spawn) — dense tower cluster. */
  coreX: 0,
  coreZ: 0,
  /** Radial falloff of the core, metres. */
  coreRadius: 950,
  /** Tallest allowed landmark, storeys. 70 storeys * 3.5 m = 245 m. */
  landmarkMaxStoreys: 88,
  /** Value-noise cell for district blobs on top of the radial core. */
  districtCell: 760,

  // --- landmarks -------------------------------------------------------------
  /** Central-park-style green block, for orientation. */
  park: { x0: 560, x1: 1080, z0: -760, z1: -240 },
  /** Guaranteed building-free plaza at the spawn so the player is never born
   *  inside a tower (spawn lives near (45, 220, 45) in the traversal system).
   *  Sized to exactly cover block (0,0) for the current grid/jitter. */
  spawnPlaza: { x0: 0, x1: 88, z0: 0, z1: 75 },
  /** River runs north-south as a building-free strip west of the core. */
  riverX0: -2060,
  riverX1: -1480,
  /** Decorative bridge decks crossing the river (street traffic also bridges it). */
  bridgeZs: [-640, 160, 860],

  // --- traffic ----------------------------------------------------------------
  /** Cars are simulated within this radius of the player and wrap around it.
   *  Radius * 2 / carsPerLane = mean spacing (~1 car/54 m at carsPerLane 26). */
  trafficRadius: 700,
  /** Moving cars per lane (~1 per 54 m on a 1400 m lane). */
  carsPerLane: 26,
  carSpeedMin: 16,
  carSpeedMax: 30,

  // --- building visuals -------------------------------------------------------
  /**
   * The city renders buildings exclusively as procedural stacked-setback boxes
   * generated in gen.ts, with window grids and emissive night lighting.
   *
   * An authored GLB building set (`buildings.glb`) was used historically but is
   * now retired — the game ships only its own procedural buildings. Anchors,
   * surfaceHeightAt, isSolidAt and the spatial hash all read BuildingData, never
   * the mesh. The `__GAUNTLET__.setBuildingMode` API is retained as a no-op for
   * harness compatibility; it always reports 'boxes'.
   */
  buildingMode: 'boxes' as 'boxes' | 'models',

  // --- facade window grid ------------------------------------------------------
  /**
   * A window band is a single collar box wrapping all four faces of a tier, which
   * is why towers used to read as panoramic ribbons rather than as buildings with
   * windows. The grid is made by CUTTING those bands with vertical wall piers on
   * the bay pitch (`FacadeProfile.bayWidth`) instead of by emitting one box per
   * window — a 40 m tower at bayWidth 3.6 carries ~11 windows a face and up to 40
   * rows, i.e. ~1700 boxes where the band scheme uses 40.
   *
   * A pier spans a whole tier vertically and the whole building horizontally, so
   * ONE instance cuts every row on TWO opposite faces at once: the whole grid
   * costs (baysX-1)+(baysZ-1) instances per tier, ~12-30 for a tower, and the
   * openings left between piers and bands are the rectangular windows.
   */
  /** How far a pier stands off its wall. Must exceed the band standoff (0.08 m)
   *  or the band would z-fight the pier instead of being cut by it. */
  windowPierStandoff: 0.18,
  /** Pier width as a fraction of the bay. The remainder is the window opening,
   *  so 0.26 leaves a window ~2.7 m wide in a 3.6 m residential bay. */
  windowPierFraction: 0.26,
  windowPierMinWidth: 0.7,
  windowPierMaxWidth: 1.8,
  /**
   * Hard cap on piers per building, the horizontal counterpart of MAX_BANDS.
   *
   * The tallest landmark in the seed-1337 ring wants 85 across its four tiers
   * (46 m square, 2.8 m bays). At 40 it was starved: the first tier ate the
   * budget and the upper tiers plus one whole face pair kept unbroken ribbons,
   * which is visible as a half-gridded tower in
   * .scratch/win-grid/crop_med.png. 96 clears every building in the ring, and
   * `planWindowGrid` coarsens the whole building evenly if anything ever exceeds
   * it. Cost of the difference: ~800 box instances over the resident ring, ~10k
   * triangles.
   */
  windowGridMaxPiers: 96,
  /**
   * Buildings shorter than this keep plain horizontal bands with no vertical
   * piers, so their facades read as ribbons rather than as a grid of windows.
   *
   * This is now the ONLY gate on the pier grid. It used to be ANDed with
   * `REVEAL_AS_EXTRA_HEIGHT` in gen.ts, because a short building could be swapped
   * for an authored GLB mesh that the piers would not sit flush against. That
   * building set has been retired — `CitySystem.setBuildingMode` is a no-op that
   * always returns 'boxes' — so every building is the procedural box the piers
   * were measured against and the two tests no longer have to agree.
   *
   * 90 was therefore doing real damage: a 60 m mid-rise got neither a pier grid
   * NOR (before the coverage fix) a band on every row, so it read as a grey slab
   * with a couple of random stripes. 35 m ~= 10 storeys is the point where a
   * facade is tall enough that a ribbon reads as wrong; below it the low-rise
   * storefront look is what the wide-panel rhythm is for.
   *
   * Cost, measured over a 7x7 chunk sample: 90 -> 35 adds ~5.9k box instances
   * (~71k triangles) to that sample; on the resident city the harness measured
   * 216k -> 265k triangles against a 900k budget.
   */
  windowGridMinHeight: 35,

  // --- procedural building detail LOD ----------------------------------------
  /**
   * Tertiary rooftop pieces: vents, antenna tips and tiny sheds.
   *
   * Was 180 m, which is shorter than a single swing arc — so the rooftop you are
   * aiming your next swing at was exactly the one whose detail had just been
   * culled, and a 210 m tower ~190 m away rendered as a parapet plus two boxes.
   * This is close to free: culled extras are written as zero-scale instances
   * rather than removed, so the instance count (and therefore the reported
   * triangle count) does not change with the radius — only rasterisation does.
   */
  rooftopTertiaryRadius: 330,
  /** Secondary rooftop pieces: access sheds, water tanks and larger HVAC boxes. */
  rooftopSecondaryRadius: 480,
  /** Re-evaluate procedural rooftop/detail LOD after the player moves this far. */
  rooftopLodRepoll: 12,
} as const;
