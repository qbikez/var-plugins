// User config: <HERDR_PLUGIN_CONFIG_DIR>/config.yaml (see EXAMPLE).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const EXAMPLE = `# Commands started when herdr starts and stopped when it exits.
commands:
  - name: hub                  # names the log file; defaults to the program name
    command: [bun, src/hub.ts] # argv list, run directly
    cwd: ~/src/hub             # defaults to your home directory
    restart: true              # start it again when it exits
  - name: docs
    command: npm run dev       # a string runs through the shell (cmd.exe on Windows, /bin/sh elsewhere)
    cwd: C:/git/docs
    env:
      PORT: "4000"
  - name: tunnel
    command: [ssh, -N, -L, "5432:localhost:5432", db]
    enabled: false             # skipped
`;

export interface CommandConfig {
  // Unique; names the log file. Defaults to the program name.
  name?: string;
  // An argv array (run directly) or a string (run through the shell: cmd.exe on Windows, /bin/sh elsewhere).
  command: string[] | string;
  // Working directory; "~" is the home directory. Defaults to the home directory.
  cwd?: string;
  // Extra environment variables.
  env?: Record<string, string>;
  // Start it again when it exits (default false).
  restart?: boolean;
  // false skips it (default true).
  enabled?: boolean;
}

export interface Config {
  commands?: CommandConfig[];
}

export interface Command {
  name: string;
  command: string[] | string;
  cwd: string;
  env: Record<string, string>;
  restart: boolean;
}

export function configPath(): string {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) throw new Error("HERDR_PLUGIN_CONFIG_DIR not set (run through herdr: herdr plugin action invoke ...)");
  return join(dir, "config.yaml");
}

export function loadConfig(): Config {
  const file = configPath();
  if (!existsSync(file)) return {};
  let config: unknown;
  try {
    config = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`invalid ${file}: ${(e as Error).message}`);
  }
  if (config == null) return {}; // empty file
  if (typeof config !== "object" || Array.isArray(config)) throw new Error(`invalid ${file}: expected a "commands:" mapping`);
  return config as Config;
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p);

function defaultName(command: string[] | string): string {
  const program = (Array.isArray(command) ? command[0] : command.trim().split(/\s+/)[0]) ?? "command";
  return program.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, "") || "command";
}

// The enabled commands, validated, with defaults filled in and unique names.
export function commands(config = loadConfig()): Command[] {
  if (config.commands !== undefined && !Array.isArray(config.commands)) throw new Error(`"commands" must be an array`);
  const used = new Set<string>();
  const out: Command[] = [];
  for (const [i, c] of (config.commands ?? []).entries()) {
    const valid = typeof c?.command === "string" ? c.command.trim() !== "" : Array.isArray(c?.command) && c.command.length > 0;
    if (!valid) throw new Error(`commands[${i}]: "command" must be a non-empty string or argv array`);
    if (c.enabled === false) continue;
    let name = c.name ?? defaultName(c.command);
    if (!/^[\w.-]+$/.test(name)) throw new Error(`commands[${i}]: name "${name}" may only use letters, digits, ".", "_" and "-"`);
    if (used.has(name)) {
      if (c.name) throw new Error(`commands[${i}]: duplicate name "${name}"`);
      let n = 2;
      while (used.has(`${name}-${n}`)) n++;
      name = `${name}-${n}`;
    }
    used.add(name);
    out.push({
      name,
      command: c.command,
      cwd: resolve(expandHome(c.cwd ?? "~")),
      // YAML reads `PORT: 4000` as a number.
      env: Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, String(v)])),
      restart: c.restart ?? false,
    });
  }
  return out;
}
