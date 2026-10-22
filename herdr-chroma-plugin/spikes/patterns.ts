// Test patterns shared by the Chroma spikes; each takes a transport-specific `show`.
import { COLS, KEYS, ROWS } from "./keymap";

export type Grid = number[][];
export type Show = (grid: Grid) => Promise<void>;

// Chroma colors are 0x00BBGGRR.
export const rgb = (r: number, g: number, b: number) => (b << 16) | (g << 8) | r;
export const blank = (fill = 0): Grid => Array.from({ length: ROWS }, () => Array(COLS).fill(fill));

export const USAGE = `modes:
  test          rows in distinct hues, number row bright, 1–9 white (until Ctrl+C)
  walk [ms]     light each mapped key in turn, print its name
  cell <r> <c>  light a single grid cell for 5 s
  probe         5 labelled steps (4 s each) to see how a zoned keyboard folds the grid`;

export async function runPattern(show: Show, mode: string, args: string[]) {
  if (mode === "test") {
    const hues = [rgb(255, 0, 0), rgb(255, 128, 0), rgb(255, 255, 0), rgb(0, 255, 0), rgb(0, 128, 255), rgb(160, 0, 255)];
    const grid = blank();
    for (let r = 0; r < ROWS; r++) grid[r].fill(hues[r]);
    for (let n = 1; n <= 9; n++) {
      const { row, col } = KEYS[String(n)];
      grid[row][col] = rgb(255, 255, 255);
    }
    await show(grid);
    console.log("rows: 0 red, 1 orange (1–9 white), 2 yellow, 3 green, 4 blue, 5 purple. Ctrl+C to exit.");
    await new Promise(() => {});
  } else if (mode === "walk") {
    const ms = Number(args[0] ?? 600);
    for (const [name, { row, col }] of Object.entries(KEYS)) {
      const grid = blank(rgb(8, 8, 8));
      grid[row][col] = rgb(0, 255, 0);
      await show(grid);
      console.log(`[${row},${col}] ${name}`);
      await Bun.sleep(ms);
    }
  } else if (mode === "probe") {
    // Zoned keyboards (e.g. Ornata V3 TKL: 1×8 zones) fold the 6×22 grid down somehow; find out how.
    const bands = [rgb(255, 0, 0), rgb(255, 128, 0), rgb(255, 255, 0), rgb(0, 255, 0), rgb(0, 255, 255), rgb(0, 0, 255), rgb(160, 0, 255), rgb(255, 0, 160)];
    const steps: [string, Grid][] = [
      ["A: whole grid red", blank(rgb(255, 0, 0))],
      ["B: whole grid green", blank(rgb(0, 255, 0))],
      ["C: 8 vertical bands red→pink across the 22 columns", blank().map((row) => row.map((_, c) => bands[Math.floor((c * 8) / 22)]))],
      ["D: only row 1 (number row) blue, rest black", blank().map((row, r) => row.map(() => (r === 1 ? rgb(0, 0, 255) : 0)))],
      ["E: only key '1' white, rest black", (() => { const g = blank(); g[KEYS["1"].row][KEYS["1"].col] = rgb(255, 255, 255); return g; })()],
    ];
    for (const [label, grid] of steps) {
      await show(grid);
      console.log(label);
      await Bun.sleep(4000);
    }
  } else if (mode === "cell") {
    const [row, col] = args.map(Number);
    const grid = blank(rgb(8, 8, 8));
    grid[row][col] = rgb(0, 255, 0);
    await show(grid);
    console.log(`lit [${row},${col}] for 5 s`);
    await Bun.sleep(5000);
  } else {
    console.error(`unknown mode: ${mode}\n${USAGE}`);
  }
}
