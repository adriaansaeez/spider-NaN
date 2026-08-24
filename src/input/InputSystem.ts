import type { InputSnapshot, System, UpdateContext } from '../contracts';
import type { TapeEntry } from '../core/Telemetry';
import { INPUT_TUNING as T } from './tuning';
import { inputHandle } from './inputHandle';

/**
 * OWNER: feel-builder (camera/fx/input).
 * Reads keyboard+mouse OR a scripted tape. The tape path is what lets critics
 * capture reproducible gameplay headlessly — keep it working EXACTLY as is.
 *
 * Human-path improvements:
 *  - input buffering: a web/dash/jump press stays alive briefly so a slightly
 *    early input still registers (attach/coyote/zip feel)
 *  - gamepad support with radial deadzones (standard mapping)
 */
export class InputSystem implements System {
  readonly state: InputSnapshot = {
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
    swing: false, swingPressed: false, swingReleased: false,
    dashPressed: false, dive: false, jumpPressed: false,
  };

  private keys = new Set<string>();
  private prevSwing = false;
  private pendingDash = false;
  private pendingJump = false;
  private introElapsed = 0;
  private tapeHasAction = false;
  private accumLookX = 0;
  private accumLookY = 0;
  private mouseDown = false;

  // buffering timers (seconds remaining)
  private swingBuf = 0;
  private dashBuf = 0;
  private jumpBuf = 0;

  // gamepad edge detection
  private prevPadDash = false;
  private prevPadJump = false;

