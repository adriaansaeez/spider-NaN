/**
 * Pre-boot device guard.
 *
 * The game is mouse + keyboard only: it takes pointer lock, steers with the
 * mouse and moves with WASD. There are no touch controls, so on a phone or a
 * tablet the honest thing is to say so instead of booting an engine that
 * cannot be played. This module runs BEFORE `main.ts` is imported (see
 * `boot.ts`), so on a blocked device three.js is never even downloaded.
 */
import { EN, TABLES, type Lang, type StringTable } from '../i18n/strings';
import { getLanguage, hasStoredLanguage } from '../i18n/i18n';

/** Where the blocker sends the player: the presentation site at the root. */
const PRESENTATION_URL = '/';

/**
 * The language for a screen that renders before any menu exists. The player's
 * own choice wins; otherwise follow the browser, because the site this page is
 * linked from is Spanish-first.
 */
function blockerLanguage(): Lang {
  if (hasStoredLanguage()) return getLanguage();
  return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/**
 * Touch-only device: a coarse primary pointer (or no hover at all) and no fine
 * pointer anywhere. A tablet with a mouse attached reports `pointer: fine` on
 * `any-pointer`, so it is let through — the check is about capability, not
 * about the user agent string.
 */
function isTouchOnlyDevice(): boolean {
  if (typeof matchMedia !== 'function') return false;

  const coarse = matchMedia('(pointer: coarse)').matches;
  const noHover = matchMedia('(hover: none)').matches;
  const anyFine = matchMedia('(any-pointer: fine)').matches;
  const anyHover = matchMedia('(any-hover: hover)').matches;
  const touch = (navigator.maxTouchPoints ?? 0) > 0;

  return touch && (coarse || noHover) && !anyFine && !anyHover;
}

/** Whether the browser can hand out the context the renderer needs. */
function hasWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    return !!(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    return false;
  }
}

function css(): string {
  return `
    #device-blocker {
      position: fixed; inset: 0; z-index: 100; display: grid; place-items: center;
      padding: 24px; background: #0b0e13; color: #d8e2ec;
      font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #device-blocker .blocker-panel {
      width: min(460px, 100%); padding: 26px;
      background: rgba(14, 20, 28, .92); border: 1px solid rgba(216, 226, 236, .28);
      box-shadow: 0 18px 54px rgba(0, 0, 0, .45); text-align: left;
    }
    #device-blocker .blocker-brand {
      margin: 0 0 4px; font-size: 24px; font-weight: 700; color: #f4f7fb; letter-spacing: 1px;
    }
    #device-blocker h1 { margin: 0 0 14px; font-size: 15px; font-weight: 700; color: #7aa2ff; }
    #device-blocker p { margin: 0 0 22px; color: #b6c4d2; }
    #device-blocker a {
      display: inline-block; padding: 11px 18px;
      border: 1px solid rgba(216, 226, 236, .34); border-radius: 4px;
      background: #151d27; color: #d8e2ec; text-decoration: none; font: inherit;
    }
    #device-blocker a:hover, #device-blocker a:focus-visible { background: #203144; border-color: #d8e2ec; }
  `;
}

function render(heading: string, body: string, back: string, lang: Lang): void {
  document.documentElement.lang = lang;

  const style = document.createElement('style');
  style.textContent = css();
  document.head.append(style);

  const overlay = document.createElement('div');
  overlay.id = 'device-blocker';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-labelledby', 'blocker-heading');

  const panel = document.createElement('div');
  panel.className = 'blocker-panel';

  const brand = document.createElement('p');
  brand.className = 'blocker-brand';
  brand.textContent = 'Spider-NaN';

  const title = document.createElement('h1');
  title.id = 'blocker-heading';
  title.textContent = heading;

  const text = document.createElement('p');
  text.textContent = body;

  const link = document.createElement('a');
  link.href = PRESENTATION_URL;
  link.textContent = back;

  panel.append(brand, title, text, link);
  overlay.append(panel);

  // The canvas and the HUD chrome belong to a game that will never start.
  document.body.replaceChildren(overlay);
}

/**
 * Show the blocker when the device cannot play, and report whether it did.
 * `true` means the caller must NOT boot the game.
 */
export function blockUnsupportedDevice(): boolean {
  const touchOnly = isTouchOnlyDevice();
  if (!touchOnly && hasWebGL()) return false;

  const lang = blockerLanguage();
  const s = (key: keyof StringTable): string => TABLES[lang][key] || EN[key];

  render(
    touchOnly ? s('blocked.heading') : s('blocked.webglHeading'),
    touchOnly ? s('blocked.body') : s('blocked.webglBody'),
    s('blocked.back'),
    lang,
  );
  return true;
}
