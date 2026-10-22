// Brokered alternative to the websocket hub: every instance publishes its own slot's statuses as a retained message on
// <topic>/<slot> and subscribes to <topic>/+, so each one rebuilds the whole state from the broker. No hub process is needed,
// and a last-will clears a slot's retained message when its owner drops off.
import mqtt from "mqtt";
import type { HubClient, Slots } from "./sync";

export const DEFAULT_TOPIC = "herdr-chroma";

const parseStatuses = (payload: Buffer): string[] | undefined => {
  try {
    const v = JSON.parse(payload.toString());
    return Array.isArray(v) && v.every((s) => typeof s === "string") ? v : undefined;
  } catch {
    return undefined;
  }
};

// Credentials go in the URL: mqtts://user:pass@host:8883. While the broker is unreachable, onSlots gets an empty map
// so remote zones go dark rather than stale.
export function joinMqtt(url: string, slot: number, onSlots: (slots: Slots) => void, topic = DEFAULT_TOPIC): HubClient {
  const mine = `${topic}/${slot}`;
  const slots: Slots = new Map();
  let warned = false;
  let latest: string[] | undefined;
  const send = () => {
    if (latest) client.publish(mine, latest.length ? JSON.stringify(latest) : "", { retain: true, qos: 1 });
  };

  const client = mqtt.connect(url, {
    reconnectPeriod: 2000,
    will: { topic: mine, payload: Buffer.alloc(0), retain: true, qos: 1 },
  });

  client.on("connect", () => {
    warned = false;
    console.log(`mqtt connected: ${client.options.host}, topic ${topic}/+`);
    client.subscribe(`${topic}/+`, { qos: 1 });
    // The last-will may have cleared our slot while we were away, so republish the full local state on every connect.
    send();
  });
  client.on("message", (t, payload) => {
    const s = Number(t.slice(topic.length + 1));
    if (!Number.isInteger(s) || s === slot) return;
    const statuses = payload.length ? parseStatuses(payload) : [];
    if (!statuses) return;
    if (statuses.length) slots.set(s, statuses);
    else slots.delete(s);
    onSlots(new Map(slots));
  });
  client.on("close", () => {
    if (slots.size) {
      slots.clear();
      onSlots(new Map());
    }
  });
  client.on("error", (e) => {
    if (!warned) console.log(`mqtt unreachable: ${e.message}, retrying`);
    warned = true;
  });

  return {
    publish(statuses) {
      latest = statuses;
      if (client.connected) send();
    },
    close() {
      // Clear our retained state so peers don't keep showing a machine that is gone.
      client.publish(mine, "", { retain: true, qos: 1 }, () => client.end());
    },
  };
}
