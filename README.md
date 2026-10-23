<p align="center"><img src="src-tauri/icons/128x128.png" alt="SoundCheck" width="96"></p>

# SoundCheck

English | [繁體中文](README.zh-TW.md)

An audio tool for streamers. Test your sound before you go live, see what your viewers actually hear while you're live, and set up your streaming software's audio in plain words. Streaming software spreads audio settings across many menus; SoundCheck only deals with sound and puts it in one place.

- **Streaming software**: OBS Studio 28 or newer, and Streamlabs Desktop. Pick one in the top right, or let SoundCheck use whichever is running (OBS first when both are).
- **Languages**: 繁體中文, 简体中文, English, 日本語, 한국어. The first start follows the system language.
- **Themes**: light, dark, or follow the system.
- **Platforms**: Windows (the main test platform), macOS and Linux. Detecting the computer's own sounds and capturing a single app are Windows only for now.

## Features

| Feature | What it does |
|---|---|
| **Connection guide** | Reads the local OBS's WebSocket settings (port and password) and connects on its own. When it can't, it shows the steps for the actual reason: server turned off, wrong password, OBS not running, and so on. Streamlabs needs no setup. |
| **Mixer** | Every audio source used in any scene, with live level meters and the recommended peak range marked. Each source shows whether viewers can hear it in the current scene, and if not, why. |
| **Stream meter** | What viewers hear: the level, peaks and short-term loudness (LUFS) of the real stream mix, kept apart from what your headphones get. |
| **Sound test** | Records a stretch of the mix that actually goes to the stream, then plays it back to you with a plain verdict ("a bit quiet", "clipping"). The stream is muted while it plays back, so your viewers don't hear the replay. |
| **Monitoring** | Switch a source's monitoring mode, with a sentence on who hears what in each mode. |
| **Scenes** | See and switch the program scene, and compare all scenes side by side. Sources update right away. |
| **Sounds on this computer** | Apps and devices playing sound right now, which of them the stream doesn't capture yet, and a one-click way to add them (Windows). |
| **Add-sound wizard** | Asks "what do you want to add?" (a mic, everything the computer plays, one app) instead of listing source types. |
| **Filter wizard** | Starts from the problem ("background noise", "volume jumps around", "shouting clips") and adds the right filters in the right order, explains each one, and draws thresholds on a live level bar. |
| **Quick settings** | Volume, mute, show or hide in the scene, balance, sync offset, tracks. |
| **Profiles** | Save every source's audio settings and filters, and apply them again in one go. A backup is saved before each apply. |

### What viewers can hear

In OBS, volume and filters belong to the audio source, not the scene: a source used in several scenes has one set of settings. So SoundCheck doesn't do per-scene volumes. It finds every audio source and tells you its status in the **current** scene:

| Status | Meaning |
|---|---|
| Making sound / No sound right now | Viewers hear it; the meter tells whether sound is coming in. |
| Not in this scene | Only in other scenes; you hear it after switching. |
| Hidden | In the scene, but its item is hidden (the eye is off). |
| Muted | Muted. |
| Only you hear it | Monitoring is "monitor only": headphones only, not the stream. |
| Not on stream | Not sent to the track the stream uses (recordings may still have it). |
| Global | A desktop or mic device from the audio settings, present in every scene. |

