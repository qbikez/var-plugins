// Usage (through herdr, which sets the plugin env: herdr plugin action invoke qbikez.autostart.<action>, or inside a
// herdr pane with HERDR_PLUGIN_CONFIG_DIR / HERDR_PLUGIN_STATE_DIR set):
//   bun src/cli.ts start                  (re)start all commands; the [[startup]] hook and the "restart" action
//   bun src/cli.ts stop                   stop all commands
//   bun src/cli.ts status                 what's running
//   bun src/cli.ts log [name] [lines]     the supervisor log, or one command's log
//   bun src/cli.ts config                 print config.yaml and its path (or an example, if there is none yet)
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commands, configPath, EXAMPLE } from "./config";
import { logFile, readStatus, rotate, runningSupervisor, stateFile, stopSupervisor } from "./state";

const [cmd = "status", ...rest] = process.argv.slice(2);

function tail(file: string, lines: number) {
  console.log(file);
  if (existsSync(file)) console.log(readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n"));
  else console.log("(no log yet)");
}

async function start() {
  const list = commands(); // validate config.yaml before stopping anything
  const old = await stopSupervisor();
  if (old) console.log(`stopped the previous supervisor (pid ${old})`);
  if (list.length === 0) {
    console.log(`no commands configured; add some to ${configPath()} (see the config action for an example)`);
    return;
  }
  const log = stateFile("supervisor.log");
  rotate(log);
  const out = openSync(log, "a");
  const child = spawn(process.execPath, [join(import.meta.dir, "supervisor.ts")], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  // Report a supervisor that dies straight away here, in herdr's plugin log.
  const code = await Promise.race([
    new Promise<number | null>((res) => child.on("exit", res)),
    Bun.sleep(1500).then(() => "running" as const),
  ]);
  if (code !== "running") {
    console.error(`supervisor exited with code ${code}:\n${readFileSync(log, "utf8")}`);
    process.exit(1);
  }
  child.unref();
  console.log(`supervisor running (pid ${child.pid}): ${list.map((c) => c.name).join(", ")}`);
  console.log(`logs: ${join(stateFile("logs"))}`);
}

function status() {
  const pid = runningSupervisor();
  const s = readStatus();
  console.log(pid ? `supervisor running (pid ${pid})` : "supervisor not running");
  const names = commands().map((c) => c.name);
  for (const name of new Set([...names, ...Object.keys(s?.commands ?? {})])) {
    const c = pid && s?.supervisor === pid ? s.commands[name] : undefined;
    const state = !c
      ? names.includes(name) ? "not started" : undefined
      : c.running
        ? `running (pid ${c.pid}) since ${c.startedAt}${c.starts > 1 ? `, started ${c.starts}x` : ""}`
        : c.error ? `failed to start: ${c.error}` : `exited with code ${c.code} at ${c.exitedAt}`;
    if (state) console.log(`  ${name.padEnd(20)} ${state}`);
  }
}

try {
  switch (cmd) {
    case "start":
      await start();
      break;
    case "stop": {
      const pid = await stopSupervisor();
      console.log(pid ? `stopped the supervisor (pid ${pid}) and its commands` : "supervisor not running");
      break;
    }
    case "status":
      status();
      break;
    case "log": {
      const lines = rest.find((a) => /^\d+$/.test(a));
      const name = rest.find((a) => a !== lines);
      tail(name ? logFile(name) : stateFile("supervisor.log"), Number(lines ?? 40));
      break;
    }
    case "config":
      console.log(configPath());
      if (existsSync(configPath())) console.log(readFileSync(configPath(), "utf8").trimEnd());
      else console.log(`(no config.yaml yet) example:

${EXAMPLE}`);
      break;
    default:
      throw new Error(`unknown command "${cmd}" (start | stop | status | log | config)`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
process.exit(0);
