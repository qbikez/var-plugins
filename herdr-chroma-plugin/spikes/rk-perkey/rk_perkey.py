"""Spike: per-key RGB on Royal Kludge keyboards over USB HID.

Protocol taken from kludgeknight (src/models/LightingCodec.ts, docs/lighting-protocol.md):
  - config interface = VID 0x258A, interface 1 (WebHID filters on usage 01/80; on Windows the
    feature report actually lives in the vendor collection, usage page 0xFF00, report id 0x0A)
  - everything is 65-byte HID *feature* reports, report id 0x0A
  - 1 buffer  "0a 01 01 02 29 ..." -> global lighting mode (mode 14 = Customize on RGB boards)
  - 7 buffers "0a 07 NN ..."       -> per-key colors, key at byte offset bIndex*3 (R,G,B)

Usage:
  python rk_perkey.py all ff0000
  python rk_perkey.py keys W=ff0000 A=00ff00 S=00ff00 D=00ff00 0x1B=ffffff
  python rk_perkey.py rainbow
  python rk_perkey.py walk            # lights one bIndex at a time, prints it
  python rk_perkey.py index 7=ff0000  # raw bIndex=color
"""
import colorsys
import sys
import time
from pathlib import Path

import hid

VID = 0x258A
REPORT_ID = 0x0A
BUF = 65
CUSTOM_MODE = 14  # tc_led_mode14 "Customize" for RGBKb=1
KB_INI = Path(__file__).with_name("KB_01D9.ini")


def open_device():
    # WebHID opens the whole interface; on Windows each top-level collection is its own handle,
    # so pick the vendor collection (usage page 0xFF00) whose descriptor declares report id 0x0A.
    for d in hid.enumerate(VID):
        if d["usage_page"] != 0xFF00:
            continue
        dev = hid.device()
        dev.open_path(d["path"])
        if bytes([0x85, REPORT_ID]) in bytes(dev.get_report_descriptor()):
            print(f"opened PID {d['product_id']:04X} {d['product_string']!r}")
            return dev
        dev.close()
    sys.exit("no RK keyboard config collection found (VID 258A, page FF00, report 0x0A)")


def send(dev, buf):
    assert len(buf) == BUF and buf[0] == REPORT_ID
    n = dev.send_feature_report(bytes(buf))
    if n < 0:
        raise IOError(f"send_feature_report failed: {dev.error()}")


def set_mode(dev, mode, speed=3, brightness=5, rgb=(255, 255, 255), sleep=5):
    buf = bytearray(BUF)
    buf[0:5] = [REPORT_ID, 0x01, 0x01, 0x02, 0x29]
    buf[5] = mode
    buf[7] = speed
    buf[8] = brightness
    buf[9:12] = rgb
    buf[12] = 0  # random off
    buf[13] = sleep
    send(dev, buf)


def set_colors(dev, colors):
    """colors: {bIndex: (r, g, b)}"""
    data = bytearray(7 * BUF)
    for idx, (r, g, b) in colors.items():
        data[idx * 3 : idx * 3 + 3] = bytes((r, g, b))
    pos = 0
    for i in range(7):
        buf = bytearray(BUF)
        buf[0:3] = [REPORT_ID, 0x07, i + 1]
        start = 3
        if i == 0:
            buf[3:6] = [0x03, 0x7E, 0x01]
            start = 6
        n = BUF - start
        buf[start:] = data[pos : pos + n]
        pos += n
        send(dev, buf)


def load_keys():
    """KB.ini [KEY]: Kn=left,top,right,bottom,flags,vk,?,bIndex -> {vk: bIndex}"""
    keys = {}
    for line in KB_INI.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("K") and "=" in line:
            parts = [p.strip() for p in line.split("=", 1)[1].split(",")]
            if len(parts) == 8:
                keys[int(parts[5], 16)] = int(parts[7])
    return keys


def parse_rgb(s):
    s = s.lstrip("#")
    return tuple(int(s[i : i + 2], 16) for i in (0, 2, 4))


def parse_vk(s):
    # single letter/digit -> Windows VK code (same as ASCII uppercase); else hex like 0x1B
    return ord(s.upper()) if len(s) == 1 else int(s, 16)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    keys = load_keys()
    dev = open_device()
    try:
        set_mode(dev, CUSTOM_MODE)
        if cmd == "all":
            c = parse_rgb(args[0])
            set_colors(dev, {i: c for i in keys.values()})
        elif cmd == "keys":
            colors = {}
            for a in args:
                k, c = a.split("=")
                vk = parse_vk(k)
                if vk not in keys:
                    print(f"  unknown key {k} (VK {vk:#04x})")
                    continue
                colors[keys[vk]] = parse_rgb(c)
            set_colors(dev, colors)
        elif cmd == "index":
            set_colors(dev, {int(k): parse_rgb(c) for k, c in (a.split("=") for a in args)})
        elif cmd == "rainbow":
            idxs = sorted(keys.values())
            colors = {}
            for n, i in enumerate(idxs):
                r, g, b = colorsys.hsv_to_rgb(n / len(idxs), 1, 1)
                colors[i] = (int(r * 255), int(g * 255), int(b * 255))
            set_colors(dev, colors)
        elif cmd == "walk":
            for i in sorted(set(keys.values())):
                print(f"  bIndex {i}")
                set_colors(dev, {i: (255, 0, 0)})
                time.sleep(0.15)
        else:
            sys.exit(__doc__)
        print("done")
    finally:
        dev.close()


if __name__ == "__main__":
    main()
