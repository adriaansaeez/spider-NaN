/**
 * LEAD-OWNED CONTRACT, then handed to the translation builder.
 *
 * The KEY LIST below was extracted from the actual call sites, not invented:
 * MainMenu.ts, ScoreSystem.ts (trick names), ScoreHud.ts (the record label) and
 * ControlPrompt.ts (the on-screen control labels). It is the coupling point
 * between the two builders working on i18n, exactly as src/contracts/ is for the
 * game systems: the translation builder fills `es`, the system builder wires
 * `t()` into the call sites, and neither has to wait for the other.
 *
 * DELIBERATELY NOT TRANSLATED, do not add keys for these:
 *  - ".Spider-NaN" — the game's name, a product name in both languages.
 *  - MOUSE / W A S D / SPACE — physical key names, identical in both.
 *  - Nothing else. NOTE: the voice-line subtitles WERE excluded here on the
 *    grounds that they must match Spanish speech; the owner overruled that, and
 *    they now follow the UI language like any subtitled foreign-language media.
 *    The AUDIO stays Spanish in both languages, which is what
 *    `settings.voicesSpanishOnly` exists to explain.
 */
export type Lang = 'en' | 'es';

/** Every player-visible string in the game, keyed. `es` is filled by the
 *  translation builder; an empty string means "not translated yet" and must
 *  fall back to `en` at runtime rather than rendering blank. */
export interface StringTable {
  'menu.play': string;
  'menu.settings': string;
  'menu.chooseMode': string;
  'menu.back': string;
  'menu.paused': string;
  'menu.resume': string;
  'menu.exitToMenu': string;
  'menu.exit': string;

  'mode.arcade.title': string;
  'mode.arcade.blurb': string;
  'mode.libre.title': string;
  'mode.libre.blurb': string;

  'settings.title': string;
  'settings.effectsVolume': string;
  'settings.musicVolume': string;
  'settings.voiceVolume': string;
  'settings.debugOverlay': string;
  /** Settings toggle: restore the game's original (phase-1) look. */
  'settings.classicMode': string;
  /** One-line explanation shown under the classic-mode toggle. */
  'settings.classicModeHint': string;
  'settings.language': string;
  /** Shown in Settings: the recorded voice lines exist only in Spanish. */
  'settings.voicesSpanishOnly': string;

  'aria.mainMenu': string;
  'aria.chooseMode': string;
  'aria.paused': string;
  'aria.settings': string;

  'hud.best': string;

  'trick.webSlingshot': string;
  'trick.wallRun': string;
  'trick.launchPull': string;
  'trick.longSwing': string;
  'trick.fullArc': string;
  'trick.bigAir': string;
  'trick.hangTime': string;
  'trick.frontFlip': string;
  'trick.backFlip': string;
  'trick.corkscrew': string;
  /** Prefix applied to a repeated trick, e.g. "DOUBLE BACK FLIP". */
  'trick.doublePrefix': string;

  /**
   * Voice-line subtitles. The AUDIO is Spanish in both languages — only the
   * subtitle follows the UI language, the way foreign-language media is
   * normally subtitled. `settings.voicesSpanishOnly` is what tells an English
   * player why they are hearing Spanish.
   *
   * These are jokes built on wordplay, so the English is a REWRITE that keeps
   * the joke, not a literal translation. Line 2 is the Spider-Man "with great
   * power comes great responsibility" beat; line 3 puns on telarañas = webs.
   */
  'voice.line1': string;
  'voice.line2': string;
  'voice.line3': string;
  'voice.line4': string;
  'voice.line5': string;

  'prompt.look': string;
  'prompt.steer': string;
  'prompt.web': string;
  'prompt.dash': string;
  'prompt.launch': string;
}

