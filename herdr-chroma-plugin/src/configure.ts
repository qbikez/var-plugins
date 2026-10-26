// Edits config.json in the plugin config dir without hand-writing JSON.
// Usage: bun src/configure.ts [show]
//        bun src/configure.ts set <machine|hub|serve|hubToken|mqtt|mqttTopic> <value>
//        bun src/configure.ts unset <key>
// Changes apply the next time the daemon pane is opened.
import { configPath, loadConfig, saveConfig, type Config } from "./config";

const KEYS = ["machine", "hub", "serve", "hubToken", "mqtt", "mqttTopic", "strategy"] as const;
type Key = (typeof KEYS)[number];
const isKey = (k: string | undefined): k is Key => KEYS.includes(k as Key);

const [cmd = "show", key, value] = process.argv.slice(2);
const config: Config = loadConfig();

switch (cmd) {
  case "show":
    console.log(`${configPath() ?? "(no config dir: not run through herdr)"}\n${JSON.stringify(config, null, 2)}`);
    break;
  case "set": {
    if (!isKey(key) || value === undefined) fail(`usage: set <${KEYS.join("|")}> <value>`);
    if (key === "machine" || key === "serve") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || (key === "machine" && n > 2)) fail(`${key} must be ${key === "machine" ? "1 or 2" : "a port number"}`);
      (config as any)[key] = n;
    } else {
      (config as any)[key] = value;
    }
    saveConfig(config);
    console.log(`${key} = ${JSON.stringify((config as any)[key])} (restart the daemon pane to apply)`);
    break;
  }
  case "unset":
    if (!isKey(key)) fail(`usage: unset <${KEYS.join("|")}>`);
    delete config[key];
    saveConfig(config);
    console.log(`${key} unset (restart the daemon pane to apply)`);
    break;
  default:
    fail("usage: bun src/configure.ts [show | set <key> <value> | unset <key>]");
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
