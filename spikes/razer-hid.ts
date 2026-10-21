// Phase 0 spike: drive the Ornata V3 TKL's 8 zones directly over HID, bypassing Synapse.
// Protocol from OpenRazer (driver/razerkbd_driver.c, razerchromacommon.c; MATRIX_DIMS = [1, 8]):
//   90-byte feature report on interface 2: status, transaction id (0x1F), remaining packets (BE16),
//   protocol, data size, command class, command id, 80 argument bytes, XOR crc of bytes 2..87, reserved.
//   custom frame:  class 0x0F cmd 0x03 size 0x47, args [0, 0, row, start col, stop col, R G B …]
//   custom mode:   class 0x0F cmd 0x02 size 0x0C, args [0 (no storage), 0 (led), 0x08 (custom)]
// Usage:
//   bun spikes/razer-hid.ts info          list matching HID interfaces + report sizes
//   bun spikes/razer-hid.ts test          8 distinct colors, re-sent every second until Ctrl+C
//   bun spikes/razer-hid.ts walk [ms]     light each zone in turn
//   bun spikes/razer-hid.ts hold [s]      send the rainbow once, then watch whether anything repaints it
//   --mode-every-frame                    re-send "custom mode" with every frame (old behaviour, for comparison)
//   --sdk-session [--sdk-black]          hold a Chroma SDK session so Synapse stops repainting (colors still go over HID)
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const VID = 0x1532, PID = 0x02a3, IFACE = 2, ZONES = 8, TRANSACTION_ID = 0x1f;
type Rgb = [number, number, number];

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
  HidD_GetPreparsedData: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  HidD_FreePreparsedData: { args: [FFIType.ptr], returns: FFIType.bool },
  HidP_GetCaps: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
});

// GUID_DEVINTERFACE_HID {4D1E55B2-F16F-11CF-88CB-001111000030}
const HID_GUID = new Uint8Array([0xb2, 0x55, 0x1e, 0x4d, 0x6f, 0xf1, 0xcf, 0x11, 0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30]);
const wide = (s: string) => Buffer.from(s + "\0", "utf16le");

function hidInterfaces(): string[] {
  const len = new Uint32Array(1);
  if (cfg.CM_Get_Device_Interface_List_SizeW(ptr(len), ptr(HID_GUID), null, 0) !== 0) throw new Error("CM_Get_Device_Interface_List_SizeW failed");
  const buf = new Uint16Array(len[0]);
  if (cfg.CM_Get_Device_Interface_ListW(ptr(HID_GUID), null, ptr(buf), len[0], 0) !== 0) throw new Error("CM_Get_Device_Interface_ListW failed");
  return Buffer.from(buf.buffer).toString("utf16le").split("\0").filter(Boolean);
}

const tag = (n: number) => n.toString(16).padStart(4, "0");
const matching = () =>
  hidInterfaces().filter((p) => p.toLowerCase().includes(`vid_${tag(VID)}&pid_${tag(PID)}&mi_${IFACE.toString().padStart(2, "0")}`));

function open(path: string): Pointer {
  const FILE_SHARE_READ_WRITE = 3, OPEN_EXISTING = 3;
  // Access 0: Windows holds keyboard/mouse collections exclusively, but feature reports still work.
  const h = BigInt(k32.CreateFileW(ptr(wide(path)), 0, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, 0, null));
  if (h === 0n || h === 0xffffffffffffffffn) throw new Error(`CreateFileW failed (${k32.GetLastError()}): ${path}`);
  return Number(h) as Pointer;
}

function featureLength(h: Pointer): number {
  const pp = new BigUint64Array(1);
  if (!hid.HidD_GetPreparsedData(h, ptr(pp))) return -1;
  const caps = new Uint16Array(32); // HIDP_CAPS: FeatureReportByteLength is the 5th USHORT
  hid.HidP_GetCaps(Number(pp[0]) as unknown as Pointer, ptr(caps));
  hid.HidD_FreePreparsedData(Number(pp[0]) as unknown as Pointer);
  return caps[4];
}

function report(cmdClass: number, cmdId: number, dataSize: number, args: number[]): Uint8Array {
  const r = new Uint8Array(90);
  r[1] = TRANSACTION_ID;
  r[5] = dataSize;
  r[6] = cmdClass;
  r[7] = cmdId;
  r.set(args, 8);
  for (let i = 2; i < 88; i++) r[88] ^= r[i];
  return r;
}

const STATUS = ["new", "busy", "ok", "failed", "timeout", "not supported"];

