import { AudioSystem } from '../fx/AudioSystem';
import { VoiceLineSystem } from '../fx/VoiceLineSystem';
import { t, getLanguage, setLanguage, onLanguageChange, type StringTableKey } from '../i18n/i18n';
import type { Lang } from '../i18n/strings';
import { isClassicMode } from '../core/ClassicMode';

type UiMode = 'main' | 'modes' | 'playing' | 'pause' | 'settings';
type SettingsReturn = 'main' | 'pause';

/** What the player picked on the mode screen. See docs/ui/MENU.md. */
export type GameMode = 'libre' | 'arcade';

interface MainMenuOptions {
  setPaused(paused: boolean): void;
  reset(): void;
  /**
   * Arm/disarm the scoring system. The menu owns the MODE; it does not own the
   * scoring model, so this is the entire surface between the two.
   */
  setScoringEnabled(on: boolean): void;
  /** Show/hide the debug overlay. The menu owns the PREFERENCE; Game owns the
   *  HUD and combines it with the harness override. */
  setDebugHudVisible(on: boolean): void;
  /**
   * Turn "Modo clásico" on or off. The menu owns the PREFERENCE; core/ClassicMode
   * owns the flag, its persistence and the systems that render it — exactly the
   * split used for the debug overlay above.
   */
  setClassicMode(on: boolean): void;
}

