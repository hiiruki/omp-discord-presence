# omp-discord-presence

Discord Rich Presence extension for omp (oh-my-pi) coding agent.

Client ID is preconfigured as `1566329796068384808`.

Discord shows the project name, current state (idle / thinking / using tool), the active tool, and the model:

```text
omp · my-project
using tool · bash · anthropic/claude-opus-4
```

## Use locally

```bash
pnpm install
omp -e .
```

Or install this folder as an omp plugin:

```bash
omp install /path/to/omp-discord-presence
```

Then restart omp.

Only the main session talks to Discord; subagent sessions (task tool, eval agents) are ignored.

## Commands

Inside omp:

```text
/discord-presence          # toggle on/off globally
/discord-presence status
/discord-presence off
/discord-presence on
/discord-presence refresh
/discord-presence hide     # hide this project's name (alias: private)
/discord-presence show     # show this project's name again (alias: public)
```

`hide` replaces the project name with `private project` on Discord. It applies to the current directory and everything below it, so a session started in a subdirectory of a hidden project stays hidden. `show` removes every hidden entry that covers the current directory.

The on/off state and the hidden project list are global across omp projects and sessions, and changes apply live to every running session. They are stored at:

```text
~/.omp/agent/discord-presence-state.json
```

```json
{
  "enabled": true,
  "hiddenProjects": ["/home/me/work/secret-client"]
}
```

## WSL

Discord IPC uses a Unix socket (`$XDG_RUNTIME_DIR/discord-ipc-0`). Under WSL, Discord runs on Windows, so you need a relay that exposes the Windows named pipe `\\.\pipe\discord-ipc-0` as that socket (for example `socat` + `npiperelay`).

## Better Discord display

The activity name shown by Discord comes from the Discord Developer Portal application name. The extension cannot change that through RPC.

This repo includes omp logo assets:

- `assets/omp-logo.svg`
- `assets/omp-logo.png`

Upload `assets/omp-logo.png` to the Discord application's Rich Presence assets, then set the uploaded asset key with env vars:

```bash
export OMP_DISCORD_LARGE_IMAGE_KEY=omp-logo
export OMP_DISCORD_SMALL_IDLE_IMAGE_KEY=omp-logo
export OMP_DISCORD_SMALL_WORKING_IMAGE_KEY=omp-logo
```

You can override the app id too:

```bash
export OMP_DISCORD_CLIENT_ID=1566329796068384808
```
