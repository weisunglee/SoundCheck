// UI language. Texts are written in Traditional Chinese in the code and looked up in the
// other languages' tables by that same text (gettext style), so the code stays readable.
// `npm run check:i18n` lists texts a table is missing.
import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useState, type ReactNode } from "react";
import en from "./locales/en";
import ja from "./locales/ja";
import ko from "./locales/ko";
import zhCN from "./locales/zh-CN";

export type Lang = "zh-TW" | "zh-CN" | "en" | "ja" | "ko";

/** Each language named in itself, so anyone can find their own. */
export const LANGUAGES: { id: Lang; label: string }[] = [
  { id: "zh-TW", label: "繁體中文" },
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
];

const TABLES: Record<Exclude<Lang, "zh-TW">, Record<string, string>> = { "zh-CN": zhCN, en, ja, ko };
const STORAGE_KEY = "soundcheck.language";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved && LANGUAGES.some((l) => l.id === saved)) return saved;
  } catch {
    // Storage unavailable: fall back to the system language.
  }
  const system = navigator.language.toLowerCase();
  if (system.startsWith("zh")) return /cn|sg|hans/.test(system) ? "zh-CN" : "zh-TW";
  if (system.startsWith("ja")) return "ja";
  if (system.startsWith("ko")) return "ko";
  return system.startsWith("en") ? "en" : "zh-TW";
}

let current: Lang = detect();

/** The language for `Intl` date and number formatting. */
export const locale = () => current;

/**
 * Translates `text` (the Traditional Chinese original) and fills `{name}` placeholders.
 * Works outside React too; components re-render on a language change because App does.
 */
export function t(text: string, params?: Record<string, string | number>): string {
  const translated = current === "zh-TW" ? text : (TABLES[current][text] ?? text);
  const values: Record<string, string | number> = { app: softwareName, ...params };
  return translated.replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));
}

/**
 * The streaming software's own name. UI text says "streaming software" in general and only
 * names the product, through {app}, in steps that point at its menus.
 */
let softwareName = "OBS";
export const setSoftwareName = (name: string) => {
  softwareName = name;
};

/** Marks a text kept in data (translated later with `t(value)`) so the i18n check finds it. */
export const msg = (text: string) => text;

const LangContext = createContext<{ lang: Lang; setLang: (lang: Lang) => void }>({ lang: current, setLang: () => {} });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  const setLang = (next: Lang) => {
    current = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembered across restarts, but still applied now.
    }
    invoke("set_language", { lang: next }).catch(() => {});
    document.documentElement.lang = next;
    setLangState(next);
  };
  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

/** Subscribes the caller to language changes. */
export const useLanguage = () => useContext(LangContext);

/** Tells the backend the starting language, for messages it produces itself. */
export function syncBackendLanguage() {
  document.documentElement.lang = current;
  invoke("set_language", { lang: current }).catch(() => {});
}
