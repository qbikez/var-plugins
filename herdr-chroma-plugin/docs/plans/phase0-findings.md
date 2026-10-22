# Phase 0 findings

Environment: herdr 0.9.3 (protocol 22), Bun 1.3.12, Chroma SDK REST 4.00.03 (Synapse 4), Windows 11.

## herdr spike — `spikes/herdr-events.ts` ✅

- **Transport:** Bun `node:net` works with the Windows named pipe; no CLI fallback needed.
  The pipe name is `\\.\pipe\` + the full `HERDR_SOCKET_PATH` (e.g. `\\.\pipe\C:\Users\…\herdr\herdr.sock`).
  The `.sock` file on disk only holds `<server pid>:<token>`.
- **Schema:** `herdr api schema --json` dumps the full request/event JSON schema; use it, not the docs, as the source of truth.
- **`pane.agent_status_changed` requires `pane_id`** — there is no global status subscription.
  Subscribe one entry per pane from `session.snapshot` → `result.snapshot.panes[].pane_id`.
- **Subscriptions can't be extended on a live connection:** a second `events.subscribe` on the same socket gets no reply and no events.
  → on `pane_created`, open a new subscription connection with the full pane list (and drop the old one).
- `pane.updated` is global and carries full `PaneInfo` (incl. `agent_status`), but in testing it fired on title/resize changes, not on status changes. Don't rely on it for status.
- Event envelope: `{"event":"<kind>","data":{…,"type":"<kind>"}}`. Kind naming is inconsistent: lifecycle events use `pane_created`/`pane_closed`/`pane_agent_detected`, status events use `pane.agent_status_changed`.
- Status payload: `{"agent":"claude","agent_status":"blocked","pane_id":"w6:p4","workspace_id":"w6"}`.
- Reporting `idle` on an unfocused pane is delivered as `done` (as expected).
- `herdr pane report-agent --source X --agent claude --state <s> --seq N <pane>` drives fake transitions — useful for manual tests.
- Fixtures: `test/fixtures/session-snapshot.json`, `herdr-events.jsonl` (status transitions), `herdr-events-lifecycle.jsonl` (create/update/detect/close).
- Not yet captured: `pane_focused` (needs a manual pane switch in the UI).

## Chroma spike — `spikes/chroma-grid.ts` ⛔ blocked

- `POST /razer/chromasdk` works and returns `{sessionid, uri: "http://localhost:<port>/chromasdk"}`.
- **Every session URI refuses connections.** RzSDKServer log (`C:\Program Files (x86)\Razer Chroma SDK\logs\RzSDKServer.exe.log`, UTF-16):
  `Casablanca_RESTServer.cpp (953), Error (1008): An attempt was made to reference a token that does not exist.`
  The service fails to open the per-session HTTP.sys listener. Likely broken state after the Synapse update that ran this morning (server restarted 06:18).
  Next step: restart the *Razer Chroma SDK Server* service (admin) and re-run.
- HTTP.sys quirks: Host must be `localhost` (`127.0.0.1` → 400 Invalid Hostname); empty-body PUTs need `Content-Length` (411).
- RzSDKServer also runs WebSocket servers on `ws://localhost:13337` and `:1337` — a possible alternative transport if REST sessions remain unreliable.
- **Restarting the service (08:34) did not fix it** — the 1008 error persists on a fresh server. REST sessions are broken on this Synapse build.
- Grid → key map seeded from the SDK `RZKEY` enum in `spikes/keymap.ts`; to be verified with `bun spikes/chroma-grid.ts walk`.

## Chroma WebSocket spike — `spikes/chroma-ws.ts` ❓ needs a visual check

