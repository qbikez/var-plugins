# herdr Chroma plugin — proof of concept plan

Goal: prove that herdr agent state can drive a Razer Chroma keyboard reliably enough for daily use.
Feature ideas live in [chroma-features.md](chroma-features.md); this doc covers how to get to a working PoC.

## Background

### herdr plugin model
- A plugin is a directory with a `herdr-plugin.toml` manifest. No SDK — the herdr CLI (`HERDR_BIN_PATH`) and the socket API are the plugin API.
- Manifest entries: `[[build]]`, `[[startup]]`, `[[actions]]`, `[[events]]`, `[[panes]]`, `[[link_handlers]]`. Commands are argv arrays (no shell); Windows resolves `PATHEXT` shims like `bun.cmd`.
- Socket API: newline-delimited JSON; **named pipe on Windows**, path in `HERDR_SOCKET_PATH`. `events.subscribe` keeps the connection open and pushes events. Bootstrap with `session.snapshot`; on `events_lost`, resubscribe and re-snapshot.
- Relevant events: `pane.agent_status_changed`, `pane.focused`, `pane.created`, `pane.closed`, `pane.output_matched`, `tab.*`.
- Agent states: `idle`, `working`, `blocked`, `done` (idle and not yet seen), `unknown`. IDs: panes `w1:p1`, tabs `w1:t1`.
- Other env: `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONTEXT_JSON`.
- **Lifecycle constraint:** startup hooks are "one-shot initialization, not supervised daemons", and processes surviving server exit aren't protected from cleanup. Event hooks spawn a process per event, so they can't hold a Chroma session or animate. → we need a self-managed resident daemon.

