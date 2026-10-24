// Capturing the audio settings of every source as a profile, and applying a profile back to the
// streaming software. Works with any adapter that has everything profiles save (capabilities.profiles).
import type { FilterOps, SoftwareAdapter } from "./adapter";
import { AUDIO_FILTER_KINDS } from "./adapter";
import type { SoftwareId } from "./software";
import type { AudioSource, MonitorType } from "./types";
import { t } from "./i18n";

const PROFILE_VERSION = 1;
interface ProfileFilter {
  name: string;
  kind: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

interface ProfileSource {
  name: string;
  volumeDb: number;
  muted: boolean;
  /** Profiles saved before this was neutral hold OBS's names ("OBS_MONITORING_TYPE_…"). */
  monitorType: MonitorType | string;
  balance: number;
  syncOffsetMs: number;
  tracks: number[];
  /** Audio filters only, in chain order. */
  filters: ProfileFilter[];
}

export interface Profile {
  version: number;
  name: string;
  savedAt: string;
  /** Scene collection the profile was saved in; source names only mean the same thing there. */
  sceneCollection?: string;
  /** The streaming software it was saved in; missing in profiles saved before this was recorded. */
  software?: SoftwareId;
  sources: ProfileSource[];
}

export interface ApplyResult {
  applied: string[];
  /** In the profile but not in the software (renamed or deleted). */
  missing: string[];
  /** Audio filters in the software that the profile does not have; removed. */
  removedFilters: string[];
  errors: string[];
}

type ProfileAdapter = SoftwareAdapter &
  Required<Pick<SoftwareAdapter, "setMonitorType" | "setSyncOffset" | "setTracks">> & {
    filters: FilterOps;
  };

function profileAdapter(adapter: SoftwareAdapter): ProfileAdapter {
  const { setMonitorType, setSyncOffset, setTracks, filters } = adapter;
  if (!setMonitorType || !setSyncOffset || !setTracks || !filters) {
    throw new Error(t("{app} 不支援設定檔。"));
  }
  return adapter as ProfileAdapter;
}

const LEGACY_MONITOR_TYPES: Record<string, MonitorType> = {
  OBS_MONITORING_TYPE_NONE: "off",
  OBS_MONITORING_TYPE_MONITOR_ONLY: "monitorOnly",
  OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT: "monitorAndOutput",
};

export function profileMonitorType(saved: string): MonitorType {
  return LEGACY_MONITOR_TYPES[saved] ?? (saved === "monitorOnly" || saved === "monitorAndOutput" ? saved : "off");
}

export async function captureProfile(adapter: SoftwareAdapter, name: string, sources: AudioSource[]): Promise<Profile> {
  const sw = profileAdapter(adapter);
  const captured: ProfileSource[] = [];
  for (const s of sources) {
    const filters = (await sw.filters.list(s.name)).filter((f) => AUDIO_FILTER_KINDS.has(f.kind));
    captured.push({
      name: s.name,
      volumeDb: s.volumeDb,
      muted: s.muted,
      monitorType: s.monitorType,
      balance: s.balance,
      syncOffsetMs: s.syncOffsetMs,
      tracks: s.tracks,
      filters: filters.map((f) => ({ name: f.name, kind: f.kind, enabled: f.enabled, settings: f.settings })),
    });
  }
  return {
    version: PROFILE_VERSION,
    name,
    savedAt: new Date().toISOString(),
    sceneCollection: await sw.sceneCollection?.(),
    software: adapter.id,
    sources: captured,
  };
}

/**
 * Applies a profile to the sources that exist in the software. Each source's audio filters end up
 * as saved: created or updated to match, in the saved order at the top of the chain, and audio
 * filters the profile lacks are removed. Other filters (video ones) are left alone.
 */
export async function applyProfile(adapter: SoftwareAdapter, profile: Profile, current: AudioSource[]): Promise<ApplyResult> {
  const sw = profileAdapter(adapter);
  const result: ApplyResult = { applied: [], missing: [], removedFilters: [], errors: [] };
  const existing = new Set(current.map((s) => s.name));

  for (const s of profile.sources) {
    if (!existing.has(s.name)) {
      result.missing.push(s.name);
      continue;
    }
    const inputName = s.name;
    try {
      await sw.setVolume(inputName, s.volumeDb);
      await sw.setMuted(inputName, s.muted);
      await sw.setMonitorType(inputName, profileMonitorType(s.monitorType));
      // A program without balance skips it; the saved value stays in the profile.
      await sw.setBalance?.(inputName, s.balance);
      await sw.setSyncOffset(inputName, s.syncOffsetMs);
      await sw.setTracks(inputName, s.tracks);

      const have = await sw.filters.list(inputName);
      const removeFilter = async (name: string) => {
        await sw.filters.remove(inputName, name);
        have.splice(have.findIndex((h) => h.name === name), 1);
        result.removedFilters.push(`${inputName}：${name}`);
      };
      const savedNames = new Set(s.filters.map((f) => f.name));
      let placed = 0;
      for (const f of s.filters) {
        try {
          let match = have.find((h) => h.name === f.name);
          if (match && match.kind !== f.kind) {
            if (!AUDIO_FILTER_KINDS.has(match.kind)) {
              result.errors.push(t("{source}：已經有另一種濾鏡叫「{filter}」，略過", { source: inputName, filter: f.name }));
              continue;
            }
            // An audio filter of another kind holds the name; the profile doesn't have it, so it goes.
            await removeFilter(match.name);
            match = undefined;
          }
          // A filter the user renamed in the software: reuse it instead of stacking a second one of the same kind.
          if (!match && sw.filters.rename) {
            const renamed = have.find((h) => h.kind === f.kind && !savedNames.has(h.name));
            if (renamed) {
              await sw.filters.rename(inputName, renamed.name, f.name);
              savedNames.add(renamed.name);
              renamed.name = f.name;
              match = renamed;
            }
          }
          if (match) await sw.filters.setSettings(inputName, f.name, f.settings, true);
          else await sw.filters.create(inputName, f.name, f.kind, f.settings);
          await sw.filters.setEnabled(inputName, f.name, f.enabled);
          await sw.filters.move(inputName, f.name, placed);
          placed++;
        } catch (e) {
          result.errors.push(`${inputName}：${f.name}：${(e as Error).message}`);
        }
      }
      const wanted = new Set(s.filters.map((f) => f.name));
      for (const h of have.filter((h) => AUDIO_FILTER_KINDS.has(h.kind) && !wanted.has(h.name))) {
        await removeFilter(h.name).catch((e: Error) => result.errors.push(`${inputName}：${h.name}：${e.message}`));
      }
      result.applied.push(inputName);
    } catch (e) {
      result.errors.push(`${inputName}：${(e as Error).message}`);
    }
  }
  return result;
}
