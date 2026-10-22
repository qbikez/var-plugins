// Phase 0 spike: light each of the 5 Chroma Link LEDs in turn, then all at once in distinct colors.
// Pair with a patched zone map (Razer Chroma SDK\bin\0002A3.dat) to see which zones each LED drives.
// Usage: bun spikes/chroma-link-walk.ts [ms] [leds]   (leds: 5 = spec, 8 = one per Ornata zone)
import { rgb } from "./patterns";

const BASE = "http://localhost:54235/razer/chromasdk";
const ms = Number(process.argv[2] ?? 3000);
const ledCount = Number(process.argv[3] ?? 5);

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
  description: "Phase 0 Chroma Link LED walk",
  author: { name: "herdr-chroma-plugin", contact: "local" },
  device_supported: ["keyboard", "chromalink"],
  category: "application",
});

const t0 = Date.now();
while (!(await call("PUT", `${uri}/heartbeat`).then(() => true, () => false))) {
  if (Date.now() - t0 > 10_000) throw new Error(`session listener never came up: ${uri}`);
  await Bun.sleep(100);
}
const heartbeat = setInterval(() => call("PUT", `${uri}/heartbeat`).catch(() => {}), 1000);

const colors: [string, number][] = [
  ["white", rgb(255, 255, 255)],
  ["red", rgb(255, 0, 0)],
  ["green", rgb(0, 255, 0)],
  ["blue", rgb(0, 0, 255)],
  ["magenta", rgb(255, 0, 255)],
  ["yellow", rgb(255, 255, 0)],
  ["cyan", rgb(0, 255, 255)],
  ["orange", rgb(255, 100, 0)],
].slice(0, ledCount) as [string, number][];
const show = async (param: number[]) => {
  const res = await call("PUT", `${uri}/chromalink`, { effect: "CHROMA_CUSTOM", param });
  if (res?.result !== 0) console.warn("  chromalink PUT result:", JSON.stringify(res));
};

for (let led = 0; led < colors.length; led++) {
  await show(colors.map(([, c], i) => (i === led ? c : 0)));
  console.log(`LED ${led} only: ${colors[led][0]}`);
  await Bun.sleep(ms);
}
await show(colors.map(([, c]) => c));
console.log(`all: ${colors.map(([name], i) => `${i}=${name}`).join(" ")}`);
await Bun.sleep(ms * 2);

clearInterval(heartbeat);
await call("DELETE", uri);
console.log("session released");
