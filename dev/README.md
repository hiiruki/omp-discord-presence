# omp-discord-presence

Discord Rich Presence extension for omp (oh-my-pi) coding agent.

Discord shows the project name, the current state (idle / thinking / using tool), the active tool, and the model, with the model maker's logo as a small badge:

```text
OH MY PI
omp · my-project
using tool · bash · anthropic/claude-opus-4
```

Works out of the box on Windows, macOS, Linux and WSL. No Discord setup, relay, or `socat` needed on the user's side.

## Requirements

- The Discord **desktop app** running on the same machine (the browser version has no Rich Presence).
- Discord → **Settings → Activity Privacy → Share your detected activities with others** turned on.

## Install

```bash
omp install omp-discord-presence
```

Restart omp and the status appears. On WSL the bundled bridge starts by itself. To uninstall, run `omp plugin uninstall omp-discord-presence`.

From a local checkout (development):

```bash
pnpm install
omp -e .                              # this session only
omp install /path/to/omp-discord-presence   # links the folder; edits apply after an omp restart
```

### Publishing (maintainer)

```bash
npm login
npm publish
```

The package ships only `extensions/`, `bin/` and `assets/`, about 0.9 MB. `@oh-my-pi/pi-coding-agent` is an optional peer, so installing the plugin doesn't pull a second copy of omp.

Only the main session talks to Discord; subagent sessions (task tool, eval agents) are ignored.

## Platform support

| Where omp runs | How it reaches Discord |
| --- | --- |
| Windows | Directly, via Discord's named pipe |
| macOS / Linux | Directly, via Discord's Unix socket |
| WSL (Discord on Windows) | Built-in bridge, nothing to install |

### WSL

Under WSL, Discord runs on Windows and only exposes the named pipe `\\.\pipe\discord-ipc-0`. Linux programs can't use that pipe, so the plugin bridges it itself:

1. On connect, it checks whether `$XDG_RUNTIME_DIR/discord-ipc-0` already answers. That happens when Linux Discord is running, you run your own `socat` relay, or another omp session already started the bridge. If it answers, the plugin uses it.
2. Otherwise it serves that socket itself and relays each connection through the bundled `bin/npiperelay.exe` ([npiperelay](https://github.com/jstarks/npiperelay) v0.1.0, MIT, see `bin/npiperelay.LICENSE`).
3. When the session that owns the bridge exits, other running sessions reconnect within 15 seconds and one of them takes over.

Requirements: WSL interop must be enabled (the default), and Discord must be the stable client. PTB and Canary use a different pipe and aren't bridged.

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

## Troubleshooting

- **`/discord-presence status` says "not connected":** check that the Discord desktop app is running and that activity sharing is on. The plugin retries every 15 seconds.
- **Status stays "not connected" right after restarting omp many times in a row:** Discord briefly stops answering when clients reconnect rapidly. Wait a minute.
- **Logo badge is blank:** that brand's Art Asset is missing from the Discord application (see below).

## Discord application (maintainer setup)

Users don't need any of this. Everything below lives in the Discord application whose ID the plugin uses (default `1566329796068384808`), so it applies to every user at once.

### Name

The activity title ("OH MY PI") is the application name in the Discord Developer Portal. RPC can't change it. After renaming, restart the Discord client so it drops the cached name.

### Images

- **Large image:** the application's own icon, fetched from Discord at startup.
- **Small image:** the logo of the model's maker (Claude, OpenAI, Gemini, DeepSeek, xAI, Mistral, Qwen, Moonshot, Zhipu, MiniMax, Meta), chosen from omp's active model. The plugin matches on the model id first, so Claude through OpenRouter or Copilot still shows the Claude logo. If that fails, it falls back to the provider (OpenRouter, GitHub Copilot, Ollama, Groq, Cerebras, Bedrock). Hover the logo to see the full model name. Unknown models show no small image. A model switch shows up when the next prompt starts.

The logos live in `assets/models/` (640×640 PNGs from [`@lobehub/icons-static-png`](https://www.npmjs.com/package/@lobehub/icons-static-png), MIT). Discord can't read local files, so upload them once as Art Assets:

1. Open the [Developer Portal](https://discord.com/developers/applications), select the app, then go to **Rich Presence → Art Assets**.
2. Click **Add Image(s)** and select every file in `assets/models/`.
3. Keep each asset name equal to its file name without `.png` (for example `claude`, `githubcopilot`), then **Save Changes**.

New assets can take a few minutes to appear. To add a brand, put `<key>.png` (at least 512×512) in `assets/models/`, add a `[/pattern/, "<key>"]` row to `BRAND_ICONS` in `extensions/discord-presence.ts`, and upload the image.

### Environment overrides

```bash
# Use your own Discord application (it needs its own Art Assets)
export OMP_DISCORD_CLIENT_ID=1566329796068384808
# Large image: an Art Asset key (at least 512×512) or any image URL
export OMP_DISCORD_LARGE_IMAGE_KEY=omp-logo
```
