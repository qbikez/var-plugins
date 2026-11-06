# herdr-autostart-plugin

A [herdr](https://herdr.dev) plugin that starts a list of commands when herdr starts and stops them when herdr exits.
Useful for things like dev servers, sync daemons and tunnels.

Requires [Bun](https://bun.sh) on `PATH`.

```sh
herdr plugin install qbikez/var-plugins/herdr-autostart-plugin
# or, from this checkout:
herdr plugin link C:\git\hmdev\var-plugins\herdr-autostart-plugin
```

## Configure

Put the commands in `config.yaml` in the plugin config dir. `herdr plugin config-dir qbikez.autostart` prints where it
is. The `config` action prints the file, or an example if you haven't made one yet.

```yaml
commands:
  - name: hub                  # names the log file; defaults to the program name
    command: [bun, src/hub.ts] # argv list, run directly
    cwd: ~/src/hub             # defaults to your home directory
    restart: true              # start it again when it exits
  - name: docs
    command: npm run dev       # a string runs through the shell
    cwd: C:/git/docs
    env:
      PORT: 4000
  - name: tunnel
    command: [ssh, -N, -L, "5432:localhost:5432", db]
    enabled: false             # skipped
```

| field     | meaning                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `command` | an argv list (run directly; `.cmd` shims like `npm` work on Windows) or a string run by the shell (`cmd.exe` on Windows, `/bin/sh` elsewhere) |
| `name`    | names the log file and the status line; defaults to the program name                                      |
| `cwd`     | working directory, `~` is your home directory; defaults to home                                            |
| `env`     | extra environment variables                                                                                |
| `restart` | start it again when it exits (backs off up to 60s if it keeps dying); default `false`                     |
| `enabled` | `false` skips it; default `true`                                                                           |

Quote arguments that YAML would otherwise read specially, like ones containing `: ` or starting with `#`, `*`, `&`
or `{`. Changes apply on the next herdr start or with the `restart` action.

## How it works

The `[[startup]]` hook runs `src/cli.ts start`. It starts a detached supervisor (`src/supervisor.ts`), which starts
the commands and stays subscribed to herdr's event pipe. When herdr exits, the pipe closes and the supervisor
stops every command and everything they started. Starting again stops the previous supervisor first, so there is
only ever one set of commands running.

Logs and state live in the plugin state dir: `supervisor.log`, `logs/<name>.log` (the previous run's log is kept as
`<name>.log.1`) and `status.json`.

## Actions

```sh
herdr plugin action invoke qbikez.autostart.restart   # (re)start everything, re-reading config.yaml
herdr plugin action invoke qbikez.autostart.stop
herdr plugin action invoke qbikez.autostart.status
herdr plugin action invoke qbikez.autostart.log       # supervisor log; per-command logs: bun src/cli.ts log <name>
herdr plugin action invoke qbikez.autostart.config
```
