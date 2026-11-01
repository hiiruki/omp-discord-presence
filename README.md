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

### Images

- **Large image:** the Discord application's own icon, fetched from Discord at startup.
- **Small image:** the logo of the model's maker (Claude, OpenAI, Gemini, DeepSeek, xAI, Mistral, Qwen, Moonshot, Zhipu, MiniMax, Meta), chosen from omp's active model. The plugin matches on the model id first, so Claude through OpenRouter or Copilot still shows the Claude logo. If that fails, it falls back to the provider (OpenRouter, GitHub Copilot, Ollama, Groq, Cerebras, Bedrock). Hover the logo to see the full model name. Unknown models show no small image. A model switch shows up when the next prompt starts.

The logos live in `assets/models/` (640×640 PNGs from [`@lobehub/icons-static-png`](https://www.npmjs.com/package/@lobehub/icons-static-png), MIT). Discord can't read local files, so upload them once as Art Assets:

1. Open the [Developer Portal](https://discord.com/developers/applications), select the app, then go to **Rich Presence → Art Assets**.
2. Click **Add Image(s)** and select every file in `assets/models/`.
3. Keep each asset name equal to its file name without `.png` (for example `anthropic`, `githubcopilot`), then **Save Changes**.

New assets can take a few minutes to appear. To add a brand, put `<key>.png` (at least 512×512) in `assets/models/`, add a `[/pattern/, "<key>"]` row to `BRAND_ICONS` in `extensions/discord-presence.ts`, and upload the image.

To use your own large image instead, upload one as an Art Asset (at least 512×512) and set its key, or use any image URL:

```bash
export OMP_DISCORD_LARGE_IMAGE_KEY=omp-logo
```

You can override the app id too:

```bash
export OMP_DISCORD_CLIENT_ID=1566329796068384808
```
