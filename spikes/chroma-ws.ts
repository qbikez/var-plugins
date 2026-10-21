// Phase 0 spike: Chroma WebSocket API — connect → send app info → send effects → close.
// Per Razer's docs (assets.razerzone.com/dev_portal/websocket) the socket *is* the session:
// no heartbeat, closing the connection uninitializes. Effects carry `"endpoint": "keyboard"`.
// The documented endpoint is wss://chromasdk.io:13339 (chromasdk.io → 127.0.0.1), but this
// Synapse build only listens on ws://[::1]:13337, so that's the default.
//
// Usage: bun spikes/chroma-ws.ts [--url <ws-url>] [--static] <test | walk [ms] | cell <r> <c>>
//   --static   send one CHROMA_STATIC blue first — the simplest possible effect, to check the transport
import { rgb, runPattern, USAGE, type Grid } from "./patterns";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv.splice(i, 1 + (name === "--url" ? 1 : 0))[1] ?? "";
};
const url = flag("--url") ?? "ws://localhost:13337/razer/chromasdk";
const sendStatic = flag("--static") !== undefined;
const [mode = "test", ...args] = argv;

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s`, ...a);

const ws = new WebSocket(url);
ws.onmessage = (e) => log("◀", String(e.data));
ws.onerror = (e) => log("error:", (e as ErrorEvent).message ?? e);
ws.onclose = (e) => {
  log(`closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
  process.exit(0);
};
await new Promise((resolve) => (ws.onopen = resolve));
log("connected", url);

function send(msg: object) {
  const text = JSON.stringify(msg);
  log("▶", text.length > 160 ? `${text.slice(0, 160)}… (${text.length} B)` : text);
  ws.send(text);
}

send({
  title: "herdr-chroma spike",
  description: "Phase 0 WebSocket spike",
  author: { name: "herdr-chroma-plugin", contact: "local" },
  device_supported: ["keyboard"],
  category: "application",
});
await Bun.sleep(1500);

if (sendStatic) {
  send({ endpoint: "keyboard", effect: "CHROMA_STATIC", param: { color: rgb(0, 0, 255) } });
  log("keyboard should be solid blue for 3 s");
  await Bun.sleep(3000);
}

process.on("SIGINT", () => {
  send({ endpoint: "keyboard", effect: "CHROMA_NONE" });
  ws.close();
});

async function show(grid: Grid) {
  send({ endpoint: "keyboard", effect: "CHROMA_CUSTOM", param: grid });
}

if (mode === "help") console.log(USAGE);
else await runPattern(show, mode, args);
send({ endpoint: "keyboard", effect: "CHROMA_NONE" });
ws.close();
