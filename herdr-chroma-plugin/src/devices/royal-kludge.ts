// Royal Kludge per-key RGB over HID feature reports (protocol from github.com/vinc3m1/kludgeknight, verified with
// spikes/rk-perkey). Report 0x0A, 65 bytes: one report selects the lighting mode, seven carry R,G,B at bIndex * 3.
// Key positions come from RK's own KB.ini for the product id, shipped in ./rk/<PID>.ini.
import type { Pointer } from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ZONES, type Driver, type DriverOptions, type Keyboard, type Rgb } from "./types";
import { closeHid, featureCaps, hex4, listHidPaths, openHid, setFeature } from "./winhid";

const VID = 0x258a, REPORT_ID = 0x0a, REPORT_LEN = 65, COLOR_REPORTS = 7;
const CUSTOM_MODE = 14; // "Customize" on RGB boards (tc_led_mode14)
// Each frame is 7 feature reports with no acknowledgement, and the LEDs go dark for a moment on every frame
// (so no animation, see `animate`); this only spaces out bursts of status changes.
const MIN_FRAME_MS = 250;

// Windows virtual-key codes used in KB.ini → key names (the same names as spikes/keymap.ts), plus RK's own codes.
const VK_NAMES: Record<number, string> = {
  0x08: "BACKSPACE", 0x09: "TAB", 0x0d: "ENTER", 0x13: "PAUSE", 0x14: "CAPSLOCK", 0x1b: "ESC", 0x20: "SPACE",
  0x21: "PAGEUP", 0x22: "PAGEDOWN", 0x23: "END", 0x24: "HOME", 0x25: "LEFT", 0x26: "UP", 0x27: "RIGHT", 0x28: "DOWN",
  0x2c: "PRINTSCREEN", 0x2d: "INSERT", 0x2e: "DELETE", 0x5b: "LWIN", 0x5c: "RWIN", 0x5d: "MENU",
  0x6a: "NUM*", 0x6b: "NUM+", 0x6d: "NUM-", 0x6e: "NUM.", 0x6f: "NUM/", 0x90: "NUMLOCK", 0x91: "SCROLL",
  0xa0: "LSHIFT", 0xa1: "RSHIFT", 0xa2: "LCTRL", 0xa3: "RCTRL", 0xa4: "LALT", 0xa5: "RALT",
  0xba: ";", 0xbb: "=", 0xbc: ",", 0xbd: "-", 0xbe: ".", 0xbf: "/", 0xc0: "`", 0xdb: "[", 0xdc: "\\", 0xdd: "]", 0xde: "'",
  0xe2: "ISO\\", 0xe0: "RSPACE", 0xfa: "FN",
  0xd9: "SELECTALL", 0xb9: "COPY", 0xb8: "CUT", 0xc6: "PASTE", 0xc7: "SAVE",
};
for (let i = 0; i < 10; i++) VK_NAMES[0x30 + i] = String(i), VK_NAMES[0x60 + i] = `NUM${i}`;
for (let i = 0; i < 26; i++) VK_NAMES[0x41 + i] = String.fromCharCode(0x41 + i);
for (let i = 0; i < 12; i++) VK_NAMES[0x70 + i] = `F${i + 1}`;
const vkName = (vk: number) => VK_NAMES[vk] ?? `VK_${vk.toString(16).toUpperCase()}`;

interface Key { name: string; bIndex: number; x: number }

const iniPath = (pid: number) => join(import.meta.dir, "rk", `${hex4(pid).toUpperCase()}.ini`);

// KB.ini [KEY] entries: Kn=left,top,right,bottom,flags,vk,?,bIndex. Some files are UTF-16 LE.
function loadKeys(pid: number): Key[] {
  const raw = readFileSync(iniPath(pid));
  const text = raw[1] === 0 || (raw[0] === 0xff && raw[1] === 0xfe) ? raw.toString("utf16le") : raw.toString("utf8");
  const keys: Key[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^K\d+=(.*)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[1].split(",").map((p) => p.trim());
    if (parts.length !== 8) continue;
    const [left, , right] = parts.map(Number);
    keys.push({ name: vkName(parseInt(parts[5], 16)), bIndex: Number(parts[7]), x: (left + right) / 2 });
  }
  if (!keys.length) throw new Error(`no keys in ${iniPath(pid)}`);
  return keys;
}

