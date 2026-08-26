import type { PlayerSnapshot } from '../contracts';

/**
 * OWNED BY: feel-builder.
 *
 * The dash readiness mark. Bright when the dash is available, dropped to the
 * HUD's muted tone with a countdown while it is on cooldown.
 *
 * DESIGN NOTES, because most of this is a decision rather than a default:
 *
 *  - THE MARK IS BARE. No tile, no chip, no rounded square behind it. An icon
 *    parked on a coloured box is the component-kit look; the mark sits directly
 *    on the world.
 *  - IT IS DRAWN FOR THIS MOVE, in this game's own vocabulary — a web line with
 *    a launch tick and a splat node, not an icon-pack arrow. The three rejected
 *    passes and why they failed are recorded where the paths are defined.
 *  - RECHARGE IS A WIPE ALONG THE MARK'S OWN AXIS, driven by a gradient with two
 *    coincident stops. Tail to node, the full track, every time. A gradient stop
 *    cannot round off a stroke cap the way animating a scale does, so the caps
 *    stay round through the whole transition.
 *  - NO GLOW, NO BLOOM, NO HALO. The state is carried by VALUE — bright ink vs
 *    the same muted grey `#score-record` already uses. The only shadow is the
 *    tight, single-direction one the rest of the HUD uses for legibility over a
 *    bright sky, never a soft bloom on all sides.
 *  - THE COUNTDOWN IS WHOLE SECONDS. Tenths need a decimal point, and in a
 *    tabular face the point takes a full digit slot, so "2 . 2" reads as three
 *    characters that fell apart rather than one number. The wipe already carries
 *    the continuous read; the digit only has to say roughly how long.
 *
 * It must never appear in a critic capture, so — exactly like ControlPrompt —
 * it mirrors `#hud`'s visibility rather than asking for a contract change.
 */

/** Ink when the dash is available. Matches `--bright` in index.html. */
const READY_INK = '#f4f7fb';
/** Ink while cooling. Matches `#score-record`, the HUD's existing quiet tone. */
const COOL_INK = '#8fa3b6';
/** Seconds the "just became available" weight snap takes to settle. */
const SNAP_TIME = 0.22;
/** Resting stroke weight, and the extra weight at the peak of that snap. */
const STROKE = 2.6;
/** Weight of the star node's arms. See the note where the paths are defined. */
const STROKE_FINE = 1.7;
const STROKE_SNAP = 0.55;

const SVG_NS = 'http://www.w3.org/2000/svg';

export class DashHud {
  private readonly root = document.createElement('div');
  private readonly countEl = document.createElement('div');
  private readonly strokes: SVGPathElement[] = [];
  /** Resting weight per stroke, so the snap scales them proportionally rather
   *  than flattening the line and the node to one width. */
  private readonly baseWidths: number[] = [];
  private readonly stopMidA = document.createElementNS(SVG_NS, 'stop');
  private readonly stopMidB = document.createElementNS(SVG_NS, 'stop');

  /** Last wipe position written to the DOM, so we only touch it when it moves. */
  private lastFill = -1;
  private lastCount = '';
  private lastHidden: boolean | null = null;
  private wasReady = true;
  private snap = 0;
  private lastStroke = -1;
  private suspended = false;

  constructor() {
    this.root.id = 'dash-hud';
    Object.assign(this.root.style, {
      position: 'fixed',
      // Mirrors #score-record in the opposite corner, on the same gutter, so the
      // two bottom corners balance instead of one element floating alone.
      left: '12px',
      bottom: '10px',
      zIndex: '9',
      // MANDATORY: a fixed overlay with pointer events eats the click that
      // acquires pointer lock (see the note in index.html).
      pointerEvents: 'none',
      display: 'flex',
      alignItems: 'center',
      gap: '11px',
    } as Partial<CSSStyleDeclaration>);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('width', '34');
    svg.setAttribute('height', '34');
    svg.setAttribute('aria-hidden', 'true');
    // Tight, low-offset, single-direction. Not a bloom.
    svg.style.filter = 'drop-shadow(0 1px 1px rgba(0, 0, 0, .6))';
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    const defs = document.createElementNS(SVG_NS, 'defs');
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', 'dash-hud-wipe');
    // Along the mark's own axis, from the launch tick past the FAR SIDE of the
    // node. It has to run past the node, not to it: a linear gradient pads with
    // its last stop beyond the end point, so an arm sticking out past (24.5,
    // 7.5) rendered in the cooling grey even when the dash was fully available.
    // The end point is set to the furthest any arm projects onto this axis.
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', '3.5');
    grad.setAttribute('y1', '28.5');
    grad.setAttribute('x2', '27.6');
    grad.setAttribute('y2', '4.4');
    const stopA = document.createElementNS(SVG_NS, 'stop');
    stopA.setAttribute('offset', '0');
    stopA.setAttribute('stop-color', READY_INK);
    this.stopMidA.setAttribute('offset', '1');
    this.stopMidA.setAttribute('stop-color', READY_INK);
    this.stopMidB.setAttribute('offset', '1');
    this.stopMidB.setAttribute('stop-color', COOL_INK);
    const stopD = document.createElementNS(SVG_NS, 'stop');
    stopD.setAttribute('offset', '1');
    stopD.setAttribute('stop-color', COOL_INK);
    grad.append(stopA, this.stopMidA, this.stopMidB, stopD);
    defs.appendChild(grad);
    svg.appendChild(defs);

    // A LINE THAT STICKS, not an arrow.
    //
    // Three passes, and the two rejected ones are worth recording so nobody
    // walks back into them:
    //   1. A diagonal arrow with a dashed tail. Clean, and it could have sat on
    //      any other product unchanged — which is the definition of the problem.
    //   2. Strands radiating from the tip. They form a chevron that opens
    //      BACKWARDS, so it read as a broken arrow pointing the wrong way. A
    //      forward-opening fork fixed the direction but read as a tuning fork.
    //
    // What it is now is the game's own vocabulary rather than an icon idiom:
    //   - a short detached launch tick, the line leaving the hand,
    //   - a gap, then the taut shaft,
    //   - and a small STAR NODE at the far end: three short strokes crossing
    //     THROUGH the contact point, the way a web reads once it has splatted
    //     onto a wall. Crossing through rather than radiating out is the whole
    //     difference — a node has no direction, so it cannot be misread as a
    //     head. None of the three sits on the shaft's own 45-degree axis, and
    //     their angles (0, 70, 125 deg) are deliberately uneven, so the node is
    //     drawn rather than a rotated symmetric asterisk.
    const paths = [
      // launch tick, gap, then the shaft running all the way into the contact
      { d: 'M3.5 28.5 L7 25', w: STROKE },
      { d: 'M9.5 23 L24.5 7.5', w: STROKE },
      // The star node at (24.5, 7.5): three strokes crossing through it at 0,
      // 70 and 125 deg. FINER than the line on purpose — at this size the same
      // weight packs the arms into a lump and the mark reads as a mallet. A
      // splat is lighter than the line that made it.
      { d: 'M20.1 7.5 L28.9 7.5', w: STROKE_FINE },
      { d: 'M22.995 11.636 L26.005 3.364', w: STROKE_FINE },
      { d: 'M27.026 11.104 L21.974 3.896', w: STROKE_FINE },
    ];
    for (const { d, w } of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'url(#dash-hud-wipe)');
      path.setAttribute('stroke-width', String(w));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      this.strokes.push(path);
      this.baseWidths.push(w);
    }

