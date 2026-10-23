import { useState } from "react";
import { t } from "../i18n";
import { retryConnection } from "../connection";
import { type SoftwareChoice, loadSoftwareChoice, saveSoftwareChoice } from "../software";

/** Which streaming software to connect to; changing it reconnects right away. */
export function SoftwarePicker({ compact = false }: { compact?: boolean }) {
  const [choice, setChoice] = useState<SoftwareChoice>(loadSoftwareChoice());
  const change = (next: SoftwareChoice) => {
    setChoice(next);
    saveSoftwareChoice(next);
    retryConnection();
  };
  const select = (
    <select id="software-choice" className="select" aria-label={t("直播軟體")} value={choice} onChange={(e) => change(e.target.value as SoftwareChoice)}>
      <option value="auto">{t("自動偵測")}</option>
      <option value="obs">OBS Studio</option>
      <option value="streamlabs">Streamlabs Desktop</option>
    </select>
  );
  if (compact) return select;
  return (
    <label className="field software-picker">
      <span className="field-label">{t("要連線的直播軟體")}</span>
      {select}
    </label>
  );
}
