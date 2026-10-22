// Phase 1 end-to-end slice: herdr agent status → Ornata V3 TKL zones.
// Each machine owns half the keyboard (machine 1 → zones 0–3, machine 2 → 4–7), lit as indicators over all its agents:
// any blocked, any working, any done, any idle.
// Usage: bun src/main.ts [--dry-run]   (run inside herdr; --dry-run prints frames instead of lighting the keyboard)
//
// Two machines sharing the keyboard through a KVM swap statuses through a websocket hub hosted by one of them:
//   machine 1: bun src/main.ts --machine 1 --serve 7777
//   machine 2: bun src/main.ts --machine 2 --hub ws://<machine-1>:7777
// or through a standalone hub on a server (see src/hub.ts):
//   machine N: bun src/main.ts --machine N --hub wss://<server>/?token=<secret>
// --serve honours HUB_TOKEN, and the joining machine then adds ?token=<secret> to its --hub URL.
import { connect, type Socket } from "node:net";
import { loadConfig } from "./config";
import { openKeyboard, ZONES, type Keyboard, type Rgb } from "./razer";
import { joinHub, serveHub, type HubClient, type Slots } from "./sync";

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
interface Pane { agent?: string; status: AgentStatus }

// No white or grey: white is reserved for spotting the keyboard's default (Synapse) state.
const COLORS: Record<AgentStatus, Rgb> = {
  working: [0, 64, 255],
  blocked: [255, 140, 0],
  done: [0, 255, 0],
  idle: [120, 0, 180],
  unknown: [0, 0, 0],
};
const OFF: Rgb = [0, 0, 0];
// What each zone of a machine's half indicates, left → right.
const INDICATORS: AgentStatus[] = ["blocked", "working", "done", "idle"];
// A lit zone's brightness is the share of the machine's agents in that state, floored so one agent out of many stays visible.
const MIN_BRIGHTNESS = 0.2;
const dim = (rgb: Rgb, share: number): Rgb => {
  const k = MIN_BRIGHTNESS + (1 - MIN_BRIGHTNESS) * share;
  return rgb.map((c) => Math.round(c * k)) as Rgb;
};

const socketPath = process.env.HERDR_SOCKET_PATH;
if (!socketPath) throw new Error("HERDR_SOCKET_PATH not set (run inside herdr)");
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const dryRun = process.argv.includes("--dry-run");
if (process.platform !== "win32" && !dryRun) throw new Error("keyboard backend is Windows-only (use --dry-run elsewhere)");

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// Precedence: CLI flag > config.json in the plugin config dir > default.
const config = loadConfig();
const MACHINES = 2;
const servePort = arg("--serve") ?? (config.serve !== undefined ? String(config.serve) : undefined);
const hubToken = process.env.HUB_TOKEN ?? config.hubToken;
const hubUrl =
  arg("--hub") ??
  config.hub ??
  (servePort && `ws://localhost:${servePort}${hubToken ? `?token=${encodeURIComponent(hubToken)}` : ""}`);
const slot = Number(arg("--machine") ?? config.machine ?? 1) - 1;
if (!Number.isInteger(slot) || slot < 0 || slot >= MACHINES) throw new Error(`--machine must be 1..${MACHINES}`);
const slotZones = ZONES / MACHINES;

const panes = new Map<string, Pane>();

// --- herdr pipe ------------------------------------------------------------

function open(onMessage: (msg: any) => void): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(pipePath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onMessage(JSON.parse(line));
      }
    });
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

const request = (sock: Socket, id: string, method: string, params: object = {}) =>
  sock.write(JSON.stringify({ id, method, params }) + "\n");

async function snapshot(): Promise<any> {
  let resolveSnap!: (s: any) => void;
  const result = new Promise<any>((r) => (resolveSnap = r));
  const sock = await open((msg) => resolveSnap(msg.result?.snapshot));
  request(sock, "snapshot", "session.snapshot");
  const snap = await result;
  sock.end();
  if (!snap) throw new Error("session.snapshot returned no snapshot");
  return snap;
}

// pane.agent_status_changed needs a pane_id per subscription, and a live connection can't add subscriptions,
// so every pane creation means a fresh snapshot + a new subscription connection replacing the old one.
let subscription: Socket | undefined;
let subSeq = 0;

async function resync() {
  const snap = await snapshot();
  const live = new Set<string>();
  for (const p of snap.panes) {
    live.add(p.pane_id);
    setPane(p.pane_id, p.agent, p.agent_status);
  }
  for (const id of [...panes.keys()]) if (!live.has(id)) removePane(id);
  render();

  const id = `sub_${++subSeq}`;
  const sock = await open((msg) => {
    if (msg.id === id && msg.result?.type === "subscription_started") {
      const old = subscription;
      subscription = sock;
      old?.end();
    } else if (msg.event && sock === subscription) {
      onEvent(msg.event.replaceAll(".", "_"), msg.data);
    }
  });
  sock.on("close", () => {
    if (sock === subscription) shutdown("herdr closed the event pipe");
  });
  request(sock, id, "events.subscribe", {
    subscriptions: [
      { type: "pane.created" },
      { type: "pane.closed" },
      { type: "pane.agent_detected" },
      ...[...live].map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    ],
  });
}

