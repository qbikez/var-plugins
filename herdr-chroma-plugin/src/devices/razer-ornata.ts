// Ornata V3 TKL lighting: 8 zones driven over HID feature reports, plus a held Chroma SDK session
// that stops Synapse repainting its profile. See docs/plans/phase0-findings.md and spikes/razer-hid.ts.
import type { Pointer } from "bun:ffi";
import { ZONES, type Driver, type Keyboard } from "./types";
import { closeHid, getFeature, hex4, listHidPaths, openHid, setFeature } from "./winhid";

const VID = 0x1532, PID = 0x02a3, IFACE = 2, TRANSACTION_ID = 0x1f;
const NAME = "Razer Ornata V3 TKL";

const findInterface = () => listHidPaths(VID, PID).find((p) => p.toLowerCase().includes(`&mi_0${IFACE}`));

function report(cmdClass: number, cmdId: number, dataSize: number, args: number[]): Uint8Array {
  const r = new Uint8Array(91); // report id 0 + 90-byte Razer report
  r[2] = TRANSACTION_ID;
  r[6] = dataSize;
  r[7] = cmdClass;
  r[8] = cmdId;
  r.set(args, 9);
  for (let i = 3; i < 89; i++) r[89] ^= r[i];
  return r;
}

const STATUS = ["new", "busy", "ok", "failed", "timeout", "not supported"];

async function sendReport(h: Pointer, r: Uint8Array): Promise<void> {
  setFeature(h, r);
  await Bun.sleep(5);
  const back = new Uint8Array(91);
  getFeature(h, back);
  if (back[1] !== 2) throw new Error(`Razer report status: ${STATUS[back[1]] ?? back[1]}`);
}

// A present HID node doesn't mean the firmware answers (KVM switched away, driver stack wedged): check before attaching.
async function probe(h: Pointer): Promise<void> {
  setFeature(h, report(0x00, 0x81, 0x02, [])); // firmware version query, read-only
  await Bun.sleep(5);
  getFeature(h, new Uint8Array(91));
}

// Holding a session (heartbeat only, no effects) makes Synapse stop repainting; DELETE hands the keyboard back.
async function holdSdkSession(): Promise<() => Promise<void>> {
  const call = (method: string, url: string, body?: unknown) =>
    fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
  const res = await call("POST", "http://localhost:54235/razer/chromasdk", {
    title: "herdr-chroma",
    description: "herdr agent status on the keyboard",
    author: { name: "herdr-chroma-plugin", contact: "local" },
    device_supported: ["keyboard", "chromalink"],
    category: "application",
  });
  const { uri } = (await res.json()) as { uri: string };
  const t0 = Date.now();
  // The per-session listener takes ~100 ms to come up.
  while (!(await call("PUT", `${uri}/heartbeat`).then(() => true, () => false))) {
    if (Date.now() - t0 > 10_000) throw new Error(`Chroma session listener never came up: ${uri}`);
    await Bun.sleep(100);
  }
  const heartbeat = setInterval(() => call("PUT", `${uri}/heartbeat`).catch(() => {}), 1000);
  return async () => {
    clearInterval(heartbeat);
    await call("DELETE", uri).catch(() => {});
  };
}

async function open(): Promise<Keyboard> {
  const path = findInterface();
  if (!path) throw new Error(`${NAME} (vid_${hex4(VID)}&pid_${hex4(PID)}&mi_0${IFACE}) not found`);
  const h = openHid(path);
  try {
    await probe(h);
  } catch (e) {
    closeHid(h);
    throw e;
  }
  let releaseSdk = async () => {};
  try {
    releaseSdk = await holdSdkSession();
    // Give Synapse a moment to hand the device over to the app.
    await Bun.sleep(1500);
  } catch (e) {
    console.warn(`Chroma SDK session unavailable, Synapse may repaint over us: ${(e as Error).message}`);
  }
  let customModeSent = false;
  // Serialize HID traffic: each report is a SetFeature + GetFeature pair.
  let queue = Promise.resolve();
  return {
    name: NAME,
    show(colors) {
      queue = queue.then(async () => {
        await sendReport(h, report(0x0f, 0x03, 0x47, [0, 0, 0, 0, ZONES - 1, ...colors.flat()]));
        // Custom mode once; re-sending it makes the firmware flash its base effect.
        if (!customModeSent) {
          await sendReport(h, report(0x0f, 0x02, 0x0c, [0, 0, 0x08]));
          customModeSent = true;
        }
      });
      return queue;
    },
    async close() {
      await queue.catch(() => {});
      closeHid(h);
      await releaseSdk();
    },
  };
}

export const razerOrnata: Driver = {
  id: "razer-ornata",
  name: NAME,
  detect: () => findInterface() !== undefined,
  open: (opts) => {
    // 8 hardware zones map 1:1; there are no keys to lay out.
    if (opts.zones) console.warn(`${NAME} has fixed hardware zones, ignoring the zones setting`);
    return open();
  },
};