async function send(h: Pointer, r: Uint8Array): Promise<string> {
  const out = new Uint8Array(91); // report id 0 + 90 bytes
  out.set(r, 1);
  if (!hid.HidD_SetFeature(h, ptr(out), out.length)) return `SetFeature failed (${k32.GetLastError()})`;
  await Bun.sleep(5);
  const back = new Uint8Array(91);
  if (!hid.HidD_GetFeature(h, ptr(back), back.length)) return `GetFeature failed (${k32.GetLastError()})`;
  return STATUS[back[1]] ?? `status 0x${back[1].toString(16)}`;
}

const frame = (colors: Rgb[]) => report(0x0f, 0x03, 0x47, [0, 0, 0, 0, ZONES - 1, ...colors.flat()]);
const customMode = () => report(0x0f, 0x02, 0x0c, [0, 0, 0x08]);

// Re-sending custom mode on every frame may make the firmware flash its base effect; default to once.
const argv = process.argv.slice(2);
const modeEveryFrame = argv.includes("--mode-every-frame");
let customModeSent = false;

async function show(h: Pointer, colors: Rgb[], verbose = false) {
  const a = await send(h, frame(colors));
  let b = "skipped";
  if (modeEveryFrame || !customModeSent) {
    b = await send(h, customMode());
    customModeSent = true;
  }
  if (verbose || a !== "ok" || (b !== "ok" && b !== "skipped")) console.log(`  frame: ${a}, custom mode: ${b}`);
}

const [mode = "info", ...args] = argv.filter((a) => !a.startsWith("--"));

// --sdk-session: hold a Chroma SDK REST session so Synapse stops repainting its own profile,
// while the actual colors go over HID. Optionally push a black Chroma Link frame (--sdk-black).
async function sdkSession(): Promise<() => Promise<void>> {
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
    return res.json().catch(() => null);
  };
  const { uri } = await call("POST", "http://localhost:54235/razer/chromasdk", {
    title: "herdr-chroma hid spike",
    description: "Holds the Chroma session while zones are driven over HID",
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
  if (argv.includes("--sdk-black")) await call("PUT", `${uri}/chromalink`, { effect: "CHROMA_CUSTOM", param: [0, 0, 0, 0, 0] });
  // Give Synapse a moment to hand the device over to the app.
  await Bun.sleep(1500);
  console.log(`Chroma SDK session held: ${uri}`);
  return async () => {
    clearInterval(heartbeat);
    await call("DELETE", uri);
  };
}
const releaseSdk = argv.includes("--sdk-session") ? await sdkSession() : async () => {};
const paths = matching();
if (mode === "info" || paths.length === 0) {
  console.log(`HID interfaces for ${tag(VID)}:${tag(PID)} MI_0${IFACE}:`);
  for (const p of paths) {
    const h = open(p);
    console.log(`  ${p}\n    feature report length: ${featureLength(h)} (expect 91)`);
    k32.CloseHandle(h);
  }
  if (paths.length === 0) console.log("  none found");
  process.exit(0);
}

const h = open(paths[0]);
process.on("SIGINT", async () => {
  k32.CloseHandle(h);
  await releaseSdk();
  process.exit(0);
});
const rainbow: Rgb[] = [[255, 0, 0], [255, 120, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [160, 0, 255], [255, 255, 255]];

if (mode === "test") {
  await show(h, rainbow, true);
  console.log("zones 0–7: red orange yellow green cyan blue purple white (re-sent every 1 s, Ctrl+C to stop)");
  for (;;) {
    await Bun.sleep(1000);
    await show(h, rainbow);
  }
} else if (mode === "walk") {
  const ms = Number(args[0] ?? 800);
  for (let z = 0; z < ZONES; z++) {
    await show(h, rainbow.map((_, i) => (i === z ? [0, 255, 0] : [0, 0, 0]) as Rgb));
    console.log(`zone ${z}`);
    await Bun.sleep(ms);
  }
} else if (mode === "hold") {
  // Send once, then stay silent: if the base effect comes back, something else (Synapse) repainted it.
  const s = Number(args[0] ?? 30);
  await show(h, rainbow, true);
  const t0 = Date.now();
  console.log(`rainbow sent once; not re-sending for ${s} s — note when (if) it changes`);
  while (Date.now() - t0 < s * 1000) {
    await Bun.sleep(5000);
    console.log(`  +${Math.round((Date.now() - t0) / 1000)} s`);
  }
} else {
  console.error(`unknown mode: ${mode}`);
}
k32.CloseHandle(h);
await releaseSdk();