// Pane creations often come in bursts (splits, new tabs); coalesce them into one resync.
let resyncTimer: Timer | undefined;
function scheduleResync() {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => resync().catch((e) => shutdown(`resync failed: ${e.message}`)), 100);
}

// --- state -----------------------------------------------------------------

function setPane(id: string, agent: string | undefined, status: AgentStatus = "unknown") {
  const pane = panes.get(id) ?? { status: "unknown" };
  pane.agent = agent ?? pane.agent;
  pane.status = status;
  panes.set(id, pane);
}

function removePane(id: string) {
  panes.delete(id);
}

function onEvent(kind: string, data: any) {
  switch (kind) {
    case "pane_created":
      setPane(data.pane.pane_id, data.pane.agent, data.pane.agent_status);
      scheduleResync();
      break;
    case "pane_closed":
      removePane(data.pane_id);
      break;
    // Ignore panes we don't know: a late event for a closed pane must not bring it back.
    case "pane_agent_detected":
      if (!panes.has(data.pane_id)) return;
      setPane(data.pane_id, data.agent, panes.get(data.pane_id)!.status);
      break;
    case "pane_agent_status_changed":
      if (!panes.has(data.pane_id)) return;
      setPane(data.pane_id, data.agent, data.agent_status);
      break;
    default:
      return;
  }
  render();
}

// --- output ----------------------------------------------------------------

let keyboard: Keyboard | undefined;
let hub: HubClient | undefined;
let remote: Slots = new Map();
let lastFrame = "";
let lastLegend = "";
let lastPublished = "";

// Every known agent status on this machine, sorted so unchanged state publishes identically.
const localStatuses = () => [...panes.values()].map((p) => p.status).filter((s) => s !== "unknown").sort();

// Zone z belongs to slot floor(z / slotZones) and lights when any of that machine's agents is in INDICATORS[z % slotZones],
// brighter the larger their share. Our own slot comes from local state, the others from the hub.
function frame(): { colors: Rgb[]; legend: string } {
  const local = localStatuses();
  const colors: Rgb[] = [];
  const legend: string[] = [];
  for (let s = 0; s < MACHINES; s++) {
    const statuses = s === slot ? local : (remote.get(s) ?? []);
    const counts = INDICATORS.map((ind) => statuses.filter((st) => st === ind).length);
    colors.push(...INDICATORS.map((ind, i) => (counts[i] ? dim(COLORS[ind], counts[i] / statuses.length) : OFF)));
    legend.push(`m${s + 1}[${INDICATORS.map((ind, i) => `${ind}:${counts[i]}`).join(" ")} of ${statuses.length}]`);
  }
  return { colors, legend: legend.join(" ") };
}

function render() {
  const local = JSON.stringify(localStatuses());
  if (hub && local !== lastPublished) {
    lastPublished = local;
    hub.publish(JSON.parse(local));
  }
  const { colors, legend } = frame();
  const key = JSON.stringify(colors);
  if (legend !== lastLegend) {
    lastLegend = legend;
    const swatches = colors.map(([r, g, b]) => `\x1b[48;2;${r};${g};${b}m  \x1b[0m`).join(" ");
    console.log(`${new Date().toISOString()} ${swatches}  ${legend}`);
  }
  if (key === lastFrame) return;
  lastFrame = key;
  show(colors);
}

// --- keyboard --------------------------------------------------------------

// Behind a KVM the keyboard comes and goes: a failed write drops it, and attach() keeps retrying until it's back.
function show(colors: Rgb[]) {
  const kb = keyboard;
  kb?.show(colors).catch((e) => {
    if (keyboard !== kb) return;
    keyboard = undefined;
    console.log(`keyboard detached: ${e.message}`);
    kb.close().catch(() => {});
  });
}

let attaching = false;
let lastAttachError = "";
async function attach() {
  if (keyboard || attaching || stopping) return;
  attaching = true;
  try {
    keyboard = await openKeyboard();
    lastAttachError = "";
    console.log("keyboard attached");
    if (lastFrame) show(JSON.parse(lastFrame));
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== lastAttachError) console.log(`keyboard unavailable: ${msg}, retrying`);
    lastAttachError = msg;
  } finally {
    attaching = false;
  }
}

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log(`stopping: ${reason}`);
  subscription?.end();
  hub?.close();
  await keyboard?.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (servePort) serveHub(Number(servePort), { token: hubToken });
if (hubUrl) {
  hub = joinHub(hubUrl, slot, (slots) => {
    remote = slots;
    render();
  });
}
if (!dryRun) {
  await attach();
  setInterval(() => {
    // Keep the keyboard refreshed in case the firmware resets (sleep/wake, replug), and pick it back up after a KVM switch.
    if (keyboard) lastFrame && show(JSON.parse(lastFrame));
    else attach();
  }, 2000);
}
await resync();
const zones = `zones ${slot * slotZones}–${slot * slotZones + slotZones - 1}`;
console.log(`watching herdr via ${pipePath} on ${zones}${dryRun ? " (dry run)" : ""}; Ctrl+C to stop`);
