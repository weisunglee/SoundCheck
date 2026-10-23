import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider, syncBackendLanguage } from "./i18n";
import "./styles.css";

syncBackendLanguage();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
);
