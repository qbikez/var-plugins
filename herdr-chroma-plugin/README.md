# herdr-chroma

A [herdr](https://herdr.dev) plugin that shows your agents' states on a Razer keyboard.

Each machine owns four lighting zones, left to right: **blocked** (amber), **working** (blue), **done** (green), **idle** (purple).
A zone's brightness is the share of that machine's agents in that state. Two machines sharing one keyboard through a KVM can sync through a websocket hub (zones 0–3 and 4–7).

## Requirements

- Windows
- Razer Ornata V3 TKL (VID `0x1532`, PID `0x02A3` are hardcoded) with Razer Synapse 4
- herdr 0.9.3 or newer
- [Bun](https://bun.sh) on `PATH`

## Install

```sh
herdr plugin install qbikez/var-plugins/herdr-chroma-plugin
# pin a revision:
herdr plugin install qbikez/var-plugins/herdr-chroma-plugin --ref <tag-or-commit>
```

Update with `herdr plugin update qbikez.chroma`. Plugins run unsandboxed with your user's permissions, so read the source before installing.

## Use

Open the daemon pane (it opens in its own tab) and leave it running:

```sh
herdr plugin pane open --plugin qbikez.chroma --entrypoint daemon
```

Or run the `qbikez.chroma.open` action, and bind it to a key in your herdr config:

```toml
[[keys.command]]
key = "prefix+k"
type = "plugin_action"
command = "qbikez.chroma.open"
description = "chroma keyboard"
```

Logs: `herdr plugin log list --plugin qbikez.chroma`.

Help: `herdr plugin action invoke qbikez.chroma.help` lists the actions and config commands.

## Configuration

Set which machine this is (1 = zones 0–3, 2 = zones 4–7), then reopen the daemon pane:

```sh
herdr plugin action invoke qbikez.chroma.machine-2
```

Other settings, from a shell inside the plugin folder or via `bun <plugin dir>/src/configure.ts`:

```sh
bun src/configure.ts set hub "wss://example.com/?token=secret"
bun src/configure.ts show
```

Both write `config.json` in the plugin config dir (`herdr plugin config-dir qbikez.chroma`), which you can also edit by hand:

```json
{ "machine": 2, "hub": "wss://example.com/?token=secret" }
```

| Key | Meaning |
| --- | --- |
| `machine` | `1` (zones 0–3, default) or `2` (zones 4–7) |
| `serve` | host the sync hub on this port |
| `hub` | join a hub, `ws(s)://host:port/?token=...` |
| `hubToken` | token for `serve` (also read from `HUB_TOKEN`) |
| `mqtt` | sync through an MQTT broker instead of a hub, `mqtt(s)://user:pass@host:port` |
| `mqttTopic` | topic prefix for `mqtt` (default `herdr-chroma`) |
| `strategy` | `status` (default) or `agent`, also `--strategy` |

### Strategies

- `status`: each of a machine's 4 zones is a status indicator (blocked, working, done, idle), brighter the more agents share it.
- `agent`: the first 3 zones are one per agent and the 4th summarises the rest, ignoring idle agents unless all are idle. One non-idle status shows its own colour; a mix shows magenta. A workspace whose name contains `z0`–`z2` pins its agents to that zone (0-based, within the machine's zones); several agents in one pinned zone are summarised the same way. The remaining agents fill the free zones ordered by the first number in their workspace name (workspaces without a number come last, in pane order).

With the `agent` strategy the daemon also reports a `chroma_zone` metadata token to herdr for every agent pane (a keycap emoji, e.g. 1️⃣) and workspace (e.g. 1️⃣, or 0️⃣3️⃣ when its agents span several zones; 3️⃣ is the summary zone). Zone numbers are local to the machine. Render it in your herdr config, e.g.:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "$chroma_zone", "workspace", "tab"], ["agent"]]
[ui.sidebar.spaces]
rows = [["state_icon", "workspace", "$chroma_zone"], ["branch", "git_status"]]
```

Tokens are cleared on shutdown.

How the zone is written is set by `zoneLabels` (or `--zone-labels`):

| `zoneLabels` | zone 0 … 3 | a workspace spanning zones 0 and 3 |
|---|---|---|
| `emoji` (default) | 0️⃣ 1️⃣ 2️⃣ 3️⃣ | 0️⃣3️⃣ |
| `digits` | `0` `1` `2` `3` | `0,3` |
| `letters` | `A` `B` `C` `D` | `A,D` |
| `bar` | `#---` `-#--` `--#-` `---#` | `#--#` |
| `dots` | ●○○○ ○●○○ ○○●○ ○○○● | ●○○● |
| `squares` | ■□□□ □■□□ □□■□ □□□■ | ■□□■ |
| `pie` | ◔ ◑ ◕ ● | ◔● |
| `blocks` | ▂ ▄ ▆ █ | ▂█ |
| `fill` | ▎ ▌ ▊ █ | ▎█ |
| `braille` | ⠁ ⠂ ⠄ ⡀ | ⡁ (one cell, a dot per zone) |

Nerd Font sets (Nerd Fonts v3 or newer, Material Design icons; a workspace spanning several zones shows each glyph, space-separated):

| `zoneLabels` | zone 0 … 3 | glyphs |
|---|---|---|
| `nf-box` | 󰎡 󰎤 󰎧 󰎪 | `numeric_0..3_box` |
| `nf-circle` | 󰲞 󰲠 󰲢 󰲤 | `numeric_0..3_circle` |
| `nf-letters` | 󰬈 󰬉 󰬊 󰬋 | `alpha_a..d_box` |
| `nf-dice` | 󰇊 󰇋 󰇌 󰇍 | `dice_1..4` (faces 1–4 for zones 0–3) |
| `nf-pie` | 󰪟 󰪡 󰪣 󰪥 | `circle_slice_2,4,6,8` (a quarter up to full) |
| `nf-battery` | 󰁼 󰁾 󰂀 󰂂 | `battery_30,50,70,90` |

`pie`, `blocks` and `fill` grow with the zone number, so they read as position left to right but not as a set of zones; the strips (`bar`, `dots`, `squares`) and `braille` show exactly which zones a workspace spans. The non-ASCII sets need a font with the Unicode block and geometric-shape glyphs (braille especially).

### MQTT sync

Instead of a hub, every instance can publish its state to an MQTT broker and listen to the others. Each machine writes its agent statuses as a retained message on `<mqttTopic>/<machine-1>` (so `herdr-chroma/0` and `herdr-chroma/1`) and subscribes to `<mqttTopic>/+`, which rebuilds the full state, including after a restart. A last-will clears a machine's slot when it disconnects. Set `mqtt` on every machine, with a different `machine` on each; `mqtt` takes precedence over `hub`/`serve`.

```sh
bun src/configure.ts set mqtt "mqtts://user:pass@broker.example.com:8883"
```

CLI flags (`--machine`, `--serve`, `--hub`, `--mqtt`, `--mqtt-topic`, `--dry-run`) override the file. A standalone hub for a server: `bun src/hub.ts --port 7777`.

## Syncing two machines

1. Start a hub. Either run a standalone one on a server, with the token in the environment:

   ```sh
   HUB_TOKEN=secret bun src/hub.ts --port 7777
   ```

   or let one of the machines host it by setting `serve` (and optionally `hubToken`) in its config.
2. On each machine, point the plugin at the hub. The token must match the hub's:

   ```sh
   bun src/configure.ts set hub "wss://your-host:7777/?token=secret"
   ```

   Use `ws://` instead of `wss://` if there is no TLS proxy in front of the hub.
3. Give each machine its own number, `qbikez.chroma.machine-1` or `qbikez.chroma.machine-2` (see above), so they light different zones.
4. Reopen the daemon pane on each machine.

## Limitations

- The daemon stops if herdr closes its event pipe; reopen the pane after restarting herdr.
- Windows and one keyboard model only.

## Development

```sh
herdr plugin link .
bun start:dry   # inside a herdr pane: prints frames instead of lighting the keyboard
```

## License

MIT
