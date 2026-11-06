// Prints what the plugin's actions and commands do.
// Usage: herdr plugin action invoke qbikez.chroma.help
//        bun src/help.ts
console.log(`Chroma keyboard plugin (qbikez.chroma): shows herdr agent states on a Razer or Royal Kludge keyboard.

Actions (herdr plugin action invoke qbikez.chroma.<action>):
  restart    (Re)start the keyboard daemon in the background
  log        Show the background daemon's log file and its last lines
  open       Open the keyboard daemon in a pane, replacing the background one (workspace)
  machine-1  This machine owns zones 0-3 (default)
  machine-2  This machine owns zones 4-7
  help       Show this help

Daemon:
  Starts in the background with herdr (unless "autostart": false), logging to daemon.log in the plugin state dir.
  herdr plugin action invoke qbikez.chroma.log
  herdr plugin pane open --plugin qbikez.chroma --entrypoint daemon
  herdr plugin log list --plugin qbikez.chroma

Config (from the plugin folder, or bun <plugin dir>/src/configure.ts):
  bun src/configure.ts show
  bun src/configure.ts set <machine|device|hub|serve|hubToken|mqtt|mqttTopic> <value>
  bun src/configure.ts unset <key>

Config keys:
  machine   1 (zones 0-3) or 2 (zones 4-7)
  device    keyboard driver(s): razer-ornata and/or royal-kludge, comma-separated (default: all detected)
  serve     host the sync hub on this port
  hub       join a hub, ws(s)://host:port/?token=...
  hubToken  token for serve (also read from HUB_TOKEN)
  mqtt      sync through an MQTT broker instead of a hub, mqtt(s)://user:pass@host:port
  mqttTopic topic prefix for mqtt (default herdr-chroma)
  strategy  status (default: one zone per status) or agent (first 3 agents get a zone each, the 4th summarises the rest)
  zoneLabels how the $chroma_zone token is written: emoji (default, 1️⃣), digits, letters, bar, dots, squares, pie, blocks, fill, braille, or the Nerd Font sets nf-* (see README)
  spaceOrder agent strategy: order unpinned workspaces by number in their name (default) or herdr (as listed in herdr)
  grouping  agent strategy: agent (default, one zone per agent) or space (one zone per workspace, shared by its agents)
  zones     per-key keyboards: key names lit by each of the 8 zones, edited in config.json (see README)
  autostart true (default) or false: start the daemon in the background when herdr starts

Config changes apply when the daemon restarts (restart action).`);
