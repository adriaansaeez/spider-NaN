/**
 * Entry point. The device guard decides whether this browser can play at all
 * BEFORE the engine is pulled in: `main.ts` (and with it three.js) lives behind
 * a dynamic import, so a phone downloads the blocker and nothing else.
 */
import { blockUnsupportedDevice } from './core/DeviceGuard';

if (!blockUnsupportedDevice()) {
  void import('./main');
}
