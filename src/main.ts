// Phase 1 end-to-end slice: herdr agent status → Ornata V3 TKL zones.
// Agent panes take zones 0–7 (left → right) in the order they appear; extra panes wait for a free zone.
// Usage: bun src/main.ts [--dry-run]   (run inside herdr; --dry-run prints frames instead of lighting the keyboard)
//
// Two machines sharing the keyboard through a KVM: each gets half the zones (machine 1 → 0–3, machine 2 → 4–7)
// and they swap statuses through a websocket hub hosted by one of them:
//   machine 1: bun src/main.ts --machine 1 --serve 7777
//   machine 2: bun src/main.ts --machine 2 --hub ws://<machine-1>:7777
import { connect, type Socket } from "node:net";
import { openKeyboard, ZONES, type Keyboard, type Rgb } from "./razer";
import { joinHub, serveHub, type HubClient, type Slots } from "./sync";

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
interface Pane { agent?: string; status: AgentStatus }

// No white or grey: white is reserved for spotting the keyboard's default (Synapse) state.
const COLORS: Record<AgentStatus, Rgb> = {
  working: [0, 64, 255],
  blocked: [255, 140, 0],
  done: [0, 255, 0],
  idle: [40, 0, 60],
  unknown: [0, 0, 0],
};
const OFF: Rgb = [0, 0, 0];

const socketPath = process.env.HERDR_SOCKET_PATH;
if (!socketPath) throw new Error("HERDR_SOCKET_PATH not set (run inside herdr)");
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const dryRun = process.argv.includes("--dry-run");

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MACHINES = 2;
const servePort = arg("--serve");
const hubUrl = arg("--hub") ?? (servePort && `ws://localhost:${servePort}`);
const slot = Number(arg("--machine") ?? 1) - 1;
if (!Number.isInteger(slot) || slot < 0 || slot >= MACHINES) throw new Error(`--machine must be 1..${MACHINES}`);
// Alone, this machine owns every zone; with a hub, it owns its slot's block.
const slotZones = hubUrl ? ZONES / MACHINES : ZONES;

const panes = new Map<string, Pane>();
const zoneOrder: string[] = []; // agent pane ids, in order of appearance

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
  if ((pane.agent || status !== "unknown") && !zoneOrder.includes(id)) zoneOrder.push(id);
}

function removePane(id: string) {
  panes.delete(id);
  const i = zoneOrder.indexOf(id);
  if (i >= 0) zoneOrder.splice(i, 1);
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

const localStatuses = () => zoneOrder.slice(0, slotZones).map((id) => panes.get(id)!.status);

// Zone z belongs to slot floor(z / slotZones); our own slot comes from local state, the rest from the hub.
function frame(): { colors: Rgb[]; legend: string } {
  const local = localStatuses();
  const colors: Rgb[] = [];
  const legend: string[] = [];
  for (let z = 0; z < ZONES; z++) {
    const s = Math.floor(z / slotZones), i = z % slotZones;
    const status = s === slot ? local[i] : remote.get(s)?.[i];
    colors.push(COLORS[status as AgentStatus] ?? OFF);
    if (status) legend.push(`${z}:${s === slot ? zoneOrder[i] : `m${s + 1}`}=${status}`);
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

if (servePort) serveHub(Number(servePort));
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