/** English is the source of truth: these are the exact strings shipping today. */
export const EN: StringTable = {
  'menu.play': 'Play',
  'menu.settings': 'Settings',
  'menu.chooseMode': 'Choose Mode',
  'menu.back': 'Back',
  'menu.paused': 'Paused',
  'menu.resume': 'Resume',
  'menu.exitToMenu': 'Exit to Menu',
  'menu.exit': 'Exit',

  'mode.arcade.title': 'Arcade Mode',
  'mode.arcade.blurb': 'Score your swings, air time, and flips with a multiplier and best run.',
  'mode.libre.title': 'Free Roam',
  'mode.libre.blurb': 'Move through the city at your own pace. No scoring, no HUD, no record.',

  'settings.title': 'Settings',
  'settings.effectsVolume': 'Effects Volume',
  'settings.musicVolume': 'Music Volume',
  'settings.voiceVolume': 'Voice Volume',
  'settings.debugOverlay': 'Debug Overlay',
  'settings.classicMode': 'Classic mode',
  'settings.classicModeHint': 'The original look: procedural sky and hero, no fog, shadows or ground textures.',
  'settings.language': 'Language',
  'settings.voicesSpanishOnly': 'Voice lines are in Spanish only.',

  'aria.mainMenu': 'Main menu',
  'aria.chooseMode': 'Choose game mode',
  'aria.paused': 'Paused',
  'aria.settings': 'Settings',

  'hud.best': 'BEST',

  'trick.webSlingshot': 'WEB SLINGSHOT',
  'trick.wallRun': 'WALL RUN',
  'trick.launchPull': 'LAUNCH PULL',
  'trick.longSwing': 'LONG SWING',
  'trick.fullArc': 'FULL ARC',
  'trick.bigAir': 'BIG AIR',
  'trick.hangTime': 'HANG TIME',
  'trick.frontFlip': 'FRONT FLIP',
  'trick.backFlip': 'BACK FLIP',
  'trick.corkscrew': 'CORKSCREW',
  'trick.doublePrefix': 'DOUBLE',

  'voice.line1': "I wonder if Mary Jane knows there are unlimited tokens in NaN. Should I call her back and tell her?",
  'voice.line2': 'With great model comes great... harness?',
  'voice.line3': 'Am I a hero... or just a prompt with cobwebs?',
  'voice.line4': 'The AI made me. The jokes are on Adrian.',
  'voice.line5': "It's not a bug, it's a feature.",

  'prompt.look': 'LOOK',
  'prompt.steer': 'STEER',
  'prompt.web': 'WEB',
  'prompt.dash': 'DASH',
  'prompt.launch': 'LAUNCH',
};

/** TRANSLATION BUILDER OWNS THIS OBJECT. Every value is '' until translated;
 *  the runtime falls back to EN for any empty string. */
export const ES: StringTable = {
  'menu.play': 'Jugar',
  'menu.settings': 'Ajustes',
  'menu.chooseMode': 'Elegir Modo',
  'menu.back': 'Volver',
  'menu.paused': 'Pausa',
  'menu.resume': 'Reanudar',
  'menu.exitToMenu': 'Salir al Menú',
  'menu.exit': 'Salir',

  'mode.arcade.title': 'Modo Arcade',
  'mode.arcade.blurb': 'Puntúa tus swings, el tiempo en el aire y los flips: multiplicador y mejor marca.',
  'mode.libre.title': 'Modo Libre',
  'mode.libre.blurb': 'Muévete por la ciudad a tu ritmo. Sin puntuación, sin HUD, sin récord.',

  'settings.title': 'Ajustes',
  'settings.effectsVolume': 'Volumen de Efectos',
  'settings.musicVolume': 'Volumen de Música',
  'settings.voiceVolume': 'Volumen de Voces',
  'settings.debugOverlay': 'Depuración',
  'settings.classicMode': 'Modo clásico',
  'settings.classicModeHint': 'El aspecto original: cielo y héroe procedurales, sin niebla, sombras ni texturas de suelo.',
  'settings.language': 'Idioma',
  'settings.voicesSpanishOnly': 'Las voces están solo en español.',

  'aria.mainMenu': 'Menú principal',
  'aria.chooseMode': 'Elegir modo de juego',
  'aria.paused': 'Pausado',
  'aria.settings': 'Ajustes',

  'hud.best': 'MEJOR',

  'trick.webSlingshot': 'IMPULSO WEB',
  'trick.wallRun': 'CARRERA MURAL',
  'trick.launchPull': 'TIRÓN LANZADOR',
  'trick.longSwing': 'SWING LARGO',
  'trick.fullArc': 'ARCO TOTAL',
  'trick.bigAir': 'GRAN AIRE',
  'trick.hangTime': 'SUSPENSIÓN',
  'trick.frontFlip': 'FLIP FRONTAL',
  'trick.backFlip': 'FLIP ATRÁS',
  'trick.corkscrew': 'TIRABUZÓN',
  'trick.doublePrefix': 'DOBLE',

  'voice.line1': 'No se si Mary Jane sabra que en NaN hay tokkens ilimitados, ¿deberia volver a llamarla y decirselo?',
  'voice.line2': 'Un gran modelo conlleva un gran.... ¿harness?',
  'voice.line3': '¿Soy un heroe... o un prompt con telarañas?',
  'voice.line4': 'La ia me creo, los chistes son culpa de Adrián',
  'voice.line5': 'No es un bug, es una caracteristica',

  'prompt.look': 'MIRAR',
  'prompt.steer': 'GIRAR',
  'prompt.web': 'WEB',
  'prompt.dash': 'DASH',
  'prompt.launch': 'LANZAR',
};

export const TABLES: Record<Lang, StringTable> = { en: EN, es: ES };
