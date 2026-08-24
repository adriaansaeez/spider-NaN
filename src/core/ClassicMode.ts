/**
 * "Modo clásico" — the single source of truth for the classic/retro look.
 *
 * WHAT IT IS. An ADDITIVE, runtime-toggleable visual mode that restores the
 * game's INITIAL look (phase 1, see captures/2026-08-08T16-08-48Z/shots/hero.png):
 *
 *   1. procedural sky only          — SkyDome drops the photographic plates
 *   2. no distance fog              — DayNightSystem parks the fog planes past the far plane
 *   3. no dynamic shadows           — DayNightSystem stops the sun casting
 *   4. flat ground                  — GroundMaterials drops the asphalt/pavement textures
 *   5. procedural hero              — FxSystem forces characterMode 'procedural'
 *
 * DEFAULT OFF. With nothing stored and nothing called, boot is byte-for-byte
 * the behaviour of the current look — every consumer below reads `isClassic()`
 * at construction, and `false` means "do nothing at all".
 *
 * WHY A MODULE AND NOT A GAME FIELD. The five consumers live in four systems
 * that are constructed in an order the toggle must not depend on, and the
 * toggle has three entry points (localStorage on boot, the Settings panel, and
 * `__GAUNTLET__.setClassicMode` for critics). One module with one flag and a
 * subscriber list is the smallest thing that makes all three agree.
 *
 * Nothing here touches WORLD GENERATION: every consumer swaps materials or
 * uniforms only, so the same `worldSeed` still produces an identical city.
 * Classic mode is also strictly CHEAPER than the current look (fewer texture
 * samples, no shadow pass, no fog term), never more expensive.
 */

const STORAGE_KEY = 'gauntlet.classicMode';

type ClassicListener = (on: boolean) => void;

const listeners = new Set<ClassicListener>();

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Storage can be unavailable in private or embedded contexts.
    return false;
  }
}

/** Read once at module load so systems see the right value in their constructors. */
let enabled = readStored();

/** Is the classic look active right now? */
export function isClassicMode(): boolean {
  return enabled;
}

/**
 * Turn the classic look on or off and notify every consumer. Idempotent, and
 * safe to call before or after the systems exist. Returns the applied state.
 */
export function setClassicMode(on: boolean): boolean {
  const next = !!on;
  if (next === enabled) return enabled;
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
  for (const fn of listeners) fn(enabled);
  return enabled;
}

/**
 * Subscribe to changes. Does NOT fire immediately — a consumer applies the
 * current value itself at construction, which keeps "what boot looks like" and
 * "what a toggle does" the same single code path in each system.
 *
 * Returns an unsubscribe function.
 */
export function onClassicModeChange(fn: ClassicListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
