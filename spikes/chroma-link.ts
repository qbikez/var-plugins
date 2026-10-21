// Phase 0 spike: does a zoned keyboard (Ornata V3 TKL) listen to Chroma Link effects?
// Its device module is a ChromaLinkHandler, so /keyboard effects may be ignored.
// Chroma Link has 5 LEDs (index 0 = "all", 1–4 = individual); CHROMA_CUSTOM param is a 5-element BGR array.
// Usage: bun spikes/chroma-link.ts
import { rgb } from "./patterns";

const BASE = "http://localhost:54235/razer/chromasdk";

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    // HTTP.sys rejects bodiless PUTs without Content-Length (411).
    body: body === undefined ? "" : JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

const { uri } = await call("POST", BASE, {
  title: "herdr-chroma link spike",
  description: "Phase 0 Chroma Link spike",
  author: { name: "herdr-chroma-plugin", contact: "local" },
  device_supported: ["keyboard", "chromalink"],
  category: "application",
});
console.log("session:", uri);

const t0 = Date.now();
while (!(await call("PUT", `${uri}/heartbeat`).then(() => true, () => false))) {
  if (Date.now() - t0 > 10_000) throw new Error(`session listener never came up: ${uri}`);
  await Bun.sleep(100);
}
const heartbeat = setInterval(() => call("PUT", `${uri}/heartbeat`).catch(() => {}), 1000);

const red = rgb(255, 0, 0), green = rgb(0, 255, 0), blue = rgb(0, 0, 255), yellow = rgb(255, 255, 0), magenta = rgb(255, 0, 255);
const steps: [string, string, unknown][] = [
  ["A: chromalink STATIC red", "chromalink", { effect: "CHROMA_STATIC", param: { color: red } }],
  ["B: chromalink CUSTOM [red, green, blue, yellow, magenta]", "chromalink", { effect: "CHROMA_CUSTOM", param: [red, green, blue, yellow, magenta] }],
  ["C: chromalink CUSTOM only LED 1 green, others off", "chromalink", { effect: "CHROMA_CUSTOM", param: [0, green, 0, 0, 0] }],
  ["D: chromalink CUSTOM only LED 0 blue, others off", "chromalink", { effect: "CHROMA_CUSTOM", param: [blue, 0, 0, 0, 0] }],
];
for (const [label, device, body] of steps) {
  const res = await call("PUT", `${uri}/${device}`, body);
  console.log(label, "→", JSON.stringify(res));
  await Bun.sleep(4000);
}

clearInterval(heartbeat);
await call("DELETE", uri);
console.log("session released");
