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
herdr plugin install qbikez/foundry/herdr-chroma-plugin
# pin a revision:
herdr plugin install qbikez/foundry/herdr-chroma-plugin --ref <tag-or-commit>
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

## Configuration

Optional `config.json` in the plugin config dir (`herdr plugin config-dir qbikez.chroma`):

```json
{ "machine": 2, "hub": "wss://example.com/?token=secret" }
```

| Key | Meaning |
| --- | --- |
| `machine` | `1` (zones 0–3, default) or `2` (zones 4–7) |
| `serve` | host the sync hub on this port |
| `hub` | join a hub, `ws(s)://host:port/?token=...` |
| `hubToken` | token for `serve` (also read from `HUB_TOKEN`) |

CLI flags (`--machine`, `--serve`, `--hub`, `--dry-run`) override the file. A standalone hub for a server: `bun src/hub.ts --port 7777`.

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
