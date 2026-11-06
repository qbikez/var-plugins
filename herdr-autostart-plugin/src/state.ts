// Files in the plugin state dir: supervisor.pid, status.json (written by the supervisor), supervisor.log and
// logs/<name>.log (one per command; the previous run's log is kept as <name>.log.1).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";

export function stateFile(...parts: string[]): string {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!dir) throw new Error("HERDR_PLUGIN_STATE_DIR not set (run through herdr)");
  const file = join(dir, ...parts);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

export const logFile = (name: string) => stateFile("logs", `${name}.log`);

export function rotate(file: string) {
  try {
    renameSync(file, `${file}.1`);
  } catch {}
}

export interface Status {
  supervisor: number;
  commands: Record<
    string,
    { pid?: number; running: boolean; code?: number | null; error?: string; startedAt?: string; exitedAt?: string; starts: number }
  >;
}

export const writeStatus = (status: Status) => writeFileSync(stateFile("status.json"), JSON.stringify(status, null, 2));

export function readStatus(): Status | undefined {
  try {
    return JSON.parse(readFileSync(stateFile("status.json"), "utf8"));
  } catch {
    return undefined;
  }
}

// --- the supervisor's pid --------------------------------------------------

const pidFile = () => stateFile("supervisor.pid");

export function recordSupervisor(pid: number) {
  writeFileSync(pidFile(), JSON.stringify({ pid, startedAt: Date.now() }));
}

export function forgetSupervisor(pid: number) {
  if (runningSupervisor() === pid) rmSync(pidFile(), { force: true });
}

// The running supervisor's pid, if any. A pid recorded before the last boot, or that is no longer a bun process, is stale.
export function runningSupervisor(): number | undefined {
  try {
    const { pid, startedAt } = JSON.parse(readFileSync(pidFile(), "utf8"));
    if (!Number.isInteger(pid) || startedAt < Date.now() - uptime() * 1000) return undefined;
    return isBun(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isBun(pid: number): boolean {
  if (process.platform !== "win32") return isAlive(pid);
  const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" }).stdout ?? "";
  return /^"bun\.exe"/im.test(out);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Kills a process and everything it started. On Unix the process must lead its own process group (spawned detached).
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

// Stops the running supervisor and its commands, waiting up to 5s.
export async function stopSupervisor(): Promise<number | undefined> {
  const pid = runningSupervisor();
  if (!pid) return undefined;
  // Windows: kill the whole tree outright. Unix: SIGTERM lets the supervisor stop its commands' process groups.
  if (process.platform === "win32") killTree(pid);
  else process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && isAlive(pid); i++) await Bun.sleep(100);
  if (isAlive(pid)) killTree(pid, "SIGKILL");
  rmSync(pidFile(), { force: true });
  return pid;
}
