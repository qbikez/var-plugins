// Spike: can the Royal Kludge go brighter? Interactive A/B test; after each step you say what you saw.
// Report 0x0A's mode report has a brightness byte (src/devices/royal-kludge.ts sends 5). This checks whether
// larger values do anything, then whether the status colours themselves are the limit.
// Usage: bun spikes/rk-brightness.ts      (stop the plugin first, or it repaints over the test)
// `bun spikes/rk-brightness.ts hold 0,0,255` shows one colour on every key until Enter.
// Answers: b = brighter than the previous step, s = same, d = dimmer, r = repeat the step, q = quit
import { closeHid, featureCaps, listHidPaths, openHid, setFeature } from "../src/devices/winhid";

type Rgb = [number, number, number];
const VID = 0x258a, REPORT_LEN = 65, COLOR_REPORTS = 7, CUSTOM_MODE = 14;

let h: ReturnType<typeof openHid> | undefined;
for (const path of listHidPaths(VID)) {
  const x = openHid(path);
  const caps = featureCaps(x);
  if (caps.usagePage === 0xff00 && caps.featureLength === REPORT_LEN) { h = x; break; }
  closeHid(x);
}
if (!h) throw new Error("no Royal Kludge config interface found");
const dev = h;

function setAll(brightness: number, rgb: Rgb) {
  const mode = new Uint8Array(REPORT_LEN);
  mode.set([0x0a, 0x01, 0x01, 0x02, 0x29, CUSTOM_MODE, 0, 3, brightness, 255, 255, 255, 0, 5]);
  setFeature(dev, mode);
  const data = new Uint8Array(COLOR_REPORTS * REPORT_LEN);
  for (let i = 0; i + 3 <= data.length; i += 3) data.set(rgb, i);
  let pos = 0;
  for (let i = 0; i < COLOR_REPORTS; i++) {
    const r = new Uint8Array(REPORT_LEN);
    r.set(i === 0 ? [0x0a, COLOR_REPORTS, 1, 0x03, 0x7e, 0x01] : [0x0a, COLOR_REPORTS, i + 1]);
    const start = i === 0 ? 6 : 3;
    r.set(data.subarray(pos, pos + REPORT_LEN - start), start);
    pos += REPORT_LEN - start;
    setFeature(dev, r);
  }
}

interface Step { label: string; brightness: number; rgb: Rgb }
const WHITE: Rgb = [255, 255, 255];
const steps: Step[] = [
  { label: "baseline: byte 5, white", brightness: 5, rgb: WHITE },
  { label: "byte 15, white", brightness: 15, rgb: WHITE },
  { label: "byte 8, white", brightness: 8, rgb: WHITE },
  { label: "byte 0, white (control: should be dark or dim)", brightness: 0, rgb: WHITE },
  { label: "byte 5, working blue [0,64,255] (current)", brightness: 5, rgb: [0, 64, 255] },
  { label: "byte 5, pure blue [0,0,255]", brightness: 5, rgb: [0, 0, 255] },
  { label: "byte 5, idle purple [120,0,180] (current)", brightness: 5, rgb: [120, 0, 180] },
  { label: "byte 5, purple [200,0,255]", brightness: 5, rgb: [200, 0, 255] },
  { label: "byte 5, 20% white (the dim() floor)", brightness: 5, rgb: [51, 51, 51] },
  { label: "byte 5, 40% white", brightness: 5, rgb: [102, 102, 102] },
];

const lines = (async function* () {
  for await (const l of console) yield l;
})();
const ask = async (q: string) => {
  process.stdout.write(q);
  return ((await lines.next()).value ?? "q").trim().toLowerCase();
};

// `hold R,G,B [byte]`: show one colour on every key until Enter.
if (process.argv[2] === "hold") {
  const rgb = (process.argv[3] ?? "255,255,255").split(",").map(Number) as Rgb;
  setAll(Number(process.argv[4] ?? 5), rgb);
  await ask(`all keys ${rgb} (byte ${process.argv[4] ?? 5}); Enter to exit: `);
  closeHid(dev);
  process.exit(0);
}

const results: string[] = [];
try {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    for (;;) {
      setAll(s.brightness, s.rgb);
      console.log(`\n[${i + 1}/${steps.length}] ${s.label}`);
      const a = await ask(i === 0 ? "look at the keyboard, then press Enter: " : "vs the previous step: [b]righter [s]ame [d]immer [r]epeat [q]uit: ");
      if (a === "r") continue;
      if (a === "q") throw "quit";
      results.push(`${s.label}: ${i === 0 ? "-" : { b: "brighter", s: "same", d: "dimmer" }[a] ?? a}`);
      break;
    }
  }
} catch (e) {
  if (e !== "quit") throw e;
} finally {
  closeHid(dev);
}
console.log("\nresults\n" + results.join("\n"));
process.exit(0);