    Object.assign(this.countEl.style, {
      font: "500 16px/1 'Tabular', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0.04em',
      color: COOL_INK,
      textShadow: '0 1px 2px #000',
      // Reserve the slot so the mark never shifts sideways as the digit changes.
      minWidth: '11px',
      // Content is VISIBLE BY DEFAULT: this starts empty because the dash starts
      // ready, not because an animation has yet to reveal it.
      visibility: 'hidden',
    } as Partial<CSSStyleDeclaration>);

    this.root.append(svg, this.countEl);
    document.body.appendChild(this.root);
  }

  /** Hide while the title screen owns the frame — same contract as ControlPrompt. */
  setSuspended(on: boolean): void {
    if (this.suspended === on) return;
    this.suspended = on;
    if (on) this.root.style.display = 'none';
    else { this.lastHidden = null; this.root.style.display = 'flex'; }
  }

  update(p: PlayerSnapshot, dt: number): void {
    if (this.suspended) return;

    // Mirror the debug HUD's visibility so critic captures stay clean.
    const hud = document.getElementById('hud');
    const hidden = hud ? hud.style.display === 'none' : false;
    if (hidden !== this.lastHidden) {
      this.root.style.display = hidden ? 'none' : 'flex';
      this.lastHidden = hidden;
    }
    if (hidden) return;

    const total = p.dashCooldownTotal > 0 ? p.dashCooldownTotal : 1;
    const remaining = Math.max(0, p.dashCooldown);
    const ready = remaining <= 0;
    // 0 the instant the dash fires, 1 when it is back. The wipe travels tail to
    // tip over the whole cooldown, and always finishes its track.
    const fill = ready ? 1 : Math.min(1, Math.max(0, 1 - remaining / total));

    if (Math.abs(fill - this.lastFill) > 0.004 || (ready && this.lastFill !== 1)) {
      const o = fill.toFixed(3);
      this.stopMidA.setAttribute('offset', o);
      this.stopMidB.setAttribute('offset', o);
      this.lastFill = fill;
    }

    // A weight snap on the frame it comes back: a beat you feel, with no glow
    // and no bounce. Skipped entirely when the player has asked for less motion.
    if (ready && !this.wasReady && !prefersReducedMotion()) this.snap = SNAP_TIME;
    this.wasReady = ready;
    if (this.snap > 0) this.snap = Math.max(0, this.snap - dt);
    // Ease out, so it settles rather than stopping dead.
    const k = this.snap / SNAP_TIME;
    const gain = 1 + (STROKE_SNAP / STROKE) * k * k;
    if (Math.abs(gain - this.lastStroke) > 0.004) {
      for (let i = 0; i < this.strokes.length; i++) {
        this.strokes[i].setAttribute('stroke-width', (this.baseWidths[i] * gain).toFixed(2));
      }
      this.lastStroke = gain;
    }

    // WHOLE SECONDS, not tenths. A tenth needs a decimal point, and in a tabular
    // face the point takes a full digit slot — "2 . 2" reads as three characters
    // that fell apart rather than one number. The continuous read is the wipe's
    // job anyway; the digit only has to say roughly how long.
    const text = ready ? '' : String(Math.ceil(remaining));
    if (text !== this.lastCount) {
      this.countEl.textContent = text;
      this.countEl.style.visibility = text ? 'visible' : 'hidden';
      this.lastCount = text;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
