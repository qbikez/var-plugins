// Keyboard drivers. `device` picks one by id; otherwise the first one whose keyboard is present is used.
import { razerOrnata } from "./razer-ornata";
import { royalKludge } from "./royal-kludge";
import type { Driver, DriverOptions, Keyboard } from "./types";

export { ZONES, type Keyboard, type Rgb } from "./types";

export const DRIVERS: Driver[] = [razerOrnata, royalKludge];

export function openKeyboard(opts: DriverOptions & { device?: string }): Promise<Keyboard> {
  if (opts.device) {
    const driver = DRIVERS.find((d) => d.id === opts.device);
    if (!driver) throw new Error(`device must be one of ${DRIVERS.map((d) => d.id).join(", ")}, got ${opts.device}`);
    return driver.open(opts);
  }
  const driver = DRIVERS.find((d) => d.detect());
  if (!driver) throw new Error(`no supported keyboard found (${DRIVERS.map((d) => d.name).join(", ")})`);
  return driver.open(opts);
}