// bIndexes lit by each zone: the configured key names, or by default 8 equal-width vertical strips.
function zoneKeys(keys: Key[], zones: string[][] | undefined): number[][] {
  if (zones) {
    if (zones.length !== ZONES) throw new Error(`zones must list ${ZONES} zones, got ${zones.length}`);
    const byName = new Map<string, number[]>();
    for (const k of keys) byName.set(k.name, [...(byName.get(k.name) ?? []), k.bIndex]);
    return zones.map((names) =>
      names.flatMap((n) => {
        const found = byName.get(n.toUpperCase());
        if (!found) throw new Error(`unknown key ${JSON.stringify(n)} in zones; this keyboard has: ${[...byName.keys()].join(" ")}`);
        return found;
      }),
    );
  }
  // Each machine's half ends at the 6|7 gap (the middle of the board if those keys are missing), then splits
  // into equal-width strips.
  const xs = keys.map((k) => k.x), min = Math.min(...xs), max = Math.max(...xs) + 1;
  const x6 = keys.find((k) => k.name === "6")?.x, x7 = keys.find((k) => k.name === "7")?.x;
  const split = x6 !== undefined && x7 !== undefined ? (x6 + x7) / 2 : (min + max) / 2;
  const half = ZONES / 2;
  const strips: number[][] = Array.from({ length: ZONES }, () => []);
  for (const k of keys) {
    const [from, to, first] = k.x < split ? [min, split, 0] : [split, max, half];
    strips[first + Math.floor(((k.x - from) / (to - from)) * half)]!.push(k.bIndex);
  }
  return strips;
}

// Windows splits the interface into top-level collections; report 0x0A lives on the vendor page (0xFF00),
// not the 0x01/0x80 collection WebHID filters on. Returns the first supported keyboard with a key map.
function findDevice(): { path: string; pid: number } | undefined {
  for (const path of listHidPaths(VID)) {
    const pid = parseInt(/pid_([0-9a-f]{4})/i.exec(path)?.[1] ?? "", 16);
    if (!existsSync(iniPath(pid))) continue;
    let h: Pointer | undefined;
    try {
      h = openHid(path);
      const caps = featureCaps(h);
      if (caps.usagePage === 0xff00 && caps.featureLength === REPORT_LEN) return { path, pid };
    } catch {
      // Not openable (e.g. held exclusively): not ours.
    } finally {
      if (h !== undefined) closeHid(h);
    }
  }
}

function modeReport(mode: number): Uint8Array {
  const r = new Uint8Array(REPORT_LEN);
  // id, 1 report, report 1, set-lighting, mode, -, speed 3, brightness 5, R G B, random off, sleep off
  r.set([REPORT_ID, 0x01, 0x01, 0x02, 0x29, mode, 0, 3, 5, 255, 255, 255, 0, 5]);
  return r;
}

function colorReports(colors: Map<number, Rgb>): Uint8Array[] {
  const data = new Uint8Array(COLOR_REPORTS * REPORT_LEN);
  for (const [bIndex, rgb] of colors) data.set(rgb, bIndex * 3);
  const reports: Uint8Array[] = [];
  let pos = 0;
  for (let i = 0; i < COLOR_REPORTS; i++) {
    const r = new Uint8Array(REPORT_LEN);
    // The first report carries the set-colors command before its data.
    r.set(i === 0 ? [REPORT_ID, COLOR_REPORTS, 1, 0x03, 0x7e, 0x01] : [REPORT_ID, COLOR_REPORTS, i + 1]);
    const start = i === 0 ? 6 : 3;
    r.set(data.subarray(pos, pos + REPORT_LEN - start), start);
    pos += REPORT_LEN - start;
    reports.push(r);
  }
  return reports;
}

async function open(opts: DriverOptions): Promise<Keyboard> {
  const dev = findDevice();
  if (!dev) throw new Error(`Royal Kludge keyboard (vid_${hex4(VID)}, a key map in ${join(import.meta.dir, "rk")}) not found`);
  const zones = zoneKeys(loadKeys(dev.pid), opts.zones);
  const h = openHid(dev.path);
  try {
    setFeature(h, modeReport(CUSTOM_MODE)); // no read-back exists, so a successful write is the probe
  } catch (e) {
    closeHid(h);
    throw e;
  }
  const name = `Royal Kludge ${hex4(dev.pid).toUpperCase()}`;
  // Latest frame wins: frames arriving faster than MIN_FRAME_MS replace the pending one instead of queueing.
  let pending: Rgb[] | undefined, lastSent = 0, lastFrame = "";
  let sending: Promise<void> | undefined;
  const pump = async () => {
    while (pending) {
      // Unchanged frames (the daemon's periodic refresh) are skipped, since every write blinks the LEDs; with no
      // failed write to notice an unplug, check the device is still present instead.
      if (JSON.stringify(pending) === lastFrame) {
        pending = undefined;
        if (!listHidPaths(VID).includes(dev.path)) throw new Error(`${name} disconnected`);
        continue;
      }
      await Bun.sleep(Math.max(0, lastSent + MIN_FRAME_MS - Date.now()));
      const colors = pending;
      pending = undefined;
      lastFrame = JSON.stringify(colors);
      const perKey = new Map<number, Rgb>();
      zones.forEach((keys, z) => keys.forEach((b) => perKey.set(b, colors[z]!)));
      for (const r of colorReports(perKey)) setFeature(h, r);
      lastSent = Date.now();
    }
  };
  return {
    name,
    animate: false,
    show(colors) {
      pending = colors;
      sending ??= pump().finally(() => (sending = undefined));
      return sending;
    },
    async close() {
      await sending?.catch(() => {});
      closeHid(h);
    },
  };
}

export const royalKludge: Driver = {
  id: "royal-kludge",
  name: "Royal Kludge",
  detect: () => findDevice() !== undefined,
  open,
};
