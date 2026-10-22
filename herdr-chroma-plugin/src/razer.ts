// Ornata V3 TKL lighting: 8 zones driven over HID feature reports, plus a held Chroma SDK session
// that stops Synapse repainting its profile. See docs/plans/phase0-findings.md and spikes/razer-hid.ts.
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

export const ZONES = 8;
export type Rgb = [number, number, number];

const VID = 0x1532, PID = 0x02a3, IFACE = 2, TRANSACTION_ID = 0x1f;

const { symbols: cfg } = dlopen("cfgmgr32.dll", {
  CM_Get_Device_Interface_List_SizeW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  CM_Get_Device_Interface_ListW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
});
const { symbols: k32 } = dlopen("kernel32.dll", {
  // u64, not ptr: INVALID_HANDLE_VALUE is -1, which doesn't survive Bun's pointer conversion.
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
});
const { symbols: hid } = dlopen("hid.dll", {
  HidD_SetFeature: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
  HidD_GetFeature: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
});

// GUID_DEVINTERFACE_HID {4D1E55B2-F16F-11CF-88CB-001111000030}
const HID_GUID = new Uint8Array([0xb2, 0x55, 0x1e, 0x4d, 0x6f, 0xf1, 0xcf, 0x11, 0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30]);
const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
const hex4 = (n: number) => n.toString(16).padStart(4, "0");

function findInterface(): string {
  const len = new Uint32Array(1);
  if (cfg.CM_Get_Device_Interface_List_SizeW(ptr(len), ptr(HID_GUID), null, 0) !== 0) throw new Error("CM_Get_Device_Interface_List_SizeW failed");
  const buf = new Uint16Array(len[0]);
  if (cfg.CM_Get_Device_Interface_ListW(ptr(HID_GUID), null, ptr(buf), len[0], 0) !== 0) throw new Error("CM_Get_Device_Interface_ListW failed");
  const want = `vid_${hex4(VID)}&pid_${hex4(PID)}&mi_0${IFACE}`;
  const path = Buffer.from(buf.buffer).toString("utf16le").split("\0").find((p) => p.toLowerCase().includes(want));
  if (!path) throw new Error(`Razer Ornata V3 TKL (${want}) not found`);
  return path;
}

function openHid(path: string): Pointer {
  const FILE_SHARE_READ_WRITE = 3, OPEN_EXISTING = 3;
  // Access 0: Windows holds keyboard collections exclusively, but feature reports still work.
  const h = BigInt(k32.CreateFileW(ptr(wide(path)), 0, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, 0, null));
  if (h === 0n || h === 0xffffffffffffffffn) throw new Error(`CreateFileW failed (${k32.GetLastError()}): ${path}`);
  return Number(h) as Pointer;
}

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
  if (!hid.HidD_SetFeature(h, ptr(r), r.length)) throw new Error(`HidD_SetFeature failed (${k32.GetLastError()})`);
  await Bun.sleep(5);
  const back = new Uint8Array(91);
  if (!hid.HidD_GetFeature(h, ptr(back), back.length)) throw new Error(`HidD_GetFeature failed (${k32.GetLastError()})`);
  if (back[1] !== 2) throw new Error(`Razer report status: ${STATUS[back[1]] ?? back[1]}`);
}

// A present HID node doesn't mean the firmware answers (KVM switched away, driver stack wedged): check before attaching.
async function probe(h: Pointer): Promise<void> {
  const q = report(0x00, 0x81, 0x02, []); // firmware version query, read-only
  if (!hid.HidD_SetFeature(h, ptr(q), q.length)) throw new Error(`HidD_SetFeature failed (${k32.GetLastError()})`);
  await Bun.sleep(5);
  if (!hid.HidD_GetFeature(h, ptr(new Uint8Array(91)), 91)) throw new Error(`HidD_GetFeature failed (${k32.GetLastError()})`);
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

export interface Keyboard {
  show(colors: Rgb[]): Promise<void>;
  close(): Promise<void>;
}

export async function openKeyboard(): Promise<Keyboard> {
  const h = openHid(findInterface());
  try {
    await probe(h);
  } catch (e) {
    k32.CloseHandle(h);
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
      k32.CloseHandle(h);
      await releaseSdk();
    },
  };
}
