// Capturing the audio settings of every source as a profile, and applying a profile back to OBS.
import { FILTERS, loadFilters } from "./filters";
import { obs } from "./obs";
import type { AudioSource, MonitorType } from "./types";
import { t } from "./i18n";

const PROFILE_VERSION = 1;
/** Older automatic backups (saved right before applying a profile) beyond this many are deleted. */
export const BACKUPS_KEPT = 5;

export function backupName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return t("套用前的備份 {time}", { time });
}

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
  monitorType: MonitorType;
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
  /** OBS scene collection the profile was saved in; source names only mean the same thing there. */
  sceneCollection?: string;
  /** Saved automatically before applying another profile; old ones are pruned. */
  backup?: boolean;
  sources: ProfileSource[];
}

export interface ApplyResult {
  applied: string[];
  /** In the profile but not in OBS (renamed or deleted). */
  missing: string[];
  /** Audio filters in OBS that the profile does not have; left in place. */
  extraFilters: string[];
  errors: string[];
}

const TRACKS = [1, 2, 3, 4, 5, 6];

export async function captureProfile(name: string, sources: AudioSource[], backup = false): Promise<Profile> {
  const captured: ProfileSource[] = [];
  for (const s of sources) {
    const filters = (await loadFilters(s.name)).filter((f) => FILTERS[f.kind]);
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
  const { currentSceneCollectionName } = await obs.call("GetSceneCollectionList");
  return {
    version: PROFILE_VERSION,
    name,
    savedAt: new Date().toISOString(),
    sceneCollection: currentSceneCollectionName,
    backup,
    sources: captured,
  };
}

type Json = { [key: string]: string | number | boolean | Json | Json[] | null };

/**
 * Applies a profile to the sources that exist in OBS. Filters are created or updated to match
 * and put in the saved order at the top of the chain; filters the profile lacks are kept.
 */
export async function applyProfile(profile: Profile, current: AudioSource[]): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], missing: [], extraFilters: [], errors: [] };
  const existing = new Set(current.map((s) => s.name));

  for (const s of profile.sources) {
    if (!existing.has(s.name)) {
      result.missing.push(s.name);
      continue;
    }
    const inputName = s.name;
    try {
      await obs.call("SetInputVolume", { inputName, inputVolumeDb: s.volumeDb });
      await obs.call("SetInputMute", { inputName, inputMuted: s.muted });
      await obs.call("SetInputAudioMonitorType", { inputName, monitorType: s.monitorType });
      await obs.call("SetInputAudioBalance", { inputName, inputAudioBalance: s.balance });
      await obs.call("SetInputAudioSyncOffset", { inputName, inputAudioSyncOffset: s.syncOffsetMs });
      await obs.call("SetInputAudioTracks", {
        inputName,
        inputAudioTracks: Object.fromEntries(TRACKS.map((t) => [String(t), s.tracks.includes(t)])),
      });

      const have = await loadFilters(inputName);
      const savedNames = new Set(s.filters.map((f) => f.name));
      let placed = 0;
      for (const f of s.filters) {
        let match = have.find((h) => h.name === f.name);
        if (match && match.kind !== f.kind) {
          result.errors.push(t("{source}：已經有另一種濾鏡叫「{filter}」，略過", { source: inputName, filter: f.name }));
          continue;
        }
        // A filter the user renamed in OBS: reuse it instead of stacking a second one of the same kind.
        if (!match) {
          const renamed = have.find((h) => h.kind === f.kind && !savedNames.has(h.name));
          if (renamed) {
            await obs.call("SetSourceFilterName", { sourceName: inputName, filterName: renamed.name, newFilterName: f.name });
            savedNames.add(renamed.name);
            renamed.name = f.name;
            match = renamed;
          }
        }
        const filterSettings = f.settings as Json;
        if (match) {
          await obs.call("SetSourceFilterSettings", { sourceName: inputName, filterName: f.name, filterSettings, overlay: false });
        } else {
          await obs.call("CreateSourceFilter", { sourceName: inputName, filterName: f.name, filterKind: f.kind, filterSettings });
        }
        await obs.call("SetSourceFilterEnabled", { sourceName: inputName, filterName: f.name, filterEnabled: f.enabled });
        await obs.call("SetSourceFilterIndex", { sourceName: inputName, filterName: f.name, filterIndex: placed });
        placed++;
      }
      const wanted = new Set(s.filters.map((f) => f.name));
      for (const h of have) if (FILTERS[h.kind] && !wanted.has(h.name)) result.extraFilters.push(`${inputName}：${h.name}`);
      result.applied.push(inputName);
    } catch (e) {
      result.errors.push(`${inputName}：${(e as Error).message}`);
    }
  }
  return result;
}
