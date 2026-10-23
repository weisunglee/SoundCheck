// Light or dark colours. "system" follows the OS (styles.css reads prefers-color-scheme); the
// other two set data-theme on <html>, which styles.css checks first.
import { useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const THEME_KEY = "soundcheck.theme";

export function loadTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage unavailable: follow the system.
  }
  return "system";
}

export function applyTheme(choice: ThemeChoice) {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

/** The current choice and a setter that applies and remembers it. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [theme, setTheme] = useState(loadTheme);
  const change = (choice: ThemeChoice) => {
    setTheme(choice);
    applyTheme(choice);
    try {
      if (choice === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch {
      // Only lasts for this session.
    }
  };
  return [theme, change];
}
