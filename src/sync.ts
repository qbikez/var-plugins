// Sharing agent statuses between herdr instances on machines that share one keyboard through a KVM.
// Each instance owns a machine slot (a block of zones) and publishes its statuses to a hub; the hub relays every slot
// to every peer, so whichever machine currently has the keyboard can light all zones.
import type { Server, ServerWebSocket } from "bun";

export type Slots = Map<number, string[]>;

interface Hello { slot: number; statuses: string[] }

const isHello = (m: any): m is Hello =>
  Number.isInteger(m?.slot) && Array.isArray(m.statuses) && m.statuses.every((s: unknown) => typeof s === "string");

// The hub is a plain relay: latest statuses per slot, dropped when the owning peer disconnects.
export function serveHub(port: number): Server<unknown> {
  const slots: Slots = new Map();
  const owners = new Map<ServerWebSocket<unknown>, number>();
  const state = () => JSON.stringify({ slots: Object.fromEntries(slots) });

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("herdr-chroma hub (websocket only)", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.subscribe("state");
        ws.send(state());
      },
      message(ws, raw) {
        let msg: unknown;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!isHello(msg)) return;
        owners.set(ws, msg.slot);
        slots.set(msg.slot, msg.statuses);
        server.publish("state", state());
      },
      close(ws) {
        const slot = owners.get(ws);
        owners.delete(ws);
        if (slot === undefined || [...owners.values()].includes(slot)) return;
        slots.delete(slot);
        server.publish("state", state());
      },
    },
  });
  console.log(`hub listening on ws://0.0.0.0:${port}`);
  return server;
}

export interface HubClient {
  publish(statuses: string[]): void;
  close(): void;
}

// Reconnects every 2 s; while disconnected, onSlots gets an empty map so remote zones go dark rather than stale.
export function joinHub(url: string, slot: number, onSlots: (slots: Slots) => void): HubClient {
  let ws: WebSocket | undefined;
  let latest: string[] = [];
  let stopped = false;
  let warned = false;
  const send = () => ws?.send(JSON.stringify({ slot, statuses: latest } satisfies Hello));

  const connect = () => {
    const sock = new WebSocket(url);
    sock.onopen = () => {
      ws = sock;
      warned = false;
      console.log(`hub connected: ${url}`);
      send();
    };
    sock.onmessage = (e) => {
      const { slots } = JSON.parse(String(e.data)) as { slots: Record<string, string[]> };
      onSlots(new Map(Object.entries(slots).map(([s, statuses]) => [Number(s), statuses])));
    };
    sock.onclose = () => {
      if (ws === sock) {
        ws = undefined;
        onSlots(new Map());
      }
      if (stopped) return;
      if (!warned) console.log(`hub unreachable: ${url}, retrying`);
      warned = true;
      setTimeout(connect, 2000);
    };
  };
  connect();

  return {
    publish(statuses) {
      latest = statuses;
      send();
    },
    close() {
      stopped = true;
      ws?.close();
    },
  };
}
