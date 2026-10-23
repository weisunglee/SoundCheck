// Connects the app's obs-websocket client to this computer's OBS, with the settings OBS saved.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { obs } from "../src/obsClient";

export async function connectLocalObs() {
  const configPath =
    process.platform === "win32"
      ? join(process.env.APPDATA!, "obs-studio/plugin_config/obs-websocket/config.json")
      : join(homedir(), "Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  await obs.connect(`ws://127.0.0.1:${config.server_port}`, config.auth_required ? config.server_password : undefined);
}
