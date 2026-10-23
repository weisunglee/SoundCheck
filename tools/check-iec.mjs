// Checks the IEC fader curve port against points computed by libobs's iec_db_to_def:
//   npx tsx tools/check-iec.mjs
import { iecDbToDeflection } from "../src/streamlabs.ts";

// [dB, deflection] from the libobs formula, segment boundaries and a point inside each segment.
const cases = [
  [0, 1], [-4.5, 0.875], [-9, 0.75], [-14.5, 0.625], [-20, 0.5], [-25, 0.4], [-30, 0.3],
  [-35, 0.225], [-40, 0.15], [-45, 0.1125], [-50, 0.075], [-55, 0.05], [-60, 0.025],
  [-105, 0.0125], [-114, 0.01], [-200, 0],
];
let failed = 0;
for (const [db, expected] of cases) {
  const got = iecDbToDeflection(db);
  const ok = Math.abs(got - expected) < 1e-9;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${db} dB -> ${got} (expected ${expected})`);
}
// Monotonic: a louder dB never gives a smaller deflection.
let prev = -1;
for (let db = -120; db <= 0; db += 0.5) {
  const d = iecDbToDeflection(db);
  if (d < prev) (failed++, console.log(`FAIL  not monotonic at ${db} dB`));
  prev = d;
}
console.log(failed === 0 ? "ALL PASSED" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
