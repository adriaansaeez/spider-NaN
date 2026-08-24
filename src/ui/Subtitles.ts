/**
 * OWNER: feel-builder. Bottom-centre subtitle overlay for voice lines.
 *
 * Follows the same conventions as Hud and ScoreHud:
 *  - `pointer-events: none` (set in CSS) so it never eats the click that
 *    acquires pointer lock.
 *  - visible / hidden via `setHudVisible(false)` from the harness, same as
 *    the debug HUD and score overlay.
 *  - styled in the same family: `#0b0e13` ground, `#d8e2ec` text,
 *    `ui-monospace`, text-shadow, no external fonts or images.
 */
import { t, onLanguageChange } from '../i18n/i18n';
import type { StringTableKey } from '../i18n/i18n';

export class Subtitles {
  private readonly el = document.createElement('div');
  private visible = true;
  /** The KEY of the line on screen, not its text. Translating late is what lets
   *  a subtitle already on screen follow a mid-line language switch; resolving
   *  at play time would freeze it in whatever language was active when the clip
   *  started. Same rule the trick names follow. */
  private currentKey: StringTableKey | null = null;
  private readonly offLanguageChange: () => void;

  constructor() {
    this.el.id = 'subtitles';
    document.body.appendChild(this.el);
    this.offLanguageChange = onLanguageChange(() => this.render());
  }

  /** Show the subtitle for a line. Called by VoiceLineSystem via the callback. */
  showKey(key: StringTableKey): void {
    this.currentKey = key;
    this.render();
  }

  /** Hide the subtitle. Called when the audio ends. */
  hide(): void {
    this.currentKey = null;
    this.render();
  }

  private render(): void {
    if (!this.currentKey || !this.visible) {
      this.el.textContent = '';
      this.el.style.display = 'none';
      return;
    }
    this.el.textContent = t(this.currentKey);
    this.el.style.display = 'block';
  }

  /** Harness override — same contract as Hud.setVisible / ScoreHud.setVisible. */
  setVisible(v: boolean): void {
    this.visible = v;
    this.render();
  }

  dispose(): void {
    this.offLanguageChange();
    this.el.remove();
  }
}
