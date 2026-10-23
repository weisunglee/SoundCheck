// Plain-language reading of stream loudness, shared by the live meter and the sound test.
//
// These are rough rules of thumb, using YouTube's -14 LUFS normalization target as the
// reference; they should be tuned with more real recordings.

export const TOO_QUIET_LUFS = -24;
export const TOO_LOUD_LUFS = -10;
/** Peaks above this are about to clip. */
export const CLIP_DBFS = -1;

export type Tone = "ok" | "warn" | "bad";

export function loudnessVerdict(lufs: number | null, peakDbfs: number | null, clipped = false): { tone: Tone; text: string } {
  if (peakDbfs === null || lufs === null) {
    return { tone: "bad", text: "幾乎沒有聲音。觀眾現在聽不到任何東西，請確認音訊來源有送到直播音軌。" };
  }
  if (clipped || peakDbfs > CLIP_DBFS) {
    return { tone: "bad", text: "有爆音。最大聲的地方已經頂到上限，觀眾會聽到破音，請把最大聲的來源調小。" };
  }
  if (lufs < TOO_QUIET_LUFS) {
    return { tone: "warn", text: `整體偏小（${lufs.toFixed(0)} LUFS），觀眾可能要把音量開很大才聽得清楚。` };
  }
  if (lufs > TOO_LOUD_LUFS) {
    return { tone: "warn", text: `整體偏大（${lufs.toFixed(0)} LUFS），長時間聽會覺得吵。` };
  }
  return { tone: "ok", text: `音量適中（${lufs.toFixed(0)} LUFS）。` };
}

export const toDb = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : null);
