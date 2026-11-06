// Starts the keyboard daemon (src/main.ts) in the background, logging to daemon.log in the plugin state dir
// (the previous run's log is kept as daemon.log.1).
// Runs as the [[startup]] hook, so the daemon comes up with herdr, and as the "restart" action. Startup hooks must exit,
// so the daemon is detached; it stops by itself when herdr closes its event pipe. Any running daemon is stopped first.
// "autostart": false in config.json skips the startup hook (the restart action still works).
import { spawn } from "node:child_process";
import { openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { stateFile, stopPrevious } from "./instance";

if (process.env.HERDR_PLUGIN_EVENT === "startup" && loadConfig().autostart === false) {
  console.log("autostart is off in config.json");
  process.exit(0);
}

await stopPrevious();
const log = stateFile("daemon.log");
try {
  renameSync(log, `${log}.1`);
} catch {}
const out = openSync(log, "a");
const child = spawn(process.execPath, [join(import.meta.dir, "main.ts")], {
  detached: true,
  stdio: ["ignore", out, out],
  windowsHide: true,
});

// Report a daemon that dies straight away (bad config, missing keyboard driver) here, in herdr's plugin log.
const code = await Promise.race([
  new Promise<number | null>((res) => child.on("exit", res)),
  Bun.sleep(3000).then(() => "running" as const),
]);
if (code !== "running") {
  console.error(`daemon exited with code ${code}:\n${readFileSync(log, "utf8")}`);
  process.exit(1);
}
child.unref();
console.log(`daemon running (pid ${child.pid}), log: ${log}`);
process.exit(0);