### Lighting options
- **Chroma SDK REST** (`http://localhost:54235/razer/chromasdk`) — chosen for the PoC. POST app info → session URI; 15 s session timeout, so heartbeat ~1 s; `PUT /keyboard` with `CHROMA_CUSTOM` 6×22 BGR grid; `DELETE` session on exit. Works with any Razer keyboard, no packaging. Razer marks the Chroma SDK as no longer actively maintained (major bug fixes only), but it ships with Synapse 4.
- **Windows Dynamic Lighting (LampArray)** — the maintained, vendor-neutral standard with ambient/background control. Razer support is model- and firmware-dependent; likely requires a packaged WinRT app (C#/Rust). Deferred to optional Phase 5.
- WYVRN SDK (event-name driven, aimed at game partners) and OpenRGB (bypasses Synapse) are out of scope.

### Stack
Bun + TypeScript. `node:net` for the named pipe, `fetch` for Chroma REST, a hand-rolled REST client (no stale npm wrappers), zod for config. Lighting behind a `LightingBackend` interface so backends can be swapped.

## Architecture

```
herdr named pipe ──events──▶ state store ──▶ layer compositor ──▶ LightingBackend
 (snapshot + subscribe)      (per-pane       (base / overlay /     ├─ ChromaRest (PoC)
                              state, focus,   alert → 6×22 grid)   ├─ Console (dev/tests)
                              last output)                         └─ LampArray (optional)
```

Planned layout:

```
herdr-plugin.toml
src/
  main.ts            daemon entry: wire modules, signal/exit handling
  herdr/             pipe client, subscribe, reconnect, events_lost recovery
  state/             store + reducers from herdr events
  render/            Grid type, compositor loop (~20 fps), layers as pure fns
  backend/           LightingBackend interface, chroma-rest, console
  config.ts          zod schema, load from HERDR_PLUGIN_CONFIG_DIR
scripts/             startup hook, actions (toggle, restart, test-pattern)
spikes/              phase 0 throwaway scripts
test/fixtures/       recorded herdr event payloads
```

## Phases

### Phase 0 — Spikes (~½ day)
De-risk both integrations before any design.
- **Chroma spike:** Bun script that inits a REST session, heartbeats, PUTs a static `CHROMA_CUSTOM` grid, deletes the session on exit. Produce a grid-index → physical-key map for the actual keyboard.
- **herdr spike:** Bun script that connects to the named pipe from `HERDR_SOCKET_PATH`, calls `session.snapshot`, then `events.subscribe`, logging raw events. Confirms Bun `node:net` works with Windows named pipes (fallback: shell out to `HERDR_BIN_PATH`).
- Record real `pane.agent_status_changed` (and focus/create/close) payloads into `test/fixtures/`.

**Exit:** a key lights from code; real agent state transitions are captured.

**Done (2026-10-21)** — see [phase0-findings.md](phase0-findings.md). Key changes to the plan:
- The keyboard is a **Razer Ornata V3 TKL: 8 zones (1×8), not per-key**. "Pane N on key N" becomes "pane N on zone N"; per-key hints (Y/N) collapse to zones.
- **Backend = HID + SDK session:** colors go out as Razer HID feature reports (`bun:ffi`, protocol from OpenRazer); a held Chroma SDK REST session only exists to stop Synapse repainting and to hand the keyboard back on exit. Chroma REST `/keyboard` effects don't render on this device.
- herdr: `pane.agent_status_changed` needs a `pane_id` per subscription, and subscriptions can't be added on a live connection → resubscribe on a new connection when panes are created.

### Phase 1 — End-to-end slice (~1 day)
- Single script: subscribe → `paneId → state` map → panes mapped to keys `1`–`9` in creation order.
- Static colors: working = blue, blocked = amber, done = green, idle = dim purple. Never white — white means the keyboard is back in its default state.
- Redraw on every change; clean Chroma session release on Ctrl+C or pipe close.

**Exit:** with 2–3 Claude panes running, number keys reflect agent states. Validates the core value.

**Implemented (2026-10-21)** — `src/main.ts` + `src/razer.ts`, run with `bun start` (or `bun start:dry` to print frames without the keyboard). Adapted to the Phase 0 findings:
- Agent panes (an `agent` is set or status isn't `unknown`) take zones 0–7 left→right in order of appearance; a closed pane frees its zone and later panes shift left. Non-agent panes stay dark.
- Every `pane_created` triggers a fresh snapshot + a new subscription connection (debounced 100 ms); the old connection is dropped once the new one reports `subscription_started`.
- Frames go to HID only when colors change, plus a 5 s keepalive resend; the Chroma SDK session is released on SIGINT/SIGTERM or when herdr closes the pipe.
- Fake states from `herdr pane report-agent` on a pane without a real agent get reset to `unknown` by herdr within ~0.5 s, so test with real Claude panes.

**Two machines, one keyboard (KVM)** — `src/sync.ts`. Each machine runs its own instance and owns half the zones (`--machine 1` → 0–3, `--machine 2` → 4–7). Within a half, the zones are indicators over all of that machine's agents, left → right: any blocked (amber), any working (blue), any done (green), any idle (purple). One instance hosts a websocket hub (`--serve <port>`), the other joins it (`--hub ws://<host>:<port>`). Peers publish all their agents' statuses; the hub relays every slot to everyone and drops a slot when its peer disconnects. Whichever machine holds the keyboard renders all 8 zones; the other keeps retrying `openKeyboard` every 2 s and takes over after a KVM switch. A failed HID write is treated as "keyboard gone".

### Phase 2 — Structure + animation (~1–2 days)
- Refactor into `herdr/`, `state/`, `render/`, `backend/` modules.
- herdr client: reconnect, `events_lost` → re-snapshot and reconcile.
- Compositor: ~20 fps loop; layers are pure `(state, t) => Grid`, merged by priority.
- Console/mock backend that prints the grid, for tests and keyboard-less dev.
- Effects: breathing (working), pulse (blocked), full-board flash on any transition to `blocked`, focused-pane highlight.
- Only send frames when the grid changes, to avoid flooding the REST server.

**Exit:** layer unit tests pass against recorded fixtures; animations are smooth.

### Phase 3 — herdr plugin packaging (~1 day)
- `herdr-plugin.toml` with `platforms = ["windows"]`, `min_herdr_version`.
- `[[startup]]` hook: spawn daemon detached, write PID file to `HERDR_PLUGIN_STATE_DIR`, no-op if already running, exit immediately.
- Daemon self-terminates when the herdr pipe closes.
- `[[actions]]`: `toggle`, `restart`, `test-pattern`; README with a `[[keys.command]]` binding example.
- Dev loop: `herdr plugin link .`, inspect with `herdr plugin log list --plugin <id>`.

**Exit:** starting herdr lights the keyboard; quitting herdr restores the Synapse profile; no orphaned processes.

### Phase 4 — MVP polish (~1 day)
- Config TOML in `HERDR_PLUGIN_CONFIG_DIR`: state → color, pane → key layout, brightness; zod-validated with defaults.
- Approve/deny key hint when the focused pane is `blocked`.
- "Done" green clears on focus (mostly free via herdr's `done` = not yet seen).
- Graceful degradation: if Synapse/Chroma isn't available, keep tracking state and retry quietly.

**Exit:** survives a few days of real use without manual restarts.

### Phase 5 — Optional: LampArray backend
Small C# or Rust helper consuming grid frames over stdin, driving Windows Dynamic Lighting. Only if the keyboard appears under Settings › Personalization › Dynamic Lighting. Proves the backend abstraction.

## Out of scope for the PoC
Activity meter, token/context gauge, prefix-mode key highlighting, multi-device mirroring, success/failure waves. Each becomes an extra layer once Phase 2 exists.

## Risks

| Risk | Phase | Mitigation |
|---|---|---|
| Bun `node:net` ↔ Windows named pipe | 0 | Fallback to `HERDR_BIN_PATH` CLI calls |
| Grid index ↔ physical key mapping for this keyboard model | 0 | Test-pattern spike, store mapping in config |
| Detached daemon from startup hook misbehaves on Windows | 3 | Host daemon in a `[[panes]]` entry with `placement = "tab"` |
| Chroma REST stops working in a future Synapse | — | `LightingBackend` abstraction; LampArray backend |
| REST throughput limits at animation frame rates | 2 | Diff frames, cap fps, consider Chroma WebSocket |

## References
- [herdr plugin docs](https://herdr.dev/docs/plugins/)
- [herdr socket API](https://herdr.dev/docs/socket-api/)
- [Chroma SDK docs (WYVRN)](https://doc.wyvrn.com/docs/chroma-sdk/)
- [Chroma REST API reference](https://assets.razerzone.com/dev_portal/REST/html/index.html)
- [Windows Dynamic Lighting / LampArray](https://learn.microsoft.com/windows/uwp/devices-sensors/lighting-dynamic-lamparray)
