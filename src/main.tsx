import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider, syncBackendLanguage } from "./i18n";
import { applyTheme, loadTheme } from "./theme";
import "./styles.css";

syncBackendLanguage();
// Before the first render, so the saved theme never flashes the other one.
applyTheme(loadTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
);
