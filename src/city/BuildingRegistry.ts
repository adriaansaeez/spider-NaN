/**
 * OWNED BY: city-builder.
 *
 * Archetype classification for procedural building generation. Each generated
 * building receives one of these archetypes, which drives facade profiles,
 * height distributions, and tier generation in gen.ts.
 *
 * The authored GLB asset registry that previously lived here has been retired —
 * see docs/buildings/ASSET_ANALYSIS.md for the historical analysis.
 */

export type BuildingArchetype =
  | 'residential-mixed-use'
  | 'office-commercial'
  | 'low-rise-service'
  | 'civic-institutional';
