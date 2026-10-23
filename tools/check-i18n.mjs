// Lists UI texts a translation table is missing (or no longer uses), and placeholders that
// differ from the original. Texts are found as t("…") and msg("…") calls in src/.
//   node tools/check-i18n.mjs            report only
//   node tools/check-i18n.mjs --list     print every source text (to start a new table)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name) && !path.includes("/locales/")) files.push(path);
  }
};
walk(root);

const texts = new Set();
for (const file of files) {
  for (const m of readFileSync(file, "utf8").matchAll(/\b(?:t|msg)\("((?:[^"\\]|\\.)*)"/g)) texts.add(JSON.parse(`"${m[1]}"`));
}

if (process.argv.includes("--list")) {
  for (const text of [...texts].sort()) console.log(JSON.stringify(text));
  process.exit(0);
}

const placeholders = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(",");
let problems = 0;
for (const lang of ["zh-CN", "en", "ja", "ko"]) {
  const table = (await import(pathToFileURL(join(root, "locales", `${lang}.ts`)).href)).default;
  const missing = [...texts].filter((t) => !(t in table));
  const unused = Object.keys(table).filter((k) => !texts.has(k));
  const mismatched = Object.entries(table).filter(([k, v]) => texts.has(k) && placeholders(k) !== placeholders(v));
  for (const t of missing) console.log(`${lang}  missing   ${t}`);
  for (const t of unused) console.log(`${lang}  unused    ${t}`);
  for (const [k] of mismatched) console.log(`${lang}  {…} differ ${k}`);
  problems += missing.length + unused.length + mismatched.length;
}
console.log(problems === 0 ? `OK: ${texts.size} texts translated in every language` : `${problems} problems`);
process.exit(problems === 0 ? 0 : 1);
