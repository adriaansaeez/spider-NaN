/**
 * FROZEN — global constants shared across systems. Lead-owned; do not edit.
 * Per-system tuning lives in `src/<system>/tuning.ts`, owned by that system's builder.
 */
export const GLOBALS = {
  /** Deterministic world seed. Same seed MUST produce an identical city. */
  worldSeed: 1337,
  /** Delta clamp — protects the pendulum solve from tab-switch spikes. */
  maxDeltaSeconds: 1 / 20,
  /** Fixed physics substep for the swing solve. */
  fixedStep: 1 / 120,
  /** World units are metres. Street level is y = 0. */
  gravity: -32,
  /** Perf budget the critics enforce. */
  budget: {
    targetFps: 60,
    maxFrameMs: 16.7,
    maxDrawCalls: 220,
    maxTriangles: 900_000,
    maxJsHeapMb: 512,
    maxLoadMs: 3000,
  },
} as const;
