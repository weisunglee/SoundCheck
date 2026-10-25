// Sets the app version everywhere it is stored, so a release can't ship with them out of step.
//   npm run bump -- 0.3.0       a specific version
//   npm run bump -- patch       0.2.0 → 0.2.1 (also minor, major)
// Get the result onto main, then run the Build workflow on main with "release" ticked to
// release v<version> (see .github/workflows/build.yml). The plugin has its own version, in obs-plugin/buildspec.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = (path) => join(root, path);

const current = JSON.parse(readFileSync(file("src-tauri/tauri.conf.json"), "utf8")).version;
const arg = process.argv[2];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function next(version, step) {
  const [, major, minor, patch] = version.match(SEMVER).map(Number);
  if (step === "major") return `${major + 1}.0.0`;
  if (step === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

if (!arg) {
  console.log(`Current version: ${current}. Usage: npm run bump -- <x.y.z | patch | minor | major>`);
  process.exit(1);
}
const version = ["major", "minor", "patch"].includes(arg) ? next(current, arg) : arg.replace(/^v/, "");
if (!SEMVER.test(version)) {
  console.error(`"${arg}" is not a version like 0.3.0 (or patch, minor, major).`);
  process.exit(1);
}
if (version === current) {
  console.error(`The version is already ${current}.`);
  process.exit(1);
}

/** Replaces exactly one match of `pattern` in `path`, or stops. */
function replaceOnce(path, pattern, replacement) {
  const text = readFileSync(file(path), "utf8");
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"));
  if (!matches || matches.length !== 1) {
    console.error(`${path}: expected one version to change, found ${matches?.length ?? 0}.`);
    process.exit(1);
  }
  writeFileSync(file(path), text.replace(pattern, replacement));
}

const v = current.replace(/\./g, "\\.");
replaceOnce("src-tauri/tauri.conf.json", new RegExp(`("version": ")${v}(")`), `$1${version}$2`);
replaceOnce("package.json", new RegExp(`("version": ")${v}(")`), `$1${version}$2`);
replaceOnce("src-tauri/Cargo.toml", new RegExp(`^(version = ")${v}(")`, "m"), `$1${version}$2`);
replaceOnce("src-tauri/Cargo.lock", new RegExp(`(name = "soundcheck"\\nversion = ")${v}(")`), `$1${version}$2`);
// package-lock.json carries the version twice (top level and the root package).
const lock = JSON.parse(readFileSync(file("package-lock.json"), "utf8"));
lock.version = version;
lock.packages[""].version = version;
writeFileSync(file("package-lock.json"), JSON.stringify(lock, null, 2) + "\n");

console.log(`${current} → ${version}. Get it onto main, then run the Build workflow there with "release" ticked to release v${version}.`);
