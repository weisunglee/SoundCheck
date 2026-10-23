// Converting audio amplitudes (0..1, linear) to dBFS and to meter positions.

/** dBFS of a 0..1 amplitude, or null for silence. */
export const toDb = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : null);

/** One source's meter reading: [magnitude, peak, inputPeak] per channel, as 0..1 amplitudes. */
export interface MeterReading {
  name: string;
  channels: number[][];
}

/**
 * Turns meter readings (obs-websocket's InputVolumeMeters, or the plugin's GetSourceLevels) into
 * meter positions from the post-fader peak, and pre-fader input peaks in dBFS (left out while
 * silent).
 */
export function readMeters(readings: MeterReading[]): { levels: Record<string, [number, number]>; inputDb: Record<string, number> } {
  const levels: Record<string, [number, number]> = {};
  const inputDb: Record<string, number> = {};
  for (const { name, channels } of readings) {
    const [l, r] = channels;
    const left = meterPosition(l?.[1] ?? 0);
    levels[name] = [left, r ? meterPosition(r[1]) : left];
    const rawPeak = toDb(Math.max(0, ...channels.map((ch) => ch[2] ?? 0)));
    if (rawPeak !== null) inputDb[name] = rawPeak;
  }
  return { levels, inputDb };
}

/** Maps a 0..1 amplitude to a 0..1 meter position on the -60..0 dB scale. */
export function meterPosition(amplitude: number): number {
  const db = toDb(amplitude);
  return db === null ? 0 : Math.min(1, Math.max(0, (db + 60) / 60));
}
