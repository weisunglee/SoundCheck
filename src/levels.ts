// Converting audio amplitudes (0..1, linear) to dBFS and to meter positions.

/** dBFS of a 0..1 amplitude, or null for silence. */
export const toDb = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : null);

/** Maps a 0..1 amplitude to a 0..1 meter position on the -60..0 dB scale. */
export function meterPosition(amplitude: number): number {
  const db = toDb(amplitude);
  return db === null ? 0 : Math.min(1, Math.max(0, (db + 60) / 60));
}
