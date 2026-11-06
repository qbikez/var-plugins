// One keyboard daemon per machine: a starting daemon stops the previous one (the background daemon from src/start.ts
// or a daemon pane), tracked by daemon.pid in the plugin state dir.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function stateFile(name: string): string {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!dir) throw new Error("HERDR_PLUGIN_STATE_DIR not set (run through herdr)");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

const pidFile = () => stateFile("daemon.pid");

function readPid(): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile(), "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

// The pid must still be a bun process: after a reboot it may belong to something else.
function isDaemon(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const out = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]).stdout.toString();
  return /^"bun\.exe"/im.test(out);
}

export async function stopPrevious() {
  const pid = readPid();
  if (!pid || pid === process.pid || !isDaemon(pid)) return;
  console.log(`stopping the previous daemon (pid ${pid})`);
  try {
    process.kill(pid);
  } catch {
    return;
  }
  for (let i = 0; i < 20 && isDaemon(pid); i++) await Bun.sleep(100);
}

// Stops the previous daemon and records this process as the current one, until it exits.
export async function claim() {
  await stopPrevious();
  writeFileSync(pidFile(), String(process.pid));
  process.on("exit", () => {
    if (readPid() === process.pid) rmSync(pidFile(), { force: true });
  });
}
