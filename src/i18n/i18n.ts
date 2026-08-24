import { EN, TABLES, type Lang, type StringTable } from './strings';

/** Every key in the string table. */
export type StringTableKey = keyof StringTable;

const STORAGE_KEY = 'gauntlet.language';
let currentLang: Lang = 'en';
const listeners = new Set<() => void>();

function readStoredLang(): Lang {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'es') return 'es';
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
  return 'en';
}

/**
 * Whether the player has ever picked a language here. Callers that render
 * before the menu exists (the device blocker) use this to fall back to the
 * browser locale instead of silently showing English to a Spanish visitor.
 */
export function hasStoredLanguage(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Get the current UI language. */
export function getLanguage(): Lang {
  return currentLang;
}

/** Switch language, persist, and notify listeners. */
export function setLanguage(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
  for (const fn of listeners) fn();
}

/** Register a callback for language changes. Returns an unsubscribe function. */
export function onLanguageChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Translate a key. Falls back to English when the current table has an empty string. */
export function t(key: StringTableKey): string {
  const val = TABLES[currentLang][key];
  return val !== '' ? val : EN[key];
}

/**
 * Structured trick name: stores i18n keys so translation happens at render time,
 * not award time. This avoids stale translations when the language switches
 * mid-run (queued HUD tricks keep displaying the old language, but the next
 * trick is correct).
 */
export interface TrickName {
  base: StringTableKey;
  prefix?: StringTableKey;
  suffix?: StringTableKey;
}

/** Resolve a TrickName to display text by translating each part and composing. */
export function resolveTrickName(trick: TrickName): string {
  let name = '';
  if (trick.prefix) name += t(trick.prefix) + ' ';
  name += t(trick.base);
  if (trick.suffix) name += ' + ' + t(trick.suffix);
  return name;
}

// Initialize from storage on module load.
currentLang = readStoredLang();
