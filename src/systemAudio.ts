// Sound playing on this computer, and whether OBS already captures it.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { CaptureSettings } from "./adapter";

export interface SystemDevice {
  id: string;
  name: string;
  flow: "render" | "capture";
  isDefault: boolean;
  peak: number;
}

export interface SystemApp {
  pid: number;
  exe: string;
  windowTitle: string | null;
  windowClass: string | null;
  deviceId: string;
  peak: number;
}

export interface SystemAudio {
  supported: boolean;
  platform: string;
  devices: SystemDevice[];
  apps: SystemApp[];
}

/** A peak above this (about -50 dBFS) counts as making sound. */
export const SOUNDING_PEAK = 0.003;

/** Polls what is playing on the computer while `enabled`. */
export function useSystemAudio(enabled: boolean, intervalMs = 1000): SystemAudio | null {
  const [snapshot, setSnapshot] = useState<SystemAudio | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const poll = () =>
      invoke<SystemAudio>("system_audio_snapshot")
        .then((s) => alive && setSnapshot(s))
        .catch(() => {});
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled, intervalMs]);
  return snapshot;
}

/** OBS input kinds for each kind of sound, per platform. */
export const CAPTURE_KINDS = {
  input: ["wasapi_input_capture", "coreaudio_input_capture", "pulse_input_capture"],
  output: ["wasapi_output_capture", "coreaudio_output_capture", "pulse_output_capture"],
  app: ["wasapi_process_output_capture"],
} as const;

export const CAPTURE_KIND_SET = new Set<string>([...CAPTURE_KINDS.input, ...CAPTURE_KINDS.output, ...CAPTURE_KINDS.app]);


// OBS stores a window as "title:class:exe", escaping "#" and ":" inside each part.
const encodePart = (s: string) => s.replace(/#/g, "#22").replace(/:/g, "#3A");
const decodePart = (s: string) => s.replace(/#3A/g, ":").replace(/#22/g, "#");

export function obsWindowString(app: SystemApp): string {
  return [app.windowTitle ?? "", app.windowClass ?? "", app.exe].map(encodePart).join(":");
}

function windowExe(window: unknown): string | null {
  if (typeof window !== "string" || !window) return null;
  const parts = window.split(":");
  return decodePart(parts[parts.length - 1]).toLowerCase();
}

/** Resolves OBS's "default" device setting to the device it means right now. */
function resolveDevice(deviceId: unknown, flow: "render" | "capture", devices: SystemDevice[]): string | null {
  if (typeof deviceId !== "string") return null;
  if (deviceId === "" || deviceId === "default") return devices.find((d) => d.flow === flow && d.isDefault)?.id ?? null;
  return deviceId;
}

export interface Coverage {
  /** OBS sources that capture it, if any. */
  sources: string[];
  /** True when it is captured only as part of a whole-device capture (e.g. desktop audio). */
  viaDevice: boolean;
}

export function deviceCoverage(
  device: SystemDevice,
  captures: CaptureSettings,
  devices: SystemDevice[],
): Coverage {
  const kinds: readonly string[] = device.flow === "capture" ? CAPTURE_KINDS.input : CAPTURE_KINDS.output;
  const sources = [...captures]
    .filter(([, c]) => kinds.includes(c.kind) && resolveDevice(c.settings.device_id, device.flow, devices) === device.id)
    .map(([name]) => name);
  return { sources, viaDevice: false };
}

export function appCoverage(
  app: SystemApp,
  captures: CaptureSettings,
  devices: SystemDevice[],
): Coverage {
  const exe = app.exe.toLowerCase();
  const direct = [...captures]
    .filter(([, c]) => (CAPTURE_KINDS.app as readonly string[]).includes(c.kind) && windowExe(c.settings.window) === exe)
    .map(([name]) => name);
  if (direct.length > 0) return { sources: direct, viaDevice: false };
  // Desktop audio capturing the device the app plays to also records the app.
  const device = devices.find((d) => d.id === app.deviceId);
  const viaDevice = device ? deviceCoverage(device, captures, devices).sources : [];
  return { sources: viaDevice, viaDevice: viaDevice.length > 0 };
}

/** "Spotify.exe" → "Spotify". */
export function appLabel(app: SystemApp): string {
  return app.exe.replace(/\.exe$/i, "");
}
