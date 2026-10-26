// Prints what the plugin's actions and commands do.
// Usage: herdr plugin action invoke qbikez.chroma.help
//        bun src/help.ts
console.log(`Chroma keyboard plugin (qbikez.chroma): shows herdr agent states on a Razer keyboard.

Actions (herdr plugin action invoke qbikez.chroma.<action>):
  open       Open the keyboard daemon pane (workspace)
  machine-1  This machine owns zones 0-3 (default)
  machine-2  This machine owns zones 4-7
  help       Show this help

Daemon:
  herdr plugin pane open --plugin qbikez.chroma --entrypoint daemon
  herdr plugin log list --plugin qbikez.chroma

Config (from the plugin folder, or bun <plugin dir>/src/configure.ts):
  bun src/configure.ts show
  bun src/configure.ts set <machine|hub|serve|hubToken|mqtt|mqttTopic> <value>
  bun src/configure.ts unset <key>

Config keys:
  machine   1 (zones 0-3) or 2 (zones 4-7)
  serve     host the sync hub on this port
  hub       join a hub, ws(s)://host:port/?token=...
  hubToken  token for serve (also read from HUB_TOKEN)
  mqtt      sync through an MQTT broker instead of a hub, mqtt(s)://user:pass@host:port
  mqttTopic topic prefix for mqtt (default herdr-chroma)
  strategy  status (default: one zone per status) or agent (first 3 agents get a zone each, the 4th summarises the rest)
  zoneLabels how the $chroma_zone token is written: emoji (default, 1️⃣), digits, letters, bar, dots, squares, pie, blocks, fill, braille, or the Nerd Font sets nf-* (see README)

Config changes apply when the daemon pane is reopened.`);
