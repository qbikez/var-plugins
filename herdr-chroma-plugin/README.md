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

CLI flags (`--machine`, `--serve`, `--hub`, `--dry-run`) override the file. A standalone hub for a server: `bun src/hub.ts --port 7777`.

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