export class MainMenu {
  private static readonly debugHudStorageKey = 'gauntlet.debugHud';
  private readonly root = document.createElement('div');
  private mode: UiMode = 'main';
  private settingsReturn: SettingsReturn = 'main';
  /**
   * The mode the CURRENT run is being played in. It is set only when a run
   * starts, never by pausing, so Esc -> Reanudar stays in the same mode.
   */
  private gameMode: GameMode = 'arcade';
  private readonly unsubscribeLang: () => void;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: MainMenuOptions) {
    this.root.id = 'game-ui';
    this.root.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.root);

    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('input', this.onInput);
    this.root.addEventListener('change', this.onInput);
    addEventListener('keydown', this.onKeyDown);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);

    this.unsubscribeLang = onLanguageChange(() => this.render());

    // Push the stored preference once at construction so a player who turned
    // the debug overlay off stays off across reloads. The HUD already exists:
    // Game creates `this.hud` before `new MainMenu(...)`.
    this.options.setDebugHudVisible(MainMenu.readDebugHudPref());

    if (MainMenu.shouldBypassForHarness()) {
      this.dismissForHarness();
      this.options.setPaused(false);
    } else {
      this.showMain();
    }
  }

  static shouldBypassForHarness(): boolean {
    return navigator.webdriver === true;
  }

  /** The stored debug-overlay preference. Default ON — this task is "let the
   *  player hide it", not "change what new players see". */
  static readDebugHudPref(): boolean {
    try {
      return localStorage.getItem(MainMenu.debugHudStorageKey) !== '0';
    } catch {
      // Storage can be unavailable in private or embedded contexts.
      return true;
    }
  }

  /** Persist the debug-overlay preference. Same storage discipline as the
   *  volume sliders: private-mode contexts throw, so ignore the failure. */
  private static persistDebugHudPref(on: boolean): void {
    try {
      localStorage.setItem(MainMenu.debugHudStorageKey, on ? '1' : '0');
    } catch {
      // Storage can be unavailable in private or embedded contexts.
    }
  }

  /** The mode the current run is in. Surfaced additively on `__GAUNTLET__`. */
  currentMode(): GameMode {
    return this.gameMode;
  }

  /**
   * The automation path: `navigator.webdriver`, `__GAUNTLET__.setPaused(false)`
   * and `playTape()` all land here, and none of them can choose a mode.
   *
   * IT MUST NOT OVERRIDE A RUN THE PLAYER ALREADY STARTED. `Game.setPaused()`
   * calls this on every unpause, including the one `enterPlaying()` performs
   * after the player picked a mode — so without the `playing` guard below,
   * choosing Modo Libre immediately re-armed Arcade. Measured, not theorised:
   * the first build of this screen reported `gameMode: 'arcade'` and scored
   * 2 312 points during a "free" session. If a run is already live, automation
   * has nothing to dismiss and no business changing its mode.
   *
   * THE HARNESS GETS ARCADE, deliberately and unconditionally. Critics and
   * `tools/capture.mjs` read `__GAUNTLET__.score()`, and a harness that silently
   * landed in Libre would return a permanently-zero score that looks exactly
   * like a broken scoring system. Arcade is also the strictly larger surface:
   * anything that works headlessly in Arcade also works in Libre.
   */
  dismissForHarness(): void {
    if (this.mode === 'playing') return;
    this.gameMode = 'arcade';
    this.options.setScoringEnabled(true);
    this.mode = 'playing';
    this.render();
  }

  dispose(): void {
    this.unsubscribeLang();
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('input', this.onInput);
    this.root.removeEventListener('change', this.onInput);
    removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.root.remove();
    document.body.classList.remove('game-ui-active');
  }

  private showMain(): void {
    this.mode = 'main';
    this.settingsReturn = 'main';
    // No run is in progress at the main menu, so nothing may be scoring.
    this.options.setScoringEnabled(false);
    this.options.setPaused(true);
    this.releasePointerLock();
    this.render();
  }

  /** `Jugar` no longer starts a run; it asks which kind of run. */
  private showModes(): void {
    this.mode = 'modes';
    this.options.setPaused(true);
    this.releasePointerLock();
    this.render();
  }

  private showPause(): void {
    if (this.mode !== 'playing') return;
    this.mode = 'pause';
    this.settingsReturn = 'pause';
    this.options.setPaused(true);
    this.releasePointerLock();
    this.render();
  }

  private showSettings(from: SettingsReturn): void {
    this.mode = 'settings';
    this.settingsReturn = from;
    this.options.setPaused(true);
    this.render();
  }

  /**
   * Begin a NEW run in `mode`. Goes through the same reset path as
   * `__GAUNTLET__.reset()` rather than inventing a second one, so the score,
   * the player and the camera all start from the deterministic start state.
   */
  private startRun(mode: GameMode): void {
    this.gameMode = mode;
    this.options.reset();
    this.options.setScoringEnabled(mode === 'arcade');
    this.enterPlaying();
  }

  /** Resume the run already in progress. Deliberately does NOT touch the mode. */
  private resume(): void {
    this.enterPlaying();
  }

  private enterPlaying(): void {
    const lock = this.requestPointerLock();
    this.mode = 'playing';
    this.render();
    this.options.setPaused(false);
    void lock;
  }

  private exitToMenu(): void {
    this.options.reset();
    this.showMain();
  }

  private backFromSettings(): void {
    if (this.settingsReturn === 'pause') {
      this.mode = 'pause';
      this.options.setPaused(true);
      this.render();
      return;
    }
    this.showMain();
  }

  private readonly onClick = (e: MouseEvent): void => {
    const action = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'play') this.showModes();
    else if (action === 'mode-arcade') this.startRun('arcade');
    else if (action === 'mode-libre') this.startRun('libre');
    else if (action === 'resume') this.resume();
    else if (action === 'settings-main') this.showSettings('main');
    else if (action === 'settings-pause') this.showSettings('pause');
    // One `Back` label, two callers: the settings panel honours
    // `settingsReturn`, the mode screen is only ever reached from `main`.
    else if (action === 'back') {
      if (this.mode === 'modes') this.showMain();
      else this.backFromSettings();
    }
    else if (action === 'menu') this.exitToMenu();
  };

  private readonly onInput = (e: Event): void => {
    const target = e.target;
    // Handle the <select> language control first (HTMLSelectElement, not HTMLInputElement).
    if (target instanceof HTMLSelectElement && target.dataset.setting === 'language') {
      const lang = target.value;
      if (lang === 'en' || lang === 'es') setLanguage(lang as Lang);
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.setting === 'debug-hud') {
      // A checkbox fires both `input` and `change`; both route here, and the
      // toggle is idempotent so a double dispatch is harmless. Apply immediately
      // so the overlay appears/vanishs behind the still-open settings panel.
      const on = target.checked;
      MainMenu.persistDebugHudPref(on);
      this.options.setDebugHudVisible(on);
      return;
    }
    if (target.dataset.setting === 'classic-mode') {
      // Same shape as the debug-hud toggle above: apply immediately, so the
      // world behind the still-open settings panel switches look at once.
      // Persistence lives in core/ClassicMode, alongside the flag itself.
      this.options.setClassicMode(target.checked);
      return;
    }
    if (target.dataset.setting === 'music-volume') {
      const volume = AudioSystem.setMusicVolumePercent(Number(target.value));
      const value = this.root.querySelector<HTMLElement>('[data-music-volume-value]');
      if (value) value.textContent = `${volume}%`;
      return;
    }
    if (target.dataset.setting === 'voice-volume') {
      const volume = VoiceLineSystem.setVoiceVolumePercent(Number(target.value));
      const value = this.root.querySelector<HTMLElement>('[data-voice-volume-value]');
      if (value) value.textContent = `${volume}%`;
      return;
    }
    if (target.dataset.setting !== 'sfx-volume') return;
    const volume = AudioSystem.setVolumePercent(Number(target.value));
    const value = this.root.querySelector<HTMLElement>('[data-sfx-volume-value]');
    if (value) value.textContent = `${volume}%`;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' && this.mode === 'playing') this.showPause();
  };

  private readonly onPointerLockChange = (): void => {
    if (this.mode === 'playing' && document.pointerLockElement !== this.canvas) this.showPause();
  };

  private requestPointerLock(): Promise<void> {
    try {
      const lock = this.canvas.requestPointerLock?.() as Promise<void> | void;
      if (lock && typeof lock.catch === 'function') return lock.catch(() => {});
    } catch {
      // A later direct canvas click can still acquire lock if this gesture is denied.
    }
    return Promise.resolve();
  }

  private releasePointerLock(): void {
    if (document.pointerLockElement !== this.canvas) return;
    try {
      document.exitPointerLock();
    } catch {
      // Best effort: the browser also exits pointer lock on Escape.
    }
  }

  private render(): void {
    this.root.dataset.mode = this.mode;
    const active = this.mode !== 'playing';
    this.root.classList.toggle('is-hidden', !active);
    document.body.classList.toggle('game-ui-active', active);

    if (this.mode === 'playing') {
      this.root.replaceChildren();
      return;
    }

    if (this.mode === 'main') {
      this.root.innerHTML = `
        <section class="ui-panel" aria-label="${t('aria.mainMenu')}">
          <div class="ui-title">Web Slinger</div>
          <div class="ui-actions">
            <button type="button" data-action="play">${t('menu.play')}</button>
            <button type="button" data-action="settings-main">${t('menu.settings')}</button>
          </div>
        </section>
      `;
      return;
    }

    if (this.mode === 'modes') {
      const card = (mode: GameMode) => {
        const titleKey: StringTableKey = mode === 'arcade' ? 'mode.arcade.title' : 'mode.libre.title';
        const blurbKey: StringTableKey = mode === 'arcade' ? 'mode.arcade.blurb' : 'mode.libre.blurb';
        return `
            <button type="button" data-action="mode-${mode}" class="ui-mode">
              <span class="ui-mode-title">${t(titleKey)}</span>
              <span class="ui-mode-blurb">${t(blurbKey)}</span>
            </button>`;
      };
      this.root.innerHTML = `
        <section class="ui-panel" aria-label="${t('aria.chooseMode')}">
          <div class="ui-title">${t('menu.chooseMode')}</div>
          <div class="ui-actions">
            ${card('arcade')}
            ${card('libre')}
            <button type="button" data-action="back">${t('menu.back')}</button>
          </div>
        </section>
      `;
      return;
    }

    if (this.mode === 'pause') {
      this.root.innerHTML = `
        <section class="ui-panel" aria-label="${t('aria.paused')}">
          <div class="ui-title">${t('menu.paused')}</div>
          <div class="ui-actions">
            <button type="button" data-action="resume">${t('menu.resume')}</button>
            <button type="button" data-action="settings-pause">${t('menu.settings')}</button>
            <button type="button" data-action="menu">${t('menu.exitToMenu')}</button>
          </div>
        </section>
      `;
      return;
    }

    const volume = AudioSystem.volumePercent();
    const musicVolume = AudioSystem.musicVolume();
    const voiceVolume = VoiceLineSystem.voiceVolume();
    // Read from the store on every render: the panel is re-created via
    // innerHTML and reachable from both the main menu and the pause overlay,
    // so a stale in-memory copy would snap the checkbox back to the default.
    const debugOn = MainMenu.readDebugHudPref();
    // Same reason as debugOn: read the live flag on every render, never a copy.
    const classicOn = isClassicMode();
    const currentLang = getLanguage();
    this.root.innerHTML = `
      <section class="ui-panel" aria-label="${t('aria.settings')}">
        <div class="ui-title">${t('settings.title')}</div>
        <label class="ui-setting">
          <span>${t('settings.effectsVolume')}</span>
          <strong data-sfx-volume-value>${volume}%</strong>
          <input data-setting="sfx-volume" type="range" min="0" max="100" step="1" value="${volume}" />
        </label>
        <label class="ui-setting">
          <span>${t('settings.musicVolume')}</span>
          <strong data-music-volume-value>${musicVolume}%</strong>
          <input data-setting="music-volume" type="range" min="0" max="100" step="1" value="${musicVolume}" />
        </label>
        <label class="ui-setting">
          <span>${t('settings.voiceVolume')}</span>
          <strong data-voice-volume-value>${voiceVolume}%</strong>
          <input data-setting="voice-volume" type="range" min="0" max="100" step="1" value="${voiceVolume}" />
        </label>
        <label class="ui-setting">
          <span>${t('settings.debugOverlay')}</span>
          <input data-setting="debug-hud" type="checkbox"${debugOn ? ' checked' : ''} />
        </label>
        <label class="ui-setting">
          <span>${t('settings.classicMode')}</span>
          <input data-setting="classic-mode" type="checkbox"${classicOn ? ' checked' : ''} />
        </label>
        <div style="font-size: 12px; color: #93a4b6; margin: -10px 0 14px; line-height: 1.4;">
          ${t('settings.classicModeHint')}
        </div>
        <label class="ui-setting">
          <span>${t('settings.language')}</span>
          <select data-setting="language">
            <option value="en"${currentLang === 'en' ? ' selected' : ''}>English</option>
            <option value="es"${currentLang === 'es' ? ' selected' : ''}>Español</option>
          </select>
        </label>
        <div style="font-size: 12px; color: #93a4b6; margin-bottom: 18px; line-height: 1.4;">
          ${t('settings.voicesSpanishOnly')}
        </div>
        <div class="ui-actions">
          <button type="button" data-action="back">${t('menu.back')}</button>
        </div>
      </section>
    `;
  }
}