The cards stay in a fixed order (global devices first, then the software's own order), so a card never moves when its status changes, and you can undo a mute by clicking the same spot again.

### OBS and Streamlabs

| | OBS Studio | Streamlabs Desktop |
|---|---|---|
| Volume, mute, scenes, show or hide | ✓ | ✓ |
| Monitoring, tracks, sync offset | ✓ | ✓ |
| Filter wizard, profiles | ✓ | ✓ |
| Source level meters | ✓ | ✓ with the plugin |
| Stream meter, sound test | ✓ with the plugin | ✓ with the plugin |
| Balance | ✓ | — (Streamlabs has none) |
| Connecting to another computer | ✓ (enter its address) | — |

## Getting started

1. **OBS**: in OBS, open *Tools → WebSocket Server Settings* and tick *Enable WebSocket server*. SoundCheck reads the port and password itself. **Streamlabs**: just have it open.
2. Open SoundCheck. If it can't connect, it explains what to do.
3. For the sound test and the stream meter (and source meters in Streamlabs), click **Install plugin** in the top right.
   - OBS: you close OBS yourself (so you can end a stream and save first), SoundCheck installs the plugin, and a button opens OBS again and checks that the plugin loaded.
   - Streamlabs: a first install loads right away, no restart. Updating needs Streamlabs closed, because it keeps a loaded plugin file locked.

## How it works

### The plugin

obs-websocket can't give out the mixed stream audio, so SoundCheck comes with a small libobs plugin (`obs-plugin/`, C++). It only taps the audio; playback and analysis happen in the app:

```
mixer ──(stream track)──▶ plugin ──local socket──▶ SoundCheck ──▶ headphones
                                                       └─▶ stream meter, loudness
```

- **Tap**: `obs_add_raw_audio_callback` on the stream's track, sent as 48 kHz stereo float PCM over a local socket (not WebSocket; JSON would be too heavy).
- **Which track the stream uses**: asked from the live streaming output's mixers.
- **Pausing the stream during playback**: the plugin takes every source off the stream track and restores it afterwards. The app sends a heartbeat during playback; if it stops (a crash or disconnect), the plugin restores the tracks by itself within seconds.
- The plugin never adds tracks, sources or filters and never feeds sound back into the mix. It has no UI and does nothing until the app asks.

There are two builds that share the request handling (`obs-plugin/src/requests.cpp`):

- **`soundcheck`** for OBS: the app talks to it through obs-websocket vendor requests. It installs into `C:\ProgramData\obs-studio\plugins\soundcheck\` on Windows, `~/Library/Application Support/obs-studio/plugins/` on macOS and `~/.config/obs-studio/plugins/` on Linux, without admin rights.
- **`soundcheck-streamlabs`** for Streamlabs (`-DSOUNDCHECK_STREAMLABS=ON`): Streamlabs has neither obs-websocket nor OBS's frontend API, but it loads libobs modules from `%APPDATA%\slobs-plugins\obs-plugins\64bit\`, at startup or right away through `ObsUserPluginsService.initializeModule`. The plugin opens a loopback control port and writes the port and a random token to `control.json` in its data folder; the app keeps one connection to it (`src-tauri/src/streamlabs_plugin.rs`). It also meters every source with libobs's own volume meter, because Streamlabs gives outside programs no levels.

Streamlabs' libobs renders audio once per canvas (horizontal and vertical output), hands each mix to every audio callback, and reads each callback's `param` as an `obs_encoder`. So the tap passes a zeroed `param`, asks libobs for no conversion (a shared converter would get both canvases' audio), keeps the first block of each timestamp (the main canvas), and converts to 48 kHz itself. This behaves the same in OBS.

The plugin version comes from `obs-plugin/buildspec.json`. The app bundles the plugin and offers to install or update only when its version is newer than the one loaded or installed. Each install step is written to `install.log` (Windows: `%LOCALAPPDATA%\io.github.weisunglee.soundcheck\logs\`).

### Streaming software adapters

`src/adapter.ts` is the seam between SoundCheck and the streaming software. Each program has an adapter (`src/obsAdapter.ts`, `src/streamlabsAdapter.ts`) that loads state, reports changes and applies settings; an adapter leaves out what its program can't do, and `capabilitiesOf()` derives from that what the UI shows. `src/audio.ts` (`useAudio`) is the one state layer for both. The filter wizard (`src/filters.ts`) and profiles (`src/profiles.ts`) also go through the adapter. Who-can-hear-what is decided in `src/status.ts`; the plugin's protocol and install decisions are in `src/plugin.ts`. Domain terms are in [CONTEXT.md](CONTEXT.md).

- **OBS**: `obs-websocket-js` against obs-websocket v5, which OBS 28+ includes.
- **Streamlabs**: JSON-RPC over its named pipe (`\\.\pipe\slobs`, or `slobs.sock` on macOS); the transport is `src-tauri/src/slobs.rs`. Its documented API only sets volume, mute, scenes and item visibility. Monitoring, tracks, sync offset and filters use Streamlabs' internal objects, which its API forwards calls to when the documented object lacks the method. Things to know:
  - All outside programs share 2 API points a second, and `getScenes` costs one; the client retries after a second when over the limit, and small changes such as a mute are applied without reloading everything.
  - Its own copy of a filter's settings keeps exactly what it was last sent, so SoundCheck always sends the complete settings.
  - Faders use libobs's IEC curve, so volumes are converted from dB to a fader position.

### Current limits

- With OBS on another computer, the mixer, filter wizard and profiles work; the sound test, stream meter, plugin install and sound detection only work with software on this computer.
- The filter wizard's live level is measured after all filters (as OBS's meter is), so it drops to the bottom while a noise gate is closed.
- The sound test's verdict thresholds (quiet below -24 LUFS, loud above -10 LUFS, with YouTube's -14 LUFS as reference) are provisional.

## Verification

Tested on Windows 11 with OBS 32.2.2 and Streamlabs Desktop 1.21.9 (libobs 31.1.2sl). The plugin is built from OBS 31.1.1 sources.

- `npx tsx tools/verify-features.ts` checks the filter wizard and profiles against a running OBS, on a temporary scene and source that it removes again.
- `npx tsx tools/verify-streamlabs.ts` does the same for the Streamlabs adapter (monitoring, tracks, sync offset, events, filters, profiles), on a temporary source in no scene.
- `node tools/verify-streamlabs-plugin.mjs` checks the Streamlabs plugin: loading, the control port and token, source meters, the tap's rate, and pausing and restoring stream audio without changing Streamlabs' own settings.
- `npx tsx tools/inspect-obs.ts` prints what the app sees for the local OBS, scene by scene.
- Unit tests cover source status, grouping, version and plugin decisions, connection order, capabilities and the fader curve.

The full test log, including what is still unverified, is in the [Chinese README](README.zh-TW.md#驗證紀錄).

## Development

Needs Node.js 22+ and stable Rust.

```sh
npm install
npm run tauri dev     # run the desktop app in development
npm run tauri build   # build installers
npm test              # unit tests (vitest)
npm run check:i18n    # every UI text translated in every language
```

Building the plugin follows the obs-plugintemplate layout in `obs-plugin/` (for example `cmake --preset windows-x64`, and `-B build_x64_streamlabs -DSOUNDCHECK_STREAMLABS=ON` for the Streamlabs build). The Windows app bundles both DLLs (`src-tauri/tauri.windows.conf.json`).

### Continuous integration and releases

`.github/workflows/build.yml` runs on every pull request and push to `main`: type-check, unit tests and the translation check, then the Rust tests, the plugin and the app on Windows and macOS (universal). The installers are kept as artifacts of each run.

To release, set the new version and push it to `main`:

```sh
npm run bump -- 0.3.0     # or patch / minor / major; updates every file that holds the version
git commit -am "Release 0.3.0" && git push
```

A push that changes the version in `src-tauri/tauri.conf.json` to one without a tag builds both platforms into a draft release `v0.3.0` and publishes it once the checks pass and both installers are in it. The plugin has its own version, in `obs-plugin/buildspec.json`. Neither installer is code-signed yet: Windows SmartScreen warns about an unknown publisher, and macOS asks to open the app with right-click → Open the first time.

### Translations

UI text is written in Traditional Chinese inside `t("…")`; the other languages are in `src/locales/`, keyed by the Chinese text (the gettext approach). After adding or changing text, run `npm run check:i18n`: it lists missing and unused translations and mismatched `{placeholders}`. Text stored as data and shown later is marked with `msg("…")` and translated when shown. UI text says "streaming software" in general and names the program (`{app}`) only in steps that point at its menus. Messages from the Rust side are in `src-tauri/src/i18n.rs`.

## License notes

Icons are from [Lucide](https://lucide.dev) (ISC license, see `third_party/lucide-LICENSE.txt`).
