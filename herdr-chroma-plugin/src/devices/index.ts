// Keyboard drivers. `device` picks drivers by id (comma-separated); otherwise every driver whose keyboard is present is used.
import { razerOrnata } from "./razer-ornata";
import { royalKludge } from "./royal-kludge";
import type { Driver, DriverOptions, Keyboard } from "./types";

export { ZONES, type Keyboard, type Rgb } from "./types";

export const DRIVERS: Driver[] = [razerOrnata, royalKludge];

// Fans every frame out to all attached keyboards. A write failure on any of them is rethrown (after every
// keyboard was tried) so the caller reattaches and picks up whatever is plugged in now.
function combine(boards: Keyboard[]): Keyboard {
  if (boards.length === 1) return boards[0]!;
  const all = async (fn: (k: Keyboard) => Promise<void>) => {
    const results = await Promise.allSettled(boards.map(fn));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  };
  return {
    name: boards.map((k) => k.name).join(" + "),
    animate: boards.every((k) => k.animate !== false),
    show: (colors) => all((k) => k.show(colors)),
    close: () => all((k) => k.close()),
  };
}

export async function openKeyboard(opts: DriverOptions & { device?: string }): Promise<Keyboard> {
  let drivers: Driver[];
  if (opts.device) {
    // `device` is a driver id, or a comma-separated list of them.
    drivers = opts.device.split(",").map((id) => {
      const driver = DRIVERS.find((d) => d.id === id.trim());
      if (!driver) throw new Error(`device must be one of ${DRIVERS.map((d) => d.id).join(", ")}, got ${id}`);
      return driver;
    });
  } else {
    drivers = DRIVERS.filter((d) => d.detect());
    if (!drivers.length) throw new Error(`no supported keyboard found (${DRIVERS.map((d) => d.name).join(", ")})`);
  }
  const results = await Promise.allSettled(drivers.map((d) => d.open(opts)));
  const boards = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  // All-or-nothing: a half-attached set would never pick up the missing keyboard until restart.
  if (failed) {
    await Promise.allSettled(boards.map((k) => k.close()));
    throw failed.reason;
  }
  return combine(boards);
}
