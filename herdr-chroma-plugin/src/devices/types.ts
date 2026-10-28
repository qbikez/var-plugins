// The plugin always renders 8 logical zones (2 machines × 4); a driver maps them onto its hardware.
export const ZONES = 8;
export type Rgb = [number, number, number];

export interface Keyboard {
  name: string;
  // false: every write visibly blinks the LEDs, so animated zones are shown static.
  animate?: boolean;
  show(colors: Rgb[]): Promise<void>;
  close(): Promise<void>;
}

export interface DriverOptions {
  // Per-key boards: key names lit by each of the 8 zones (config `zones`); undefined = the driver's default layout.
  zones?: string[][];
}

export interface Driver {
  id: string;
  name: string;
  // Cheap presence check (enumeration only, no I/O to the device) for auto-detection.
  detect(): boolean;
  open(opts: DriverOptions): Promise<Keyboard>;
}
