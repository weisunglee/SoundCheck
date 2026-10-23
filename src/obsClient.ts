// The one obs-websocket connection. connection.ts opens and closes it; obsAdapter.ts and
// plugin.ts send requests over it.
import OBSWebSocket from "obs-websocket-js";

export const obs = new OBSWebSocket();
