import { inputHandle, type ControlUsage } from '../input/inputHandle';
import { t, type StringTableKey } from '../i18n/i18n';

/**
 * OWNED BY: feel-builder.
 *
 * Integration critique blocker 5: "a new player loads the page and does not
 * know what to press. Controls are documented in AGENTS.md only."
 *
 * A minimal bottom-centre strip of key chips in the same retro monospace the
 * rest of the UI uses. Each chip fades out the first time its control is used,
 * and the whole strip retires once the player has found everything (or after
 * a timeout, so it never becomes furniture).
 *
 * It must never appear in a critic capture. `__GAUNTLET__.setHudVisible(false)`
 * is lead-owned and only touches `#hud`, so rather than ask for a contract
 * change this mirrors that element's visibility every frame — one style read,
 * no core file touched.
 */
interface Chip {
  key: keyof ControlUsage;
  el: HTMLElement;
  gone: boolean;
}

const ROWS: { key: keyof ControlUsage; keys: string; labelKey: StringTableKey }[] = [
  { key: 'look', keys: 'MOUSE', labelKey: 'prompt.look' },
  { key: 'move', keys: 'W A S D', labelKey: 'prompt.steer' },
  { key: 'web', keys: 'HOLD LMB', labelKey: 'prompt.web' },
  { key: 'dash', keys: 'RMB', labelKey: 'prompt.dash' },
  { key: 'jump', keys: 'SPACE', labelKey: 'prompt.launch' },
];

/** Seconds the strip lingers before retiring itself even if unused. */
const LIFETIME = 45;
/** Seconds a chip takes to fade once its control is discovered. */
const FADE = 0.9;

export class ControlPrompt {
  private root = document.createElement('div');
  private chips: Chip[] = [];
  private age = 0;
  private retired = false;
  private lastHidden: boolean | null = null;

  constructor() {
    this.root.id = 'control-prompt';
    Object.assign(this.root.style, {
      position: 'fixed',
      left: '50%',
      bottom: '26px',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '14px',
      zIndex: '9',
      pointerEvents: 'none',
      font: '11px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.14em',
      whiteSpace: 'nowrap',
      // fade the strip in rather than snapping it on at load
      opacity: '0',
      transition: 'opacity 1.2s ease',
    } as Partial<CSSStyleDeclaration>);

    for (const row of ROWS) {
      const el = document.createElement('div');
      Object.assign(el.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        opacity: '1',
        transition: `opacity ${FADE}s ease, transform ${FADE}s ease`,
      } as Partial<CSSStyleDeclaration>);

      const k = document.createElement('span');
      k.textContent = row.keys;
      Object.assign(k.style, {
        color: '#eaf2fb',
        // flat, hard-edged plate: same low-poly-retro register as the HUD
        background: 'rgba(10,14,20,0.55)',
        border: '1px solid rgba(216,226,236,0.35)',
        padding: '4px 7px',
        textShadow: '0 1px 2px #000',
      } as Partial<CSSStyleDeclaration>);

      const l = document.createElement('span');
      l.textContent = t(row.labelKey);
      Object.assign(l.style, {
        color: 'rgba(216,226,236,0.62)',
        textShadow: '0 1px 2px #000',
      } as Partial<CSSStyleDeclaration>);

      el.append(k, l);
      this.root.appendChild(el);
      this.chips.push({ key: row.key, el, gone: false });
    }

    document.body.appendChild(this.root);
    // one frame later so the opacity transition actually runs
    requestAnimationFrame(() => { if (!this.retired) this.root.style.opacity = '1'; });
  }

  update(dt: number): void {
    if (this.retired) return;

    // mirror the debug HUD's visibility so critic captures stay clean
    const hud = document.getElementById('hud');
    const hidden = hud ? hud.style.display === 'none' : false;
    if (hidden !== this.lastHidden) {
      this.root.style.display = hidden ? 'none' : 'flex';
      this.lastHidden = hidden;
    }
    if (hidden) return;

    this.age += dt;

    let remaining = 0;
    for (const c of this.chips) {
      if (c.gone) continue;
      if (inputHandle.used[c.key]) {
        c.gone = true;
        c.el.style.opacity = '0';
        c.el.style.transform = 'translateY(6px)';
      } else remaining++;
    }

    if (remaining === 0 || this.age > LIFETIME) this.retire();
  }

  private retire(): void {
    this.retired = true;
    this.root.style.opacity = '0';
    setTimeout(() => this.root.remove(), 1400);
  }

  dispose(): void {
    this.retired = true;
    this.root.remove();
  }
}
