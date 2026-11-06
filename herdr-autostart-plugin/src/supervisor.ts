// Runs the commands from config.json, each logging to logs/<name>.log in the plugin state dir, and stops them all when
// herdr closes its event pipe (herdr exited) or the supervisor is stopped. Started detached by `src/cli.ts start`.
import { type ChildProcess, spawn } from "node:child_process";
import { openSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { type Command, commands } from "./config";
import { forgetSupervisor, killTree, logFile, recordSupervisor, rotate, type Status, writeStatus } from "./state";

for (const level of ["log", "error"] as const) {
  const write = console[level];
  console[level] = (...args: unknown[]) => write(new Date().toISOString(), ...args);
}

const list = commands();
const status: Status = { supervisor: process.pid, commands: {} };
const children = new Map<string, ChildProcess>();
let stopping = false;

recordSupervisor(process.pid);

// Children see the environment of a normal herdr process, not this plugin's.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_PLUGIN_")));

const quote = (arg: string) => (/^[\w\-.:\\/=@]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`);

// argv for spawn. Strings go through the shell. On Windows, .cmd/.bat shims (npm, pnpm, ...) can't be spawned directly.
function argv(c: Command): { file: string; args: string[]; shell: boolean; verbatim?: boolean } {
  if (typeof c.command === "string") return { file: c.command, args: [], shell: true };
  const [program, ...args] = c.command;
  if (process.platform === "win32") {
    const resolved = Bun.which(program, { cwd: c.cwd }) ?? program;
    if (/\.(cmd|bat)$/i.test(resolved))
      return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${[resolved, ...args].map(quote).join(" ")}"`], shell: false, verbatim: true };
    return { file: resolved, args, shell: false };
  }
  return { file: program, args, shell: false };
}

function start(c: Command) {
  const s = (status.commands[c.name] ??= { running: false, starts: 0 });
  const log = logFile(c.name);
  if (s.starts === 0) rotate(log);
  const out = openSync(log, "a");
  writeSync(out, `--- ${new Date().toISOString()} starting in ${c.cwd}: ${JSON.stringify(c.command)}\n`);

  const { file, args, shell, verbatim } = argv(c);
  const child = spawn(file, args, {
    cwd: c.cwd,
    env: { ...baseEnv, ...c.env },
    shell,
    stdio: ["ignore", out, out],
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    // Unix: its own process group, so stopping it also stops whatever it started.
    detached: process.platform !== "win32",
  });
  const startedAt = Date.now();
  children.set(c.name, child);
  Object.assign(s, { pid: child.pid, running: true, code: undefined, error: undefined, startedAt: new Date(startedAt).toISOString(), exitedAt: undefined });
  s.starts++;
  writeStatus(status);
  console.log(`${c.name}: started (pid ${child.pid})`);

  let done = false;
  const finished = (code: number | null, error?: string) => {
    if (done) return;
    done = true;
    children.delete(c.name);
    Object.assign(s, { running: false, code, error, exitedAt: new Date().toISOString() });
    writeStatus(status);
    console.log(`${c.name}: ${error ? `failed to start: ${error}` : `exited with code ${code}`}`);
    if (stopping || !c.restart) return;
    // Back off when it keeps dying straight away.
    const ranFor = Date.now() - startedAt;
    const delay = ranFor > 10_000 ? 1000 : Math.min(60_000, 1000 * 2 ** Math.min(s.starts, 6));
    console.log(`${c.name}: restarting in ${delay / 1000}s`);
    setTimeout(() => stopping || start(c), delay);
  };
  child.on("error", (e) => finished(null, e.message));
  child.on("exit", (code, signal) => finished(code ?? (signal ? -1 : null)));
}

function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log(`stopping: ${reason}`);
  for (const [name, child] of children) {
    if (child.pid) killTree(child.pid);
    console.log(`${name}: stopped`);
  }
  forgetSupervisor(process.pid);
  setTimeout(() => process.exit(0), 200);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Stay subscribed to herdr's events; the pipe closes when herdr exits.
function watchHerdr() {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    console.log("HERDR_SOCKET_PATH not set: not watching herdr, stop with Ctrl+C");
    return;
  }
  const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const sock = connect(pipePath);
  sock.on("connect", () => {
    sock.write(JSON.stringify({ id: "watch", method: "events.subscribe", params: { subscriptions: [{ type: "pane.created" }] } }) + "\n");
  });
  sock.on("data", () => {});
  sock.on("error", (e) => shutdown(`herdr pipe error: ${e.message}`));
  sock.on("close", () => shutdown("herdr closed the event pipe"));
}

watchHerdr();
console.log(`supervisor ${process.pid}: starting ${list.length} command(s)`);
for (const c of list) start(c);
writeStatus(status);
