// Windows HID plumbing over bun:ffi: enumerate HID interfaces, open them and exchange feature reports.
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

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
export const hex4 = (n: number) => n.toString(16).padStart(4, "0");

// Present HID interface paths for a vendor (and product), lowercased for matching on `&mi_0x`, `&col0x`.
export function listHidPaths(vid: number, pid?: number): string[] {
  const len = new Uint32Array(1);
  if (cfg.CM_Get_Device_Interface_List_SizeW(ptr(len), ptr(HID_GUID), null, 0) !== 0) throw new Error("CM_Get_Device_Interface_List_SizeW failed");
  const buf = new Uint16Array(len[0]!);
  if (cfg.CM_Get_Device_Interface_ListW(ptr(HID_GUID), null, ptr(buf), len[0]!, 0) !== 0) throw new Error("CM_Get_Device_Interface_ListW failed");
  const want = `vid_${hex4(vid)}&pid_${pid === undefined ? "" : hex4(pid)}`;
  return Buffer.from(buf.buffer).toString("utf16le").split("\0").filter((p) => p.toLowerCase().includes(want));
}

export function openHid(path: string): Pointer {
  const FILE_SHARE_READ_WRITE = 3, OPEN_EXISTING = 3;
  // Access 0: Windows holds keyboard collections exclusively, but feature reports still work.
  const h = BigInt(k32.CreateFileW(ptr(wide(path)), 0, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, 0, null));
  if (h === 0n || h === 0xffffffffffffffffn) throw new Error(`CreateFileW failed (${k32.GetLastError()}): ${path}`);
  return Number(h) as Pointer;
}

export function closeHid(h: Pointer) {
  k32.CloseHandle(h);
}

// Top-level collection of an open interface: usage page/usage and feature report length (including the report id byte).
export function featureCaps(h: Pointer): { usagePage: number; usage: number; featureLength: number } {
  const pp = new BigUint64Array(1);
  if (!hid.HidD_GetPreparsedData(h, ptr(pp))) throw new Error(`HidD_GetPreparsedData failed (${k32.GetLastError()})`);
  const data = Number(pp[0]) as Pointer;
  try {
    const caps = new Uint16Array(32); // HIDP_CAPS: Usage, UsagePage, Input/Output/FeatureReportByteLength, ...
    const HIDP_STATUS_SUCCESS = 0x00110000;
    if (hid.HidP_GetCaps(data, ptr(caps)) !== HIDP_STATUS_SUCCESS) throw new Error("HidP_GetCaps failed");
    return { usage: caps[0]!, usagePage: caps[1]!, featureLength: caps[4]! };
  } finally {
    hid.HidD_FreePreparsedData(data);
  }
}

export function setFeature(h: Pointer, report: Uint8Array) {
  if (!hid.HidD_SetFeature(h, ptr(report), report.length)) throw new Error(`HidD_SetFeature failed (${k32.GetLastError()})`);
}

export function getFeature(h: Pointer, report: Uint8Array) {
  if (!hid.HidD_GetFeature(h, ptr(report), report.length)) throw new Error(`HidD_GetFeature failed (${k32.GetLastError()})`);
}
