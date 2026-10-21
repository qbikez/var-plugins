# herdr Chroma plugin — feature ideas

A herdr plugin that turns a Razer Chroma RGB keyboard into an at-a-glance dashboard for running AI agents.
herdr already tracks per-agent state (working / idle / waiting for approval / done / errored) and exposes it to plugins via its Unix socket JSON API.

## Core: keyboard as agent status

- **Pane status on the number row** — `1`–`9` map to herdr panes/tabs; each key's color reflects that agent's state:
  - working → slow blue breathing
  - needs approval → pulsing amber
  - done → solid green (fades after a while)
  - errored → red
  - idle → dim white

  The key you press to jump to a pane doubles as its status light.
- **Approval prompt highlighting** — when an agent asks for permission, light the approve/deny keys (e.g. `Y` green, `N` red) so you know what to press without reading the prompt.
- **Attention flash** — when any agent transitions working → needs-input, do a brief full-keyboard flash/ripple, then settle back to per-key status. Lets you look away while agents work.

## Activity & progress

- **Activity meter** — F-key row or spacebar strip as a bar showing how many agents are busy vs idle.
- **Output heartbeat** — flicker a pane's number key when its agent produces output; distinguishes "stuck" from "thinking".
- **Context / token gauge** — if herdr exposes context usage or cost, fill a key row green → red as the context window fills.
- **Long-task timer** — slow ripple once an agent has been working longer than N minutes.

## Navigation aids

- **Prefix-mode key highlighting** — after the herdr prefix is pressed, light only the keys that do something next (split, pane switch, kill…), dim the rest. A which-key overlay on the keyboard.
- **Focused pane indicator** — active pane's number key gets a white outline or brighter shade.

## Ambient / fun

- **Success wave** — rainbow sweep when an agent finishes with passing tests / exit code 0; red shock wave on failure.
- **Per-agent identity colors** — e.g. Claude orange, Codex green, Gemini blue, so the board also shows which tool runs where.
- **Quiet hours** — dim everything at night, keep only "needs approval" alerts.
- **Multi-device** — mirror "needs attention" to Chroma mouse / mousepad / headset for visibility from across the room.

## Implementation notes

- **Chroma REST API** — `http://localhost:54235/razer/chromasdk`: register a session, then `PUT` custom key grids. Language-agnostic (Rust, Bun/TS) with no native bindings. Requires a periodic heartbeat or the session times out.
- **Layered compositor** — base layer (status) → overlay (flashes, prefix mode) → priority alerts. Composite into a single 6×22 key matrix per frame at ~15–30 fps.
- **Config** — state → color mappings and pane → key layout in TOML/JSON, so it's not tied to one keyboard layout.
- **Clean exit** — release the Chroma session on herdr exit so Synapse restores the user's normal profile.

## MVP

1. Pane status on the number row
2. Attention flash on needs-input
3. Approve/deny key highlighting

These cover ~80% of the value. Before building, confirm herdr's plugin API (socket path, event schema) from its docs.

## References

- [herdr README](https://cdn.jsdelivr.net/gh/herdrdev/herdr@master/README.md)
- [Herdr review (bitdoze)](https://www.bitdoze.com/herdr-agent-multiplexer/)
- [herdr explained (mer.vin)](https://mer.vin/2026/07/herdr-explained-terminal-multiplexer-for-running-multiple-ai-coding-agents/)
- [herdr releases](https://github.com/aceitw/herdr/releases)