- [Docs](https://assets.razerzone.com/dev_portal/websocket/html/pages.html): connect to `wss://chromasdk.io:13339/razer/chromasdk`, send the app-info JSON, then effects as `{"endpoint":"keyboard","effect":…,"param":…}`; reply `{"result":0}`. No heartbeat — closing the socket ends the session (fits the daemon model better than REST).
- On this build RzSDKServer only listens on `127.0.0.1:1337` (internal Razer app channel; rejects `/razer/chromasdk` with error 27) and `[::1]:13337`. Port 13339 is not bound.
- `ws://localhost:13337/razer/chromasdk` accepts the connection but never replies and doesn't log incoming messages (`Session id 0 cannot be found` on close). Tried: plain init, `Origin: https://chromasdk.io`, `endpoint: "init"`, REST-style wrapper.
- Unknown whether effects apply silently — run `bun spikes/chroma-ws.ts --static test` and look at the keyboard.

## Hardware: Razer Ornata V3 Tenkeyless — zoned, not per-key ⚠️

- `C:\Program Files (x86)\Razer Chroma SDK\Devices\<containerId>.json` → `productName: "Razer Ornata V3 Tenkeyless"`, PID 675 (0x02A3), `ledConfig` **1 row × 8 columns**, `lampArrayDeviceId: null` (no Windows Dynamic Lighting → Phase 5 is moot for this device).
- The 8 zones are vertical strips, left→right: 0 Esc/`/1/Tab/Caps/LShift/LCtrl · 1 2–3/QW/AS/ZX · 2 4–5/ERT/DF/CV · 3 6–7/YU/GH/BN/Space · 4 8–0/IO/JK/M, · 5 -=/P[]/L;/./ · 6 Backspace/\/Enter/RShift/right mods · 7 nav cluster + arrows.
- **Design impact:** "one number key per pane" isn't possible; at most one *zone* per pane (≤ 8, realistically 6–7), and per-key effects like approve/deny hints on `Y`/`N` collapse to whole zones.
- REST after the 19:44 service restart: session listener up ~110 ms after init; `CHROMA_STATIC` and `CHROMA_CUSTOM` return `{"result":0}`. How the 6×22 grid folds onto 8 zones is unknown → `bun spikes/chroma-grid.ts probe`.
- Synapse spawns a per-app proxy `C:\ProgramData\Razer Chroma SDK\Apps\<title>\<title>.exe` for every session; its log `logs\<title>.exe.log` is the most useful debugging trace.

## ✅ Chroma Link drives the Ornata V3 TKL — `spikes/chroma-link.ts`

- Synapse 4 drives this keyboard through a `ChromaLinkHandler` device module (`logs\Device_0002a3.log`), which ignores `/keyboard` effects (the app gets access and the board goes dark, but frames never reach the module).
- REST with `device_supported: ["keyboard", "chromalink"]` and `PUT <session>/chromalink` with `CHROMA_CUSTOM` (5-element BGR array) visibly lights the keyboard. `CHROMA_STATIC` on chromalink is ignored.
- Observed LED → zone mapping (Chroma Studio shows 8 zones):

  | Link LED | Physical zones | Keys (approx.) |
  |---|---|---|
  | 0 | — ignored | |
  | 1 | 0–2 | Esc … 5, Q–T, A–F, Z–V |
  | 2 | 3–4 | 6 … 0, Y–O, G–K, B–M, Space |
  | 3 | 5–7 | - = … Backspace, Enter, RShift, nav + arrows |
  | 4 | — ignored | |

- **So the SDK gives 3 independent color groups** (left / middle / right). The 8 zones Chroma Studio controls aren't reachable through the SDK on this device.
- Full 8-zone control would need Windows Dynamic Lighting (keyboard firmware ≥ v1.02.00 per Razer's updater notes; today `lampArrayDeviceId: null`) or OpenRGB.

## Zone map hack — `bin\0002A3.dat` (stock copy: `test/fixtures/razer/0002A3.dat.orig`)

- The 3-group limit is just data: `C:\Program Files (x86)\Razer Chroma SDK\bin\<PID>.dat` maps each physical zone to a Chroma Link LED.
  Layout (25 B): `01 00 01 <n=08>`, then n × `<link LED> 00`, then trailer `00 01 02 1e 00`. Stock: `1 1 1 2 2 3 3 3`.
- Editing needs admin (done via the herdr `sudo` pane); the device module reloads it on `Restart-Service "Razer Chroma SDK Service","Razer Chroma SDK Server" -Force` (log: `Mapping loaded from data file`).
- Patched `0 1 2 3 4 1 2 3` → confirmed: all 5 Chroma Link LEDs (incl. 0 and 4) render, and any zone can take any LED.
- **Hard limit is 5 colors:** REST rejects longer arrays — `{"error":"expecting an array of 5 elements with integer values","result":87}`. A map of `0…7` leaves zones 5–7 dark.
- Expect Synapse updates to overwrite the file; the plugin should verify the map at startup and tell the user how to re-apply it.

## ✅ Chosen backend: HID frames + Chroma SDK session as a "Synapse mute" — `spikes/razer-hid.ts`

- Protocol from OpenRazer (`driver/razerkbd_driver.c`, `razerchromacommon.c`; daemon `MATRIX_DIMS = [1, 8]` for 0x02A3):
  - 90-byte Razer report as HID **feature report** (report id 0 → 91-byte buffer) on interface `MI_02`; transaction id `0x1F`; crc = XOR of bytes 2..87.
  - Frame: class `0x0F` cmd `0x03` size `0x47`, args `[0, 0, row=0, start=0, stop=7, R,G,B × 8]` (RGB order, not BGR).
  - Custom mode: class `0x0F` cmd `0x02` size `0x0C`, args `[0, 0, 0x08]` — send **once**, then stream frames only.
  - Status from `HidD_GetFeature` byte 1: 2 = ok, 3 = failed, 5 = not supported.
- Windows access via `bun:ffi` only (no native npm modules): `cfgmgr32!CM_Get_Device_Interface_ListW` (GUID_DEVINTERFACE_HID) → `CreateFileW` with **access 0** (keyboard/mouse collections are exclusive, feature reports still work) → `hid!HidD_SetFeature` / `HidD_GetFeature`. Feature report length checks out at 91.
- **Synapse repaints its profile every 2–5 s**, overwriting HID frames (random flicker). Holding a Chroma SDK REST session (`device_supported: ["keyboard", "chromalink"]`, heartbeat 1 s, nothing else sent) makes Synapse stand down → HID frames stick. Releasing the session (`DELETE`) hands the keyboard back and Synapse restores the user's profile.
- No `0002A3.dat` patching needed for this path (stock file restored).
- Net result: **8 independent zones**, frames are tiny (one 91-byte report), no dependency on Chroma Link mapping, clean handover via the SDK session.
