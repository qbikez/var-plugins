// Phase 0 spike: Chroma REST session → heartbeat → CHROMA_CUSTOM grid → DELETE on exit.
// Usage: bun spikes/chroma-grid.ts <test | walk [ms] | cell <r> <c>>
import { runPattern, type Grid } from "./patterns";

const BASE = "http://localhost:54235/razer/chromasdk";

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    // HTTP.sys rejects bodiless PUTs without Content-Length (411).
    body: body === undefined ? "" : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const init = await call("POST", BASE, {
  title: "herdr-chroma spike",
  description: "Phase 0 grid spike",
  author: { name: "herdr-chroma-plugin", contact: "local" },
  device_supported: ["keyboard"],
  category: "application",
});
const uri: string = init.uri;
console.log("session:", uri);

// Synapse spawns a per-app proxy that opens this listener ~100 ms after init; wait for it.
const t0 = Date.now();
while (!(await call("PUT", `${uri}/heartbeat`).then(() => true, () => false))) {
  if (Date.now() - t0 > 10_000) throw new Error(`session listener never came up: ${uri}`);
  await Bun.sleep(100);
}
console.log(`session ready after ${Date.now() - t0} ms`);

const heartbeat = setInterval(() => call("PUT", `${uri}/heartbeat`).catch(console.error), 1000);
let closed = false;
async function close() {
  if (closed) return;
  closed = true;
  clearInterval(heartbeat);
  await call("DELETE", uri).catch(console.error);
  console.log("session released");
}
process.on("SIGINT", () => close().then(() => process.exit(0)));

async function show(grid: Grid) {
  const res = await call("PUT", `${uri}/keyboard`, { effect: "CHROMA_CUSTOM", param: grid });
  if (res?.result !== 0) console.warn("keyboard PUT result:", res);
}

const [mode = "test", ...args] = process.argv.slice(2);
await runPattern(show, mode, args);
await close();
