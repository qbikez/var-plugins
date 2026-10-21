// Standalone hub: relays agent statuses between herdr-chroma instances from a server neither of them runs, e.g. a VPS.
// Needs neither herdr nor a keyboard.
// Usage: bun src/hub.ts [--port 7777] [--host 0.0.0.0]   (or PORT / HOST env; HUB_TOKEN requires ?token=<secret> from peers)
//   peers: bun src/main.ts --machine N --hub ws://<server>:7777/?token=<secret>   (wss:// behind a TLS reverse proxy)
import { serveHub } from "./sync";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const port = Number(arg("--port") ?? process.env.PORT ?? 7777);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0..65535");
const hostname = arg("--host") ?? process.env.HOST ?? "0.0.0.0";
const token = process.env.HUB_TOKEN || undefined;
if (!token) console.log("warning: HUB_TOKEN not set, anyone who can reach the hub can publish statuses");

const server = serveHub(port, { hostname, token });
const stop = () => {
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
