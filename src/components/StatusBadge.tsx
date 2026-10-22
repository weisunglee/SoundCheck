import type { SourceStatus } from "../types";

export type BadgeKind = SourceStatus | "silent";

const LABELS: Record<BadgeKind, string> = {
  live: "正在出聲",
  silent: "目前沒聲音",
  hidden: "已隱藏",
  muted: "已靜音",
  offStream: "沒送到直播",
  notInScene: "不在這個場景",
};

export function StatusBadge({ kind }: { kind: BadgeKind }) {
  return <span className={`badge badge-${kind}`}>{LABELS[kind]}</span>;
}

/** The small dot used in the scene list and the scene table. */
export function StatusDot({ kind, title }: { kind: SourceStatus; title?: string }) {
  return <span className={`dot dot-${kind}`} title={title ?? LABELS[kind]} aria-label={title ?? LABELS[kind]} />;
}