  private tape: TapeEntry[] | null = null;
  private tapeIndex = 0;
  private tapeElapsed = 0;
  private tapeResolve: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('mousedown', this.onMouseDown);
    addEventListener('mouseup', this.onMouseUp);
    addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Mark an affordance discovered. Human input only — never tape playback. */
  private discovered(k: keyof typeof inputHandle.used) {
    inputHandle.human = true;
    inputHandle.used[k] = true;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.tape) return;
    this.keys.add(e.code);
    if (e.code === 'ShiftLeft') { this.pendingDash = true; this.discovered('dash'); }
    if (e.code === 'Space') { this.pendingJump = true; this.discovered('jump'); }
    if (e.code === 'KeyE') this.discovered('web');
    if (e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD') {
      this.discovered('move');
    }
  };
  private onKeyUp = (e: KeyboardEvent) => { if (!this.tape) this.keys.delete(e.code); };
  private onClick = () => {
    if (this.tape) return;
    inputHandle.human = true;
    const lock = this.canvas.requestPointerLock?.() as Promise<void> | void;
    if (lock && typeof lock.catch === 'function') void lock.catch(() => {});
  };
  private onMouseDown = (e: MouseEvent) => {
    if (this.tape) return;
    if (e.button === 0) {
      if (document.pointerLockElement !== this.canvas) {
        inputHandle.human = true;
        return;
      }
      this.mouseDown = true;
      this.discovered('web');
    }
    if (e.button === 2) { this.pendingDash = true; this.discovered('dash'); }
  };
  private onMouseUp = (e: MouseEvent) => { if (!this.tape && e.button === 0) this.mouseDown = false; };
  private onMouseMove = (e: MouseEvent) => {
    if (this.tape || document.pointerLockElement !== this.canvas) return;
    this.accumLookX += e.movementX * 0.0022;
    this.accumLookY += e.movementY * 0.0022;
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) this.discovered('look');
  };

  playTape(tape: TapeEntry[]): Promise<void> {
    this.tape = tape;
    this.tapeIndex = 0;
    this.tapeElapsed = 0;
    this.introElapsed = 0;
    this.tapeHasAction = tape.some((e) => !!(e.swing || e.dash || e.jump));
    return new Promise((res) => { this.tapeResolve = res; });
  }

  private readGamepad() {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected && (p.mapping === T.mapping || !p.axes?.length)) return p;
    }
    return null;
  }

  private applyDeadzone(v: number): number {
    const m = Math.abs(v);
    if (m < T.stickDeadzone) return 0;
    const t = (m - T.stickDeadzone) / (1 - T.stickDeadzone);
    return Math.sign(v) * t;
  }

  private btn(pad: Gamepad | null, i: number): boolean {
    return pad?.buttons?.[i]?.pressed ?? false;
  }

  update(ctx: UpdateContext): void {
    const s = this.state;
    if (this.tape) {
      this.introElapsed += ctx.dt;
      this.tapeElapsed += ctx.dt * 1000;
      let e = this.tape[this.tapeIndex];
      while (e && this.tapeElapsed >= e.ms) {
        this.tapeElapsed -= e.ms;
        this.tapeIndex++;
        e = this.tape[this.tapeIndex];
      }
      if (!e) {
        this.tape = null;
        this.tapeResolve?.();
        this.tapeResolve = null;
        this.zero();
        return;
      }
      const wasSwing = this.prevSwing;
      s.moveX = e.moveX ?? 0; s.moveY = e.moveY ?? 0;
      s.lookX = (e.lookX ?? 0) * ctx.dt; s.lookY = (e.lookY ?? 0) * ctx.dt;
      const autoWeb = !this.tapeHasAction && this.introAutoWebWants(s.moveY);
      s.swing = !!e.swing || autoWeb;
      s.swingPressed = s.swing && !wasSwing;
      s.swingReleased = !s.swing && wasSwing;
      s.dashPressed = !!e.dash;
      s.dive = !!e.dive;
      s.jumpPressed = !!e.jump;
      this.prevSwing = s.swing;
      return;
    }

    this.introElapsed += ctx.dt;
    const k = this.keys;
    const pad = this.readGamepad();

    // --- analog move from keyboard + gamepad (merged, clamped) ---
    let mx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    let my = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    if (pad) {
      mx += this.applyDeadzone(pad.axes[0] ?? 0);
      my += -this.applyDeadzone(pad.axes[1] ?? 0);
    }
    s.moveX = Math.max(-1, Math.min(1, mx));
    s.moveY = Math.max(-1, Math.min(1, my));
    if (pad && (Math.abs(s.moveX) > 0.2 || Math.abs(s.moveY) > 0.2)) this.discovered('move');

    // --- look: mouse accum + gamepad stick (rad/s) ---
    let lx = this.accumLookX;
    let ly = this.accumLookY;
    if (pad) {
      lx += this.applyDeadzone(pad.axes[2] ?? 0) * T.padLookRate * ctx.dt;
      ly += this.applyDeadzone(pad.axes[3] ?? 0) * T.padLookRate * ctx.dt;
    }
    s.lookX = lx; s.lookY = ly;
    this.accumLookX = 0; this.accumLookY = 0;

    // --- swing (hold) + buffered press edge ---
    let swing = this.mouseDown || k.has('KeyE');
    if (pad && (this.btn(pad, 7) || this.btn(pad, 5))) { swing = true; this.discovered('web'); } // RT or RB
    if (pad && Math.abs(pad.axes[2] ?? 0) + Math.abs(pad.axes[3] ?? 0) > 0.4) this.discovered('look');
    if (!swing && this.introAutoWebWants(s.moveY)) swing = true;
    const rising = swing && !this.prevSwing;
    const falling = !swing && this.prevSwing;
    this.prevSwing = swing;
    s.swing = swing;
    if (rising) this.swingBuf = T.swingBufferTime;
    if (falling) this.swingBuf = 0;
    this.swingBuf = Math.max(0, this.swingBuf - ctx.dt);
    s.swingPressed = rising || this.swingBuf > 0;
    s.swingReleased = falling;

    // --- dash buffered edge ---
    let dash = this.pendingDash;
    if (pad && this.btn(pad, 1) && !this.prevPadDash) { dash = true; this.discovered('dash'); } // B
    this.prevPadDash = this.btn(pad, 1);
    if (dash) this.dashBuf = T.dashBufferTime;
    this.dashBuf = Math.max(0, this.dashBuf - ctx.dt);
    s.dashPressed = dash || this.dashBuf > 0;
    this.pendingDash = false;

    // --- jump buffered edge (coyote feel) ---
    let jump = this.pendingJump;
    if (pad && this.btn(pad, 0) && !this.prevPadJump) { jump = true; this.discovered('jump'); } // A
    this.prevPadJump = this.btn(pad, 0);
    if (jump) this.jumpBuf = T.jumpBufferTime;
    this.jumpBuf = Math.max(0, this.jumpBuf - ctx.dt);
    s.jumpPressed = jump || this.jumpBuf > 0;
    this.pendingJump = false;

    // --- dive ---
    s.dive = k.has('KeyS') || k.has('ControlLeft');
    if (pad) s.dive = s.dive || this.btn(pad, 6); // LT
  }

  private zero() {
    const s = this.state;
    s.moveX = s.moveY = s.lookX = s.lookY = 0;
    s.swing = s.swingPressed = s.swingReleased = false;
    s.dashPressed = s.dive = s.jumpPressed = false;
    this.prevSwing = false;
    this.swingBuf = this.dashBuf = this.jumpBuf = 0;
    this.prevPadDash = this.prevPadJump = false;
  }

  /** Beginner safety: synthesize held WEB (not jump) while a novice only holds forward. */
  private introAutoWebWants(moveY: number): boolean {
    return moveY > 0.35
      && this.introElapsed >= T.introAutoWebDelay
      && this.introElapsed <= T.introAutoWebDuration
      && !inputHandle.used.web
      && !inputHandle.used.dash
      && !inputHandle.used.jump;
  }

  dispose() {
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('mouseup', this.onMouseUp);
    removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('click', this.onClick);
  }
}
