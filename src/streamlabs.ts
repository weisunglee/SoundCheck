// JSON-RPC client for Streamlabs Desktop's local API. The backend carries the lines over the
// named pipe (see src-tauri/src/slobs.rs); requests look like
//   { jsonrpc: "2.0", id, method, params: { resource, args } }
// where `resource` is a service name ("ScenesService") or an object's resourceId
// ('AudioSource["…"]'). Subscribing to an event returns a subscription resourceId, and events
// arrive as results with `_type: "EVENT"` and that resourceId.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;

class StreamlabsClient {
  private connection: number | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptions = new Map<string, (data: any) => void>();
  private closeListeners = new Set<() => void>();

  constructor() {
    // Outside the app (e.g. the Node test tools) there is no backend to listen to.
    listen<{ connection: number; line: string }>("slobs-message", (e) => {
      if (e.payload.connection === this.connection) this.onLine(e.payload.line);
    }).catch(() => {});
    listen<number>("slobs-closed", (e) => {
      if (e.payload === this.connection) this.onClosed();
    }).catch(() => {});
  }

  async connect() {
    this.connection = await invoke<number>("slobs_connect");
  }

  disconnect() {
    invoke("slobs_disconnect").catch(() => {});
    this.onClosed();
  }

  onClose(listener: () => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  request<T = any>(resource: string, method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params: { resource, args } });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Streamlabs did not answer ${resource}.${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      invoke("slobs_send", { line }).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(String(e)));
      });
    });
  }

  /** Calls `callback` with each event of `service.channel` (e.g. ScenesService.sceneSwitched). */
  async subscribe(service: string, channel: string, callback: (data: any) => void) {
    const info = await this.request<{ resourceId: string }>(service, channel);
    this.subscriptions.set(info.resourceId, callback);
  }

  private onLine(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const pending = message.id != null ? this.pending.get(message.id) : undefined;
    if (pending) {
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Streamlabs error"));
      else pending.resolve(message.result);
      return;
    }
    const result = message.result;
    if (result?._type === "EVENT") this.subscriptions.get(result.resourceId)?.(result.data);
  }

  private onClosed() {
    if (this.connection === null) return;
    this.connection = null;
    this.subscriptions.clear();
    for (const p of this.pending.values()) p.reject(new Error("Streamlabs connection closed"));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}

export const streamlabs = new StreamlabsClient();

/**
 * Streamlabs' faders use libobs's IEC 60268-18 curve: deflection 0..1 maps piecewise onto
 * dB. A direct port of iec_db_to_def in libobs/obs-audio-controls.c.
 */
export function iecDbToDeflection(db: number): number {
  if (db >= 0) return 1;
  if (db >= -9) return ((db + 9) / 9) * 0.25 + 0.75;
  if (db >= -20) return ((db + 20) / 11) * 0.25 + 0.5;
  if (db >= -30) return ((db + 30) / 10) * 0.2 + 0.3;
  if (db >= -40) return ((db + 40) / 10) * 0.15 + 0.15;
  if (db >= -50) return ((db + 50) / 10) * 0.075 + 0.075;
  if (db >= -60) return ((db + 60) / 10) * 0.05 + 0.025;
  if (db >= -114) return ((db + 150) / 90) * 0.025;
  return 0;
}
