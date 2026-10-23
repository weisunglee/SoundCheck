// JSON-RPC client for Streamlabs Desktop's local API. In the app the backend carries the lines
// over the named pipe (see src-tauri/src/slobs.rs); the test tools plug in their own transport.
// Requests look like
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
/**
 * Streamlabs gives all API clients together 2 points a second, and some calls (getScenes) cost
 * one; over the limit it answers with this error. The points come back every second.
 */
const RATE_LIMITED = /Reached the limit of calls/;
const RATE_LIMIT_RETRY_MS = 1100;
const RATE_LIMIT_RETRIES = 3;

/** Carries lines to and from Streamlabs; calls `onLine` per received line and `onClosed` when the connection ends. */
export interface Transport {
  connect(): Promise<void>;
  disconnect(): void;
  send(line: string): Promise<void>;
}
export type TransportFactory = (onLine: (line: string) => void, onClosed: () => void) => Transport;

const tauriTransport: TransportFactory = (onLine, onClosed) => {
  let connection: number | null = null;
  // Outside the app there is no backend to listen to.
  listen<{ connection: number; line: string }>("slobs-message", (e) => {
    if (e.payload.connection === connection) onLine(e.payload.line);
  }).catch(() => {});
  listen<number>("slobs-closed", (e) => {
    if (e.payload === connection) onClosed();
  }).catch(() => {});
  return {
    async connect() {
      connection = await invoke<number>("slobs_connect");
    },
    disconnect() {
      invoke("slobs_disconnect").catch(() => {});
    },
    async send(line) {
      await invoke("slobs_send", { line });
    },
  };
};

class StreamlabsClient {
  private connected = false;
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptions = new Map<string, (data: any) => void>();
  private closeListeners = new Set<() => void>();
  /** Event channels by "service.channel": who listens, and whether this connection subscribed yet. */
  private channels = new Map<string, { listeners: Set<(data: any) => void>; subscribed: boolean }>();

  constructor(factory: TransportFactory) {
    this.transport = this.makeTransport(factory);
  }

  /** Replaces how lines travel (the Node tools talk to the pipe directly). */
  useTransport(factory: TransportFactory) {
    this.transport = this.makeTransport(factory);
  }

  private makeTransport(factory: TransportFactory) {
    return factory(
      (line) => this.onLine(line),
      () => this.onClosed(),
    );
  }

  async connect() {
    await this.transport.connect();
    this.connected = true;
  }

  disconnect() {
    this.transport.disconnect();
    this.onClosed();
  }

  onClose(listener: () => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async request<T = any>(resource: string, method: string, ...args: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(resource, method, args);
      } catch (e) {
        if (attempt >= RATE_LIMIT_RETRIES || !RATE_LIMITED.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
      }
    }
  }

  private send<T>(resource: string, method: string, args: unknown[]): Promise<T> {
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
      this.transport.send(line).catch((e) => {
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

  /**
   * Calls `callback` with each event of `service.channel` until the returned function is called.
   * The API has no unsubscribe, so each channel is subscribed once per connection and shared.
   */
  on(service: string, channel: string, callback: (data: any) => void): () => void {
    const key = `${service}.${channel}`;
    let entry = this.channels.get(key);
    if (!entry) {
      entry = { listeners: new Set(), subscribed: false };
      this.channels.set(key, entry);
    }
    const e = entry;
    e.listeners.add(callback);
    if (!e.subscribed) {
      e.subscribed = true;
      this.subscribe(service, channel, (data) => {
        for (const listener of e.listeners) listener(data);
      }).catch(() => {
        e.subscribed = false;
      });
    }
    return () => e.listeners.delete(callback);
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
    if (!this.connected) return;
    this.connected = false;
    this.subscriptions.clear();
    for (const entry of this.channels.values()) entry.subscribed = false;
    for (const p of this.pending.values()) p.reject(new Error("Streamlabs connection closed"));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}

export const streamlabs = new StreamlabsClient(tauriTransport);

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
