import type { SourceStatus } from "../types";
import { msg, t } from "../i18n";

export type BadgeKind = SourceStatus | "silent";

const LABELS: Record<BadgeKind, string> = {
  live: msg("正在出聲"),
  silent: msg("目前沒聲音"),
  hidden: msg("已隱藏"),
  muted: msg("已靜音"),
  monitorOnly: msg("只有你聽得到"),
  offStream: msg("沒送到直播"),
  notInScene: msg("不在這個場景"),
};

export const statusLabel = (kind: BadgeKind) => t(LABELS[kind]);

export function StatusBadge({ kind }: { kind: BadgeKind }) {
  return <span className={`badge badge-${kind}`}>{statusLabel(kind)}</span>;
}

/** The small dot used in the scene list and the scene table. */
export function StatusDot({ kind, title }: { kind: SourceStatus; title?: string }) {
  return <span className={`dot dot-${kind}`} title={title ?? statusLabel(kind)} aria-label={title ?? statusLabel(kind)} />;
}
