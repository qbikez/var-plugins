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
//
// Or skip the hub and sync through an MQTT broker, each machine publishing its own slot (see src/mqtt.ts):
//   machine N: bun src/main.ts --machine N --mqtt mqtts://user:pass@broker:8883 [--mqtt-topic herdr-chroma]
import { connect, type Socket } from "node:net";
import { loadConfig } from "./config";
import { joinMqtt } from "./mqtt";
import { openKeyboard, ZONES, type Keyboard, type Rgb } from "./razer";
import { joinHub, serveHub, type HubClient, type Slots } from "./sync";

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
// doneAway: the agent finished while the keyboard was away (KVM switched to another machine). herdr marks a finished agent
// in the focused pane as seen straight away, since it can't tell we left, so it reports idle; we show it as done until we're back.
interface Pane { agent?: string; status: AgentStatus; doneAway?: boolean; workspaceId?: string }
// Workspace labels by id, refreshed on every resync (a rename shows up at the next pane creation).
const workspaceLabels = new Map<string, string>();

// No white or grey: white is reserved for spotting the keyboard's default (Synapse) state.
const COLORS: Record<AgentStatus, Rgb> = {
  working: [0, 64, 255],
  blocked: [255, 140, 0],
  done: [0, 255, 0],
  idle: [120, 0, 180],
  unknown: [0, 0, 0],
};
const OFF: Rgb = [0, 0, 0];
// "agent" strategy's summary zone when the remaining non-idle agents are in different states.
const MIXED: Rgb = [255, 0, 140];
// What each zone of a machine's half indicates, left → right.
const INDICATORS: AgentStatus[] = ["blocked", "working", "done", "idle"];
// A lit zone's brightness is the share of the machine's agents in that state, floored so one agent out of many stays visible.
const MIN_BRIGHTNESS = 0.2;
// A machine with exactly one active zone animates that zone's colour over all its zones,
// cycling through CYCLE every ANIMATION_CYCLE_MS. Each returns the brightness (0..1) of zone z of n at time t.
const ANIMATION_CYCLE_MS = 10_000, ANIMATION_TICK_MS = 100, ANIMATION_MIN = 0.08;
const wave = (phase: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
const hash = (n: number) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
type Animation = (t: number, z: number, n: number) => number;
const ANIMATIONS = {
  breathe: (t) => wave(t / 4000),
  wave: (t, z, n) => wave(t / 2000 - z / n),
  // Bounces back and forth with a short trail.
  scanner: (t, z, n) => {
    const pos = (n - 1) * (1 - Math.abs(((t / 2400) % 2) - 1));
    return Math.max(0, 1 - Math.abs(z - pos) / 1.5);
  },
  // Two quick beats, then rest.
  heartbeat: (t) => {
    const p = (t % 1400) / 1400;
    return Math.max(Math.exp(-(((p - 0.1) / 0.06) ** 2)), 0.7 * Math.exp(-(((p - 0.3) / 0.06) ** 2)));
  },
  // Each zone flares at its own pseudo-random moments.
  twinkle: (t, z) => {
    const slot = Math.floor(t / 400);
    return hash(slot * 7 + z) > 0.55 ? 1 - ((t % 400) / 400) : 0;
  },
} satisfies Record<string, Animation>;
// Defined but not in the rotation: heartbeat, twinkle. A name missing from ANIMATIONS fails to compile.
const CYCLE: (keyof typeof ANIMATIONS)[] = ["breathe", "wave", "scanner"];
const animationAt = (now: number): Animation => ANIMATIONS[CYCLE[Math.floor(now / ANIMATION_CYCLE_MS) % CYCLE.length]!];
const scale = (rgb: Rgb, k: number): Rgb => rgb.map((c) => Math.round(c * k)) as Rgb;
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
const mqttUrl = arg("--mqtt") ?? config.mqtt;
const mqttTopic = arg("--mqtt-topic") ?? config.mqttTopic;
const slot = Number(arg("--machine") ?? config.machine ?? 1) - 1;
if (!Number.isInteger(slot) || slot < 0 || slot >= MACHINES) throw new Error(`--machine must be 1..${MACHINES}`);
const slotZones = ZONES / MACHINES;
const strategyName = arg("--strategy") ?? config.strategy ?? "status";
if (strategyName !== "status" && strategyName !== "agent") throw new Error(`--strategy must be status or agent, got ${strategyName}`);
const strategy: "status" | "agent" = strategyName;

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
  workspaceLabels.clear();
  for (const w of snap.workspaces ?? []) workspaceLabels.set(w.workspace_id, w.label);
  for (const p of snap.panes) {
    live.add(p.pane_id);
    setPane(p.pane_id, p.agent, p.agent_status, p.workspace_id);
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

function setPane(id: string, agent: string | undefined, status: AgentStatus = "unknown", workspaceId?: string) {
  const pane = panes.get(id) ?? { status: "unknown" };
  pane.agent = agent ?? pane.agent;
  pane.workspaceId = workspaceId ?? pane.workspaceId;
  if (status !== "idle") pane.doneAway = false;
  else if (!pane.doneAway && (pane.status === "working" || pane.status === "blocked") && isAway()) pane.doneAway = true;
  pane.status = status;
  panes.set(id, pane);
}

function removePane(id: string) {
  panes.delete(id);
}

function onEvent(kind: string, data: any) {
  switch (kind) {
    case "pane_created":
      setPane(data.pane.pane_id, data.pane.agent, data.pane.agent_status, data.pane.workspace_id);
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
// Behind a KVM, no keyboard means another machine has it.
const isAway = () => !dryRun && !keyboard;
let hub: HubClient | undefined;
let remote: Slots = new Map();
let lastFrame = "";
let lastColors: Rgb[] = [];
let lastAnim: (Rgb | undefined)[] = [];
let lastShown = "";
let animTimer: Timer | undefined;
let lastLegend = "";
let lastPublished = "";

// A workspace named like "api z2" pins its agents to zone 2 (0-based, within the machine's own zones) in the "agent" strategy.
const pinOf = (label: string | undefined) => {
  const m = /z(\d)/i.exec(label ?? "");
  return m ? Number(m[1]) : undefined;
};
// Entries are synced between machines as "status" or "status@pin".
const decode = (entry: string) => {
  const [status, pin] = entry.split("@");
  return { status: status!, pin: pin === undefined ? undefined : Number(pin) };
};

// The first number in a workspace label orders the agents that aren't pinned; workspaces without one come last.
const orderOf = (label: string | undefined) => {
  const m = /\d+/.exec(label ?? "");
  return m ? Number(m[0]) : Infinity;
};

// Every known agent on this machine. The "agent" strategy maps position to zone, so the order must be stable:
// by workspace number, then pane order (the sort is stable). Peers receive the order as the array order.
const localAgents = () =>
  [...panes.entries()]
    .filter(([, p]) => p.status !== "unknown")
    .map(([id, p]) => {
      const status = p.doneAway ? "done" : p.status;
      const label = workspaceLabels.get(p.workspaceId ?? "");
      const pin = pinOf(label);
      return { id, workspaceId: p.workspaceId, entry: pin === undefined ? status : `${status}@${pin}`, order: orderOf(label) };
    })
    .sort((a, b) => (a.order === b.order ? 0 : a.order < b.order ? -1 : 1));
const localStatuses = () => localAgents().map((a) => a.entry);

interface Layout { colors: Rgb[]; anim: Rgb | undefined; legend: string }

// "status": zone i lights when any of the machine's agents is in INDICATORS[i], brighter the larger their share.
function byStatus(entries: string[]): Layout {
  const statuses = entries.map((e) => decode(e).status);
  const counts = INDICATORS.map((ind) => statuses.filter((st) => st === ind).length);
  const active = INDICATORS.filter((_, i) => counts[i]);
  return {
    colors: INDICATORS.map((ind, i) => (counts[i] ? dim(COLORS[ind], counts[i] / statuses.length) : OFF)),
    anim: active.length === 1 ? COLORS[active[0]] : undefined,
    legend: `${INDICATORS.map((ind, i) => `${ind}:${counts[i]}`).join(" ")} of ${statuses.length}`,
  };
}

// Idle agents are ignored unless that's all there is; a single non-idle status shows as itself, a mix shows MIXED.
function summarise(statuses: string[]): Rgb {
  const busy = new Set(statuses.filter((s) => s !== "idle"));
  return !statuses.length ? OFF : !busy.size ? COLORS.idle : busy.size === 1 ? COLORS[[...busy][0] as AgentStatus] : MIXED;
}

// "agent": the first slotZones - 1 zones are one per agent, the last summarises the rest. Agents in a workspace pinned to
// one of those zones (see pinOf) share it, summarised; the other agents fill the zones left free, in order.
function byAgent(entries: string[]): Layout {
  const agents = entries.map(decode);
  const zones = assignZones(entries);
  const groups: string[][] = Array.from({ length: slotZones }, () => []);
  agents.forEach((a, i) => groups[zones[i]!]!.push(a.status));
  return {
    colors: groups.map(summarise),
    anim: undefined,
    legend: agents.length ? agents.map((a) => (a.pin === undefined ? a.status : `${a.status}@z${a.pin}`)).join(",") : "none",
  };
}

// The zone (0..slotZones - 1, the last being the summary zone) of each entry in the "agent" strategy.
function assignZones(entries: string[]): number[] {
  const own = slotZones - 1;
  const agents = entries.map(decode);
  const claimed = new Set(agents.flatMap((a) => (a.pin !== undefined && a.pin < own ? [a.pin] : [])));
  const free = Array.from({ length: own }, (_, z) => z).filter((z) => !claimed.has(z));
  let next = 0;
  return agents.map((a) => (a.pin !== undefined && a.pin < own ? a.pin : (free[next++] ?? own)));
}
const STRATEGIES = { status: byStatus, agent: byAgent };

// Slot s owns zones s * slotZones onward. Our own slot comes from local state, the others from the hub.
function frame(): { colors: Rgb[]; anim: (Rgb | undefined)[]; legend: string } {
  const local = localStatuses();
  const colors: Rgb[] = [];
  const anim: (Rgb | undefined)[] = [];
  const legend: string[] = [];
  for (let s = 0; s < MACHINES; s++) {
    const layout = STRATEGIES[strategy](s === slot ? local : (remote.get(s) ?? []));
    colors.push(...layout.colors);
    anim.push(layout.anim);
    legend.push(`m${s + 1}[${layout.legend}]`);
  }
  return { colors, anim, legend: legend.join(" ") };
}

// The "agent" strategy tells herdr which zone each agent and workspace maps to, as a `chroma_zone` metadata token written in the
// chosen zoneLabels set. Show it with $chroma_zone in ui.sidebar.agents.rows / ui.sidebar.spaces.rows.
const ZONE_TOKEN = "chroma_zone", TOKEN_SOURCE = "chroma";
// How a machine's zones (0..slotZones - 1) are written. `label` names one zone; `join` names a workspace's several zones.
interface ZoneLabels { label: (zone: number) => string; join: (zones: number[]) => string }
const listed = (labels: string[], sep: string): ZoneLabels => ({
  label: (z) => labels[z] ?? String(z),
  join: (zones) => zones.map((z) => labels[z] ?? String(z)).join(sep),
});
const strip = (on: string, off: string): ZoneLabels => {
  const draw = (zones: number[]) => Array.from({ length: slotZones }, (_, i) => (zones.includes(i) ? on : off)).join("");
  return { label: (z) => draw([z]), join: draw };
};
const glyphs = (codepoints: number[]) => listed(codepoints.map((c) => String.fromCodePoint(c)), " ");
const BRAILLE_DOTS = [0x01, 0x02, 0x04, 0x40];
const ZONE_LABELS = {
  // 0️⃣ 1️⃣ 2️⃣ 3️⃣, i.e. digit + variation selector + combining keycap.
  emoji: listed([0, 1, 2, 3].map((z) => `${z}️⃣`), ""),
  digits: listed(["0", "1", "2", "3"], ","),
  letters: listed(["A", "B", "C", "D"], ","),
  // A strip of the machine's zones with the mapped ones marked, e.g. --#- for zone 2 and #--# for a workspace spanning 0 and 3.
  bar: strip("#", "-"),
  dots: strip("●", "○"),
  squares: strip("■", "□"),
  // Growing: zone 0 is a quarter, zone 3 a full circle / a full-height bar / a full-width bar.
  pie: listed(["◔", "◑", "◕", "●"], ""),
  blocks: listed(["▂", "▄", "▆", "█"], ""),
  fill: listed(["▎", "▌", "▊", "█"], ""),
  // Nerd Font (v3+) Material Design glyphs, codepoints from nerd-fonts' glyphnames.json.
  "nf-box": glyphs([0xf03a1, 0xf03a4, 0xf03a7, 0xf03aa]), // numeric_{0..3}_box
  "nf-circle": glyphs([0xf0c9e, 0xf0ca0, 0xf0ca2, 0xf0ca4]), // numeric_{0..3}_circle
  "nf-letters": glyphs([0xf0b08, 0xf0b09, 0xf0b0a, 0xf0b0b]), // alpha_{a..d}_box
  "nf-dice": glyphs([0xf01ca, 0xf01cb, 0xf01cc, 0xf01cd]), // dice_{1..4}
  "nf-pie": glyphs([0xf0a9f, 0xf0aa1, 0xf0aa3, 0xf0aa5]), // circle_slice_{2,4,6,8}: a quarter up to full
  "nf-battery": glyphs([0xf007c, 0xf007e, 0xf0080, 0xf0082]), // battery_{30,50,70,90}
  // One braille cell with a dot per zone (⠁ ⠂ ⠄ ⡀), so a workspace spanning zones is still a single character.
  braille: {
    label: (z) => String.fromCodePoint(0x2800 | BRAILLE_DOTS[z]!),
    join: (zones) => String.fromCodePoint(0x2800 | zones.reduce((bits, z) => bits | BRAILLE_DOTS[z]!, 0)),
  },
} satisfies Record<string, ZoneLabels>;
const zoneLabelsName = arg("--zone-labels") ?? config.zoneLabels ?? "emoji";
if (!(zoneLabelsName in ZONE_LABELS)) throw new Error(`--zone-labels must be one of ${Object.keys(ZONE_LABELS).join(", ")}, got ${zoneLabelsName}`);
const zoneLabels = ZONE_LABELS[zoneLabelsName as keyof typeof ZONE_LABELS];
const sentTokens = new Map<string, string>();

// Returns once herdr has answered every report (or 2 s have passed). `clear` withdraws all tokens, for shutdown.
function syncZoneTokens(clear = false): Promise<void> {
  const want = new Map<string, string>();
  if (strategy === "agent" && !clear) {
    const agents = localAgents();
    const zones = assignZones(agents.map((a) => a.entry));
    const byWorkspace = new Map<string, Set<number>>();
    agents.forEach((a, i) => {
      want.set(`pane:${a.id}`, zoneLabels.label(zones[i]!));
      if (a.workspaceId) byWorkspace.set(a.workspaceId, (byWorkspace.get(a.workspaceId) ?? new Set()).add(zones[i]!));
    });
    for (const [id, set] of byWorkspace) want.set(`workspace:${id}`, zoneLabels.join([...set].sort()));
  }
  const reports: { method: string; params: object }[] = [];
  const report = (key: string, value: string | null) => {
    const [kind, id] = key.split(/:(.*)/) as [string, string];
    reports.push({ method: `${kind}.report_metadata`, params: { [`${kind}_id`]: id, source: TOKEN_SOURCE, tokens: { [ZONE_TOKEN]: value } } });
  };
  for (const [key, value] of want) if (sentTokens.get(key) !== value) report(key, value);
  for (const key of sentTokens.keys()) if (!want.has(key)) report(key, null);
  sentTokens.clear();
  for (const [key, value] of want) sentTokens.set(key, value);
  if (!reports.length || dryRun) return Promise.resolve();
  // One request per connection, like snapshot(): herdr only answers the first request on a connection.
  // A report for a pane that has just closed is refused; nothing to do about that.
  const send = async (r: (typeof reports)[number], i: number) => {
    let resolveAnswer!: () => void;
    const answer = new Promise<void>((res) => (resolveAnswer = res));
    const sock = await open(() => resolveAnswer());
    request(sock, `zone_${i}`, r.method, r.params);
    await answer;
    sock.end();
  };
  const timeout = new Promise<void>((res) => setTimeout(res, 2000));
  return Promise.race([Promise.allSettled(reports.map(send)).then(() => {}), timeout]);
}

function render() {
  if (strategy === "agent") syncZoneTokens();
  const local = JSON.stringify(localStatuses());
  if (hub && local !== lastPublished) {
    lastPublished = local;
    hub.publish(JSON.parse(local));
  }
  const { colors, anim, legend } = frame();
  const key = JSON.stringify([colors, anim]);
  if (legend !== lastLegend) {
    lastLegend = legend;
    const swatches = colors.map(([r, g, b]) => `\x1b[48;2;${r};${g};${b}m  \x1b[0m`).join(" ");
    console.log(`${new Date().toISOString()} ${swatches}  ${legend}`);
  }
  if (key === lastFrame) return;
  lastFrame = key;
  lastColors = colors;
  lastAnim = anim;
  clearInterval(animTimer);
  animTimer = anim.some(Boolean) ? setInterval(paint, ANIMATION_TICK_MS) : undefined;
  paint();
}

// Static zones as computed, with animating machines' zones replaced by the current animation frame of their colour.
function paint(force = false) {
  const now = Date.now();
  const level = animationAt(now);
  const colors = lastColors.map((c, z) => {
    const b = lastAnim[Math.floor(z / slotZones)];
    return b ? scale(b, ANIMATION_MIN + (1 - ANIMATION_MIN) * level(now, z % slotZones, slotZones)) : c;
  });
  const key = JSON.stringify(colors);
  if (!force && key === lastShown) return;
  lastShown = key;
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
// Back off while the device is unusable so a wedged driver doesn't churn Chroma SDK sessions every tick.
const RETRY_MIN_MS = 2000, RETRY_MAX_MS = 30_000;
let retryDelay = RETRY_MIN_MS, nextAttachAt = 0;
async function attach() {
  if (keyboard || attaching || stopping || Date.now() < nextAttachAt) return;
  attaching = true;
  try {
    keyboard = await openKeyboard();
    lastAttachError = "";
    retryDelay = RETRY_MIN_MS;
    console.log("keyboard attached");
    for (const pane of panes.values()) pane.doneAway = false;
    render();
    if (lastFrame) paint(true);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== lastAttachError) console.log(`keyboard unavailable: ${msg}, retrying`);
    lastAttachError = msg;
    nextAttachAt = Date.now() + retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  } finally {
    attaching = false;
  }
}

let stopping = false;
async function shutdown(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log(`stopping: ${reason}`);
  if (strategy === "agent") await syncZoneTokens(true);
  subscription?.end();
  hub?.close();
  await keyboard?.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const onSlots = (slots: Slots) => {
  remote = slots;
  render();
};
if (mqttUrl) {
  hub = joinMqtt(mqttUrl, slot, onSlots, mqttTopic);
} else {
  if (servePort) serveHub(Number(servePort), { token: hubToken });
  if (hubUrl) hub = joinHub(hubUrl, slot, onSlots);
}
if (!dryRun) {
  await attach();
  setInterval(() => {
    // Keep the keyboard refreshed in case the firmware resets (sleep/wake, replug), and pick it back up after a KVM switch.
    if (keyboard) lastFrame && paint(true);
    else attach();
  }, 2000);
}
await resync();
const zones = `zones ${slot * slotZones}–${slot * slotZones + slotZones - 1}`;
console.log(`watching herdr via ${pipePath} on ${zones}${dryRun ? " (dry run)" : ""}; Ctrl+C to stop`);
