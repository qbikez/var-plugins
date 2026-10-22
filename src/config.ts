// Optional user config: <HERDR_PLUGIN_CONFIG_DIR>/config.json, e.g. { "machine": 2, "hub": "wss://host/?token=x" }.
// Plugin panes are launched from argv in the manifest, so this is how installed users set --machine/--hub/--serve.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  machine?: number;
  hub?: string;
  serve?: number | string;
  hubToken?: string;
}

export function loadConfig(): Config {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) return {};
  const file = join(dir, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`invalid ${file}: ${(e as Error).message}`);
  }
}
