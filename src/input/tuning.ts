/** OWNED BY: feel-builder. Only the feel builder edits this file. */
export const INPUT_TUNING = {
  /** Seconds a web press stays "alive" so a slightly-early attach still fires. */
  swingBufferTime: 0.12,
  /** Seconds a jump press stays alive after the edge (coyote + early input). */
  jumpBufferTime: 0.1,
  /** Seconds a dash press stays alive. */
  dashBufferTime: 0.08,
  /** Beginner safety: briefly synthesize held web when a new player only holds forward. */
  introAutoWebDelay: 3.0,
  /** Seconds after reset/load that the beginner safety can run. */
  introAutoWebDuration: 45,

  // --- gamepad -------------------------------------------------------------
  /** Radial deadzone below which stick values are treated as zero. */
  stickDeadzone: 0.18,
  /** Look-turn rate (rad/s) at full right-stick deflection. */
  padLookRate: 2.6,
  /** Index of the mapping used for button/axis reads (standard layout). */
  mapping: 'standard',
} as const;
