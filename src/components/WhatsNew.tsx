import type { Notice } from "../whatsNew";
import { Icon, IconButton } from "./Icon";
import { t } from "../i18n";

interface Props {
  notice: Notice;
  /** Does what the notice offers; left out when it can't right now (e.g. there is no mic yet). */
  onAction?: () => void;
  /** Closes it for good. */
  onClose: () => void;
}

/** A corner card, not a dialog: the mixer stays usable while it shows. */
export function WhatsNew({ notice, onAction, onClose }: Props) {
  return (
    <aside className="whats-new" role="status" aria-labelledby="whats-new-title">
      <Icon name="wand-sparkles" />
      <div className="whats-new-text">
        <h3 id="whats-new-title">{t(notice.title)}</h3>
        <p>{t(notice.body)}</p>
        {notice.action === "voiceTuning" && !onAction && <p className="hint">{t("加入麥克風後，在它的卡片上按「自動調整人聲」。")}</p>}
        <div className="row">
          {onAction && (
            <button type="button" className="btn small primary" onClick={onAction}>
              {t("試試看")}
            </button>
          )}
          <button type="button" className="btn small" onClick={onClose}>
            {t("知道了")}
          </button>
        </div>
      </div>
      <IconButton icon="x" label={t("關閉")} className="close" onClick={onClose} />
    </aside>
  );
}
