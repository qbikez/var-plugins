// Phase 0 spike: connect to the herdr API pipe, snapshot, subscribe, log raw events.
// On Windows the pipe is `\\.\pipe\<HERDR_SOCKET_PATH>`; the .sock file on disk only holds `pid:token`.
import { connect, type Socket } from "node:net";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const socketPath = process.env.HERDR_SOCKET_PATH;
if (!socketPath) throw new Error("HERDR_SOCKET_PATH not set (run inside herdr)");
const pipePath = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

const fixturesDir = join(import.meta.dir, "..", "test", "fixtures");
mkdirSync(fixturesDir, { recursive: true });
const eventsFile = join(fixturesDir, "herdr-events.jsonl");

// pane.agent_status_changed requires pane_id; everything else here is global.
const GLOBAL_SUBSCRIPTIONS = [
  "pane.updated",
  "pane.agent_detected",
  "pane.focused",
  "pane.created",
  "pane.closed",
  "pane.exited",
  "tab.created",
  "tab.closed",
  "tab.focused",
].map((type) => ({ type }));

function open(onLine: (line: string) => void): Promise<Socket> {
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
        if (line) onLine(line);
      }
    });
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

function send(sock: Socket, id: string, method: string, params: object = {}) {
  sock.write(JSON.stringify({ id, method, params }) + "\n");
}

// Snapshot on its own connection, as the docs recommend.
const snapshot = await new Promise<unknown>(async (resolve) => {
  const sock = await open((line) => {
    sock.end();
    resolve(JSON.parse(line));
  });
  send(sock, "snap_1", "session.snapshot");
});
writeFileSync(join(fixturesDir, "session-snapshot.json"), JSON.stringify(snapshot, null, 2));
console.log("snapshot saved:", JSON.stringify(snapshot).length, "bytes");

const statusSub = (pane_id: string) => ({ type: "pane.agent_status_changed", pane_id });
const paneIds: string[] = (snapshot as any).result.snapshot.panes.map((p: any) => p.pane_id);

let subSeq = 1;
const sub = await open((line) => {
  const ts = new Date().toISOString();
  console.log(ts, line);
  const raw = JSON.parse(line);
  appendFileSync(eventsFile, JSON.stringify({ ts, raw }) + "\n");
  // Probe: can subscriptions be extended on a live connection?
  if (raw.event === "pane_created" || raw.event === "pane.created") {
    const id = raw.data?.pane?.pane_id ?? raw.data?.pane_id;
    if (id) send(sub, `sub_${++subSeq}`, "events.subscribe", { subscriptions: [statusSub(id)] });
  }
});
sub.on("close", () => {
  console.log("subscription closed by server");
  process.exit(0);
});
send(sub, "sub_1", "events.subscribe", {
  subscriptions: [...GLOBAL_SUBSCRIPTIONS, ...paneIds.map(statusSub)],
});
console.log(`subscribed via ${pipePath}; logging to ${eventsFile} (Ctrl+C to stop)`);

process.on("SIGINT", () => {
  sub.end();
  process.exit(0);
});
