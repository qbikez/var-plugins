// Optional user config: <HERDR_PLUGIN_CONFIG_DIR>/config.json, e.g. { "machine": 2, "hub": "wss://host/?token=x" }.
// Plugin panes are launched from argv in the manifest, so this is how installed users set --machine/--hub/--serve.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  machine?: number;
  hub?: string;
  serve?: number | string;
  hubToken?: string;
  // Alternative to hub/serve: sync through an MQTT broker, e.g. "mqtts://user:pass@host:8883".
  mqtt?: string;
  mqttTopic?: string;
  // How agents map to a machine's zones: "status" (default, one zone per status) or "agent" (one zone per agent).
  strategy?: string;
}

export function configPath(): string | undefined {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  return dir ? join(dir, "config.json") : undefined;
}

export function loadConfig(): Config {
  const file = configPath();
  if (!file || !existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`invalid ${file}: ${(e as Error).message}`);
  }
}

export function saveConfig(config: Config) {
  const file = configPath();
  if (!file) throw new Error("HERDR_PLUGIN_CONFIG_DIR not set (run through herdr: herdr plugin action invoke ...)");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}
