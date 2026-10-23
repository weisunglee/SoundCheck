// Prints what the app would show for the local OBS, using the app's own loading
// and status code. Run on the machine where OBS runs:  npx tsx tools/inspect-obs.ts
import { obs } from "../src/obsClient";
import { obsAdapter } from "../src/obsAdapter";
import { obsPlugin } from "../src/plugin";
import { scenesContaining, sourceStatus } from "../src/status";
import { connectLocalObs } from "./connect-obs";

await connectLocalObs();

const state = await obsAdapter.load();
const pluginInfo = await obsPlugin.info().catch(() => null);
await obs.disconnect();

console.log(`plugin: ${pluginInfo ? `loaded ${pluginInfo.pluginVersion}` : "missing"}, stream tracks: ${state.streamTracks.join(",")}`);
console.log(`scenes (${state.sceneOrder.length}): ${state.sceneOrder.join(" | ")}`);
const groups = state.scenes.filter((s) => s.isGroup).map((s) => s.name);
console.log(`groups (${groups.length}): ${groups.join(" | ") || "none"}`);
console.log(`audio sources: ${state.sources.length}`);
console.log();

for (const scene of [state.programScene, ...state.sceneOrder.filter((s) => s !== state.programScene)]) {
  const counts: Record<string, string[]> = {};
  for (const src of state.sources) {
    const status = sourceStatus(src, scene, state.scenes, state.streamTracks);
    (counts[status] ??= []).push(src.name);
  }
  console.log(`${scene === state.programScene ? "* " : "  "}${scene}`);
  for (const [status, names] of Object.entries(counts)) {
    if (status !== "notInScene") console.log(`    ${status.padEnd(10)} ${names.join(", ")}`);
  }
}

console.log();
for (const src of state.sources) {
  const where = scenesContaining(src, state.scenes).filter((n) => state.sceneOrder.includes(n));
  const filters = src.filters.map((f) => `${f.name}${f.enabled ? "" : "(off)"}`).join(", ") || "-";
  console.log(
    `${src.name} [${src.device}]${src.global ? " global" : ""} vol=${src.volumeDb.toFixed(1)}dB muted=${src.muted} ` +
      `monitor=${src.monitorType} tracks=${src.tracks.join(",") || "none"} ` +
      `filters=${filters} scenes=${where.length}`,
  );
}
