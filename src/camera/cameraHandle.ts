import type * as THREE from 'three';
import type { AnchorQuery } from '../contracts';

/**
 * OWNED BY: feel-builder. A mutable handle CameraSystem fills so FxSystem can
 * place screen-space overlays without either touching Game.ts (lead-owned).
 * Both modules belong to the same owner, so this is internal wiring.
 * The lead (Game.ts) also injects the frozen `AnchorQuery` here so the camera
 * can run its backward-sweep collision probe — the only world coupling the
 * camera ever needs, and it goes through the contract, never through CitySystem.
 */
export const cameraHandle: {
  camera: THREE.PerspectiveCamera | null;
  world: AnchorQuery | null;
  /** Debug: last frame's camera position, look target and smoothed zoom factor
   *  (feel-builder + critics). `zoom` is the eased state-driven boom multiplier;
   *  reading it directly is the only way to see the ease without the collision
   *  sweep and speed terms confounding the raw camera-to-player distance. */
  debug?: { camPos: number[]; look: number[]; zoom: number };
} = {
  camera: null,
  world: null,
  debug: undefined,
};

