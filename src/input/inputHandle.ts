import type { PlayerSnapshot } from '../contracts';

/**
 * OWNED BY: feel-builder. A mutable handle InputSystem fills so the on-screen
 * control prompt (src/fx/ControlPrompt.ts) can tell which affordances the
 * player has already discovered, without either module reaching into Game.ts
 * (lead-owned). Both modules belong to the same owner, so this is internal
 * wiring — exactly like camera/cameraHandle.ts.
 *
 * `used` is only ever set from real human input. Scripted tape playback never
 * marks a control as used, so a critic's capture is unaffected by what the
 * tape happens to press.
 */
export interface ControlUsage {
  look: boolean;
  move: boolean;
  web: boolean;
  dash: boolean;
  jump: boolean;
}

export const inputHandle: {
  /** True once any human key/mouse event has arrived (vs. tape playback). */
  human: boolean;
  /** Last traversal snapshot observed by a feel-owned system. Read next frame by input. */
  player: PlayerSnapshot | null;
  used: ControlUsage;
} = {
  human: false,
  player: null,
  used: { look: false, move: false, web: false, dash: false, jump: false },
};
