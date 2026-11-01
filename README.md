# omp-discord-presence

Discord Rich Presence extension for omp (oh-my-pi) coding agent.

Discord shows the installed omp version, the project name, any active omp mode (plan, goal, loop, vibe), the current state (idle / thinking / using tool), the active tool, the model and its effort (thinking level), with the model maker's logo as a small badge:

```text
OH MY PI
omp v18.15.0 · my-project · plan mode
using tool · bash · anthropic/claude-opus-4 · effort: high
[ View on GitHub ]
```

Status changes reach Discord within about 4 seconds. Updates are spaced out because Discord accepts only 5 activity updates per 20 seconds, and the latest state is always sent last. While tools run in parallel, the status stays on "using tool" until the last one finishes. Automatic context compaction and provider retries get their own status (`compacting context`, `retrying · attempt 2/5`). The retry's error message is never shown. The model and effort follow the selection in the omp session: a switch (`/model`, the model picker, ⇧⇥ for effort) shows within a few seconds, even without a prompt.

Active modes are joined with `+`, and paused modes get `(paused)`, e.g. `plan mode + goal mode (paused)`. Only the mode name is shown: the goal objective and the plan file path stay private.

After 15 minutes without a prompt (configurable in `/discord-presence settings`, or never), `idle` turns into `away`. The next prompt switches it back to `thinking`.

Context-window usage can be shown at the end of the status (`… · effort: high · context 42%`). It is **off by default**. Turn it on in `/discord-presence settings` or with `/discord-presence context on`. The value updates after every turn.

While subagents (task tool, eval agents) are working, the status shows how many are running, e.g. `using tool · wait · 2 subagents · …`. Nested subagents are included. The count drops as each one finishes.

When omp is blocked on you, the status says so instead of `thinking`:

- `waiting for approval · bash`: a tool call needs your approval. This only happens when `tools.approvalMode` prompts, e.g. `always-ask` or `write`. The approval reason is not shown, because it can quote the command.
- `waiting for your answer`: the `ask` tool is open.
- `waiting for plan review`: the plan-mode review is open.

Waiting never turns into `away`.

### GitHub button

When the project is a git repository whose `origin` remote points to a **public** GitHub repo, the status gets a **View on GitHub** button linking to it.

- **When there's no button:** non-GitHub remotes, private repos and folders without git get none. Visibility is checked once per session with an anonymous GitHub API request, so a private repo's owner/name is never published.
- **Hidden projects:** `/discord-presence hide` removes the button too.
- **Your own view:** Discord never shows your own activity buttons to you. Other people see them on your profile.

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

The package ships only `extensions/`, `bin/` and `assets/`, about 1.9 MB. `@oh-my-pi/pi-coding-agent` is an optional peer, so installing the plugin doesn't pull a second copy of omp.

Only the main session talks to Discord; subagent sessions (task tool, eval agents) never connect and only report how many of them are running.

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

## How it works

### Overview

```mermaid
flowchart TD
    subgraph omp["omp session"]
        E1["session_start"]
        E2["agent_start / agent_end"]
        E3["tool_execution_start / end"]
        E8["tool_approval / plan_review<br/>requested / resolved"]
        E6["auto_compaction / auto_retry<br/>start / end"]
        E7["mode_changed<br/>(plan / goal / loop / vibe)"]
        E4["/discord-presence command"]
        E5["session_shutdown"]
    end

    subgraph plugin["discord-presence plugin (main session only)"]
        P["presence state<br/>status · tool · model · start time"]
        S[("~/.omp/agent/<br/>discord-presence-state.json<br/>enabled · hiddenProjects")]
        T["throttle<br/>0.75 s debounce, 4 s spacing"]
        B["build activity"]
    end

    subgraph inputs["read when building"]
        V["omp version"]
        M["live model + effort<br/>(polled every 3 s)"]
        L["lobe-icons logo key"]
        G["public GitHub URL<br/>(git origin + GitHub API)"]
    end

    E1 & E2 & E3 & E6 & E7 & E8 --> P
    E4 -- "on / off / hide / show" --> S
    S -- "file watcher<br/>(all sessions)" --> P
    P --> T --> B
    V & M & L & G --> B
    B -- "SET_ACTIVITY" --> RPC["discord-rpc client"]
    RPC --> D["Discord desktop app"]
    E5 -- "clear activity, close bridge" --> RPC
```

Subagent sessions (task tool, eval agents) also load the plugin, but they never connect, so they can't overwrite or clear the main session's status. They run in the same process and share the plugin module. Each one bumps a shared counter while its agent loop runs, and the main session shows that count.

### Connecting to Discord

```mermaid
flowchart TD
    C["connect()"] --> Q{"does $XDG_RUNTIME_DIR/discord-ipc-0<br/>answer?"}
    Q -- "yes: Linux Discord, socat,<br/>or another omp session" --> R["discord-rpc login"]
    Q -- "no" --> W{"running in WSL?"}
    W -- "no: Windows / macOS / Linux" --> R
    W -- "yes" --> BR["remove stale socket,<br/>serve discord-ipc-0"]
    BR --> R
    BR -. "each connection" .-> NP["bin/npiperelay.exe"]
    NP -. "\\.\pipe\discord-ipc-0" .-> DW["Discord on Windows"]
    R -- "READY" --> OK["connected: send activity"]
    R -- "error / timeout" --> RT["close client,<br/>retry in 15 s"]
    OK -- "disconnected" --> RT
    RT --> C
```

If the session that owns the WSL bridge exits, the other sessions lose their connection, retry, and one of them starts a new bridge.

### Status states

```mermaid
stateDiagram-v2
    [*] --> offline: plugin loaded
    offline --> idle: session_start
    idle --> working: agent_start
    working --> tool: tool_execution_start
    tool --> tool: another tool starts / ends<br/>while one is still running
    tool --> working: last running tool ends
    working --> idle: agent_end
    tool --> idle: agent_end
    working --> retrying: auto_retry_start
    retrying --> working: auto_retry_end
    idle --> away: no prompt for the away time<br/>(15 min by default)
    away --> working: agent_start
    tool --> waiting: approval requested,<br/>or the ask tool runs
    waiting --> tool: approval resolved
    waiting --> working: ask answered
    working --> waiting: plan review opened
    waiting --> idle: plan review closed
    idle --> compacting: auto_compaction_start
    working --> compacting: auto_compaction_start
    tool --> compacting: auto_compaction_start
    compacting --> idle: auto_compaction_end<br/>(agent not running)
    compacting --> working: auto_compaction_end<br/>(agent running)
    compacting --> tool: auto_compaction_end<br/>(a tool is still running)
```

| Status | Text on Discord |
| --- | --- |
| `offline` | starting |
| `idle` | idle |
| `away` | away (idle for the away time, 15 minutes by default) |
| `working` | thinking |
| `tool` | using tool · `<tool name>` |
| `waiting` | waiting for approval · `<tool>` / your answer / plan review |
| `compacting` | compacting context |
| `retrying` | retrying · attempt `<n>/<max>` |

## Commands

Inside omp:

```text
/discord-presence settings # interactive settings menu
/discord-presence          # toggle on/off globally
/discord-presence status
/discord-presence off
/discord-presence on
/discord-presence refresh
/discord-presence hide     # hide this project's name (alias: private)
/discord-presence show     # show this project's name again (alias: public)
/discord-presence context on|off   # show context-window usage (off by default)
```

### Settings menu

`/discord-presence settings` opens a menu in the omp TUI. Press Enter on a row to change it; the menu stays open, so several settings can be changed in a row. Esc or **Done** closes it.

```text
╭─ Discord presence settings ─────────────────────────╮
│  ❯ Presence: on                                     │
│      Show omp activity on Discord (all sessions)    │
│    This project: visible                            │
│    Model, effort & logo: shown                      │
│    GitHub button: shown                             │
│    Context usage: hidden                            │
│    Away after: 15 min                               │
│    Done                                             │
╰─────────────────────────────────────────────────────╯
```

| Setting | Default | Effect |
| --- | --- | --- |
| Presence | on | Show omp activity on Discord, for every session. |
| This project | visible | Show the folder name, or `private project` (same as `hide` / `show`). |
| Model, effort & logo | shown | When hidden, the model, its effort and the model logo are left out; the logo would reveal the model's maker. |
| GitHub button | shown | The **View on GitHub** button for public repos. |
| Context usage | hidden | Append `context N%`. |
| Away after | 15 min | Idle time before `away`: 5, 10, 15, 30 or 60 minutes, or never. |

Every change is saved globally and applied live to all running sessions. Outside the TUI (print, RPC), `settings` points to the settings file instead.

### Status report

`status` shows exactly what Discord receives, and why parts may be missing:

```text
Discord presence: enabled · connected (WSL bridge started by this session)
App: OH MY PI (1566329796068384808)

Sent to Discord:
  omp v18.15.0 · omp-discord-presence
  idle · anthropic/claude-opus-5-5 · effort: high
  logo: claude ✓ uploaded
  button: View on GitHub → https://github.com/hiiruki/omp-discord-presence
  last update 9s ago

Project: omp-discord-presence · visible
Context: hidden (now 2%) · idle 10s, away in 14m 50s
Settings: /home/me/.omp/agent/discord-presence-state.json
```

- **Connection:** direct IPC, the WSL bridge, or a socket another omp session or relay already serves.
- **Logo:** checked against the application's public Art Asset list. `✗ not uploaded` means the key is missing in the Developer Portal.
- **Button:** the GitHub URL, or why there is none (project hidden, no git origin, not on GitHub, private repo, GitHub API unreachable).
- **Away timer:** how long the session has been idle and when it turns `away`.
- **Private data:** goal objectives, plan paths, retry errors and the hidden-project list are never shown.

### Hidden projects and storage

`hide` replaces the project name with `private project` on Discord. It applies to the current directory and everything below it, so a session started in a subdirectory of a hidden project stays hidden. `show` removes every hidden entry that covers the current directory.

All settings and the hidden project list are global across omp projects and sessions, and changes apply live to every running session. They are stored at:

```text
~/.omp/agent/discord-presence-state.json
```

```json
{
  "enabled": true,
  "hiddenProjects": ["/home/me/work/secret-client"],
  "showContext": false,
  "showModel": true,
  "showButton": true,
  "awayMinutes": 15
}
```

## Troubleshooting

- **`/discord-presence status` says "not connected":** check that the Discord desktop app is running and that activity sharing is on. The plugin retries every 15 seconds.
- **Status stays "not connected" right after restarting omp many times in a row:** Discord briefly stops answering when clients reconnect rapidly. Wait a minute.
- **Logo badge is blank:** run `/discord-presence status`. `logo: … ✗ not uploaded` means that Art Asset is missing from the Discord application (see below). `logo: none` means no lobe-icons rule matches the model.

## Discord application (maintainer setup)

Users don't need any of this. Everything below lives in the Discord application whose ID the plugin uses (default `1566329796068384808`), so it applies to every user at once.

### Name

The activity title ("OH MY PI") is the application name in the Discord Developer Portal. RPC can't change it. After renaming, restart the Discord client so it drops the cached name.

### Images

- **Large image:** the application's own icon, fetched from Discord at startup.
- **Small image:** the logo for the model selected in the omp session, from [lobe-icons](https://github.com/lobehub/lobe-icons). The plugin uses lobe's own model rules (`modelMappings`) in lobe's order, matched against the model id, so Claude through OpenRouter, Copilot or a gateway still shows the Claude logo. If no model rule matches, lobe's provider rules (`providerMappings`) are tried. Hover the logo to see the model and effort. Models without a logo show no small image.

The logos live in `assets/models/` (PNGs from [`@lobehub/icons-static-png`](https://www.npmjs.com/package/@lobehub/icons-static-png), MIT; the colored variant when lobe has one). Discord can't read local files, so upload them as Art Assets:

1. Open the [Developer Portal](https://discord.com/developers/applications), select the app, then go to **Rich Presence → Art Assets**.
2. Click **Add Image(s)** and select the files listed by the sync script below (the first time: every file in `assets/models/`).
3. Keep each asset name equal to its file name without `.png` (for example `claude`, `deepseek`), then **Save Changes**. New assets can take a few minutes to appear.

#### Supported logos

<!-- model-icons:start -->
<!-- Generated by scripts/sync-model-icons.ts; run `pnpm sync-icons` instead of editing. -->

156 logos from `@lobehub/icons@6.13.0`. They cover 5309 of the 5949 models in omp's bundled catalog.

**Matched against the model id** (first matching rule in lobe's order wins; keywords are case-insensitive regexes):

| Logo | Key | Model id contains | omp catalog models |
| --- | --- | --- | --- |
| <img src="assets/models/openai.png" width="20" height="20" alt=""> | `openai` | `gpt-3`, `gpt-4`, `gpt-5`, `gpt-oss`, `o1-`, `^o1`, `/o1`, `o3-`, `^o3`, `/o3`, `o4-`, `^o4`, `/o4`, `text-embedding-`, `tts-`, `whisper-`, `codex`, `davinci`, `babbage`, `omni-moderation`, `text-moderation`, `text-adb`, `text-ada`, `computer-use`, `^gpt-`, `/gpt-`, `openai` | 879 |
| <img src="assets/models/sora.png" width="20" height="20" alt=""> | `sora` | `sora` | 1 |
| <img src="assets/models/dalle.png" width="20" height="20" alt=""> | `dalle` | `dalle`, `dall-e` | 0 |
| <img src="assets/models/glmv.png" width="20" height="20" alt=""> | `glmv` | `^glm-(.*)v`, `/glm-(.*)v`, `-glm-(.*)v` | 41 |
| <img src="assets/models/zai.png" width="20" height="20" alt=""> | `zai` | `^glm-5`, `/glm-5`, `/glm5`, `-glm-4`, `^glm-4`, `/glm-4`, `/glm4`, `-glm-5` | 316 |
| <img src="assets/models/chatglm.png" width="20" height="20" alt=""> | `chatglm` | `^glm-`, `/glm-`, `chatglm`, `-glm-` | 12 |
| <img src="assets/models/codegeex.png" width="20" height="20" alt=""> | `codegeex` | `^codegeex`, `/codegeex` | 0 |
| <img src="assets/models/claude.png" width="20" height="20" alt=""> | `claude` | `claude` | 550 |
| <img src="assets/models/anthropic.png" width="20" height="20" alt=""> | `anthropic` | `anthropic` | 0 |
| <img src="assets/models/aws.png" width="20" height="20" alt=""> | `aws` | `titan` | 0 |
| <img src="assets/models/fireworks.png" width="20" height="20" alt=""> | `fireworks` | `accounts/fireworks/models/fire` | 0 |
| <img src="assets/models/internlm.png" width="20" height="20" alt=""> | `internlm` | `internlm`, `internvl` | 1 |
| <img src="assets/models/nousresearch.png" width="20" height="20" alt=""> | `nousresearch` | `deephermes`, `hermes`, `genstruct`, `minos` | 19 |
| <img src="assets/models/nvidia.png" width="20" height="20" alt=""> | `nvidia` | `nemotron`, `openreasoning`, `nemoretriever`, `neva-`, `nv-` | 170 |
| <img src="assets/models/meta.png" width="20" height="20" alt=""> | `meta` | `llama`, `/l3` | 193 |
| <img src="assets/models/llava.png" width="20" height="20" alt=""> | `llava` | `llava` | 0 |
| <img src="assets/models/nanobanana.png" width="20" height="20" alt=""> | `nanobanana` | `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`, `gemini-\d+(?:\.\d+)?-(?:flash(?:-lite)?\|pro)-image(?:-preview)?(?::\|$)`, `nanobanana`, `nano-banana` | 27 |
| <img src="assets/models/gemini.png" width="20" height="20" alt=""> | `gemini` | `gemini` | 277 |
| <img src="assets/models/deepmind.png" width="20" height="20" alt=""> | `deepmind` | `^imagen-`, `/imagen-`, `^imagen\d/`, `/imagen\d` | 0 |
| <img src="assets/models/gemma.png" width="20" height="20" alt=""> | `gemma` | `gemma` | 197 |
| <img src="assets/models/moonshot.png" width="20" height="20" alt=""> | `moonshot` | `kimi`, `moonshot` | 189 |
| <img src="assets/models/qiniu.png" width="20" height="20" alt=""> | `qiniu` | `qiniu` | 0 |
| <img src="assets/models/qwen.png" width="20" height="20" alt=""> | `qwen` | `qwen`, `qwq`, `qvq`, `wanx`, `wan\d/`, `wan\d\.\d-`, `tongyi`, `gte-rerank` | 657 |
| <img src="assets/models/minimax.png" width="20" height="20" alt=""> | `minimax` | `minimax`, `abab`, `^image-` | 186 |
| <img src="assets/models/mistral.png" width="20" height="20" alt=""> | `mistral` | `mistral`, `mixtral`, `codestral`, `mathstral`, `/mn-`, `pixtral`, `ministral`, `magistral`, `devstral`, `voxtral` | 213 |
| <img src="assets/models/perplexity.png" width="20" height="20" alt=""> | `perplexity` | `pplx`, `sonar` | 21 |
| <img src="assets/models/yi.png" width="20" height="20" alt=""> | `yi` | `^yi-`, `/yi-`, `-yi-` | 4 |
| <img src="assets/models/openrouter.png" width="20" height="20" alt=""> | `openrouter` | `^openrouter` | 19 |
| <img src="assets/models/relace.png" width="20" height="20" alt=""> | `relace` | `^relace-`, `/relace-` | 3 |
| <img src="assets/models/arcee.png" width="20" height="20" alt=""> | `arcee` | `^trinity-`, `/trinity-`, `afm-4.5b`, `caller-large`, `spotlight`, `maestro-reasoning`, `virtuoso-medium-v2`, `virtuoso-large`, `coder-large`, `arcee-blitz` | 23 |
| <img src="assets/models/essentialai.png" width="20" height="20" alt=""> | `essentialai` | `^rnj-`, `/rnj-` | 5 |
| <img src="assets/models/deepcogito.png" width="20" height="20" alt=""> | `deepcogito` | `^deepcogito-`, `/deepcogito-`, `^cogito-`, `/cogito-` | 3 |
| <img src="assets/models/morph.png" width="20" height="20" alt=""> | `morph` | `^morph-`, `/morph-` | 3 |
| <img src="assets/models/ai2.png" width="20" height="20" alt=""> | `ai2` | `^olmo-`, `/olmo-` | 10 |
| <img src="assets/models/inception.png" width="20" height="20" alt=""> | `inception` | `^mercury`, `/mercury` | 28 |
| <img src="assets/models/openchat.png" width="20" height="20" alt=""> | `openchat` | `^openchat` | 0 |
| <img src="assets/models/aya.png" width="20" height="20" alt=""> | `aya` | `aya` | 0 |
| <img src="assets/models/cohere.png" width="20" height="20" alt=""> | `cohere` | `command` | 16 |
| <img src="assets/models/dbrx.png" width="20" height="20" alt=""> | `dbrx` | `dbrx` | 1 |
| <img src="assets/models/stepfun.png" width="20" height="20" alt=""> | `stepfun` | `step` | 47 |
| <img src="assets/models/aimass.png" width="20" height="20" alt=""> | `aimass` | `taichu` | 0 |
| <img src="assets/models/ai360.png" width="20" height="20" alt=""> | `ai360` | `360gpt`, `360zhinao` | 0 |
| <img src="assets/models/baichuan.png" width="20" height="20" alt=""> | `baichuan` | `baichuan` | 4 |
| <img src="assets/models/rwkv.png" width="20" height="20" alt=""> | `rwkv` | `rwkv`, `/eagle-` | 0 |
| <img src="assets/models/wenxin.png" width="20" height="20" alt=""> | `wenxin` | `ernie`, `irag` | 35 |
| <img src="assets/models/jina.png" width="20" height="20" alt=""> | `jina` | `^jina`, `/jina` | 1 |
| <img src="assets/models/jimeng.png" width="20" height="20" alt=""> | `jimeng` | `^jimeng-`, `/jimeng-`, `seedream`, `seededit`, `seedance-` | 21 |
| <img src="assets/models/doubao.png" width="20" height="20" alt=""> | `doubao` | `^ep-`, `doubao-` | 32 |
| <img src="assets/models/kling.png" width="20" height="20" alt=""> | `kling` | `^kling`, `kling-`, `klingai` | 19 |
| <img src="assets/models/hunyuan.png" width="20" height="20" alt=""> | `hunyuan` | `hunyuan`, `hy3`, `hy4` | 37 |
| <img src="assets/models/fishaudio.png" width="20" height="20" alt=""> | `fishaudio` | `^d_`, `^g_`, `^wd_` | 0 |
| <img src="assets/models/bytedance.png" width="20" height="20" alt=""> | `bytedance` | `skylark`, `seed-`, `bytedance` | 34 |
| <img src="assets/models/burncloud.png" width="20" height="20" alt=""> | `burncloud` | `burncloud` | 0 |
| <img src="assets/models/stability.png" width="20" height="20" alt=""> | `stability` | `stable-diffusion`, `stable-video`, `stable-cascade`, `sdxl`, `stablelm`, `^stable-`, `^sd3`, `^sd2`, `^sd1` | 2 |
| <img src="assets/models/flux.png" width="20" height="20" alt=""> | `flux` | `flux` | 12 |
| <img src="assets/models/suno.png" width="20" height="20" alt=""> | `suno` | `suno` | 0 |
| <img src="assets/models/microsoft.png" width="20" height="20" alt=""> | `microsoft` | `wizardlm`, `/phi-`, `^phi-`, `-phi-`, `mai-`, `microsoft` | 31 |
| <img src="assets/models/adobe.png" width="20" height="20" alt=""> | `adobe` | `firefly` | 0 |
| <img src="assets/models/ai21.png" width="20" height="20" alt=""> | `ai21` | `jamba`, `^j2-`, `ai21` | 9 |
| <img src="assets/models/upstage.png" width="20" height="20" alt=""> | `upstage` | `^solar-`, `/solar` | 17 |
| <img src="assets/models/palm.png" width="20" height="20" alt=""> | `palm` | `palm` | 11 |
| <img src="assets/models/sensenova.png" width="20" height="20" alt=""> | `sensenova` | `SenseChat`, `SenseNova` | 0 |
| <img src="assets/models/grok.png" width="20" height="20" alt=""> | `grok` | `^grok-`, `/grok-` | 212 |
| <img src="assets/models/ideogram.png" width="20" height="20" alt=""> | `ideogram` | `ideogram`, `^v_1`, `^v_2`, `^v3$`, `^upscale$`, `^describe$` | 0 |
| <img src="assets/models/muse.png" width="20" height="20" alt=""> | `muse` | `(^\|/)muse-(spark\|wonder\|image\|video)($\|-)` | 75 |
| <img src="assets/models/spark.png" width="20" height="20" alt=""> | `spark` | `spark`, `general$`, `generalv3$`, `generalv3.5$`, `4.0ultra$`, `pro-128k$`, `^max-32k$`, `^lite$`, `^x1$` | 2 |
| <img src="assets/models/udio.png" width="20" height="20" alt=""> | `udio` | `udio` | 5 |
| <img src="assets/models/unionalpha.png" width="20" height="20" alt=""> | `unionalpha` | `union-alpha`, `unionalpha`, `pareto` | 15 |
| <img src="assets/models/deepseek.png" width="20" height="20" alt=""> | `deepseek` | `deepseek` | 281 |
| <img src="assets/models/voyage.png" width="20" height="20" alt=""> | `voyage` | `voyage` | 16 |
| <img src="assets/models/assemblyai.png" width="20" height="20" alt=""> | `assemblyai` | `assemblyai` | 0 |
| <img src="assets/models/liquid.png" width="20" height="20" alt=""> | `liquid` | `liquid`, `lfm` | 19 |
| <img src="assets/models/inflection.png" width="20" height="20" alt=""> | `inflection` | `inflection-` | 4 |
| <img src="assets/models/aionlabs.png" width="20" height="20" alt=""> | `aionlabs` | `aion-` | 26 |
| <img src="assets/models/aihubmix.png" width="20" height="20" alt=""> | `aihubmix` | `aihubmix` | 0 |
| <img src="assets/models/v0.png" width="20" height="20" alt=""> | `v0` | `^v0-` | 3 |
| <img src="assets/models/vertexai.png" width="20" height="20" alt=""> | `vertexai` | `^veo-`, `/veo-`, `^veo3` | 3 |
| <img src="assets/models/google.png" width="20" height="20" alt=""> | `google` | `google`, `learnlm`, `nano-banana` | 5 |
| <img src="assets/models/cogview.png" width="20" height="20" alt=""> | `cogview` | `cogview` | 0 |
| <img src="assets/models/kolors.png" width="20" height="20" alt=""> | `kolors` | `kolors` | 0 |
| <img src="assets/models/baiducloud.png" width="20" height="20" alt=""> | `baiducloud` | `baidu`, `qianfan` | 5 |
| <img src="assets/models/phind.png" width="20" height="20" alt=""> | `phind` | `phind` | 0 |
| <img src="assets/models/dolphin.png" width="20" height="20" alt=""> | `dolphin` | `dolphin` | 0 |
| <img src="assets/models/ibm.png" width="20" height="20" alt=""> | `ibm` | `ibm`, `granite` | 15 |
| <img src="assets/models/skywork.png" width="20" height="20" alt=""> | `skywork` | `skywork` | 0 |
| <img src="assets/models/bilibiliindex.png" width="20" height="20" alt=""> | `bilibiliindex` | `bilibili-index`, `index-tts` | 0 |
| <img src="assets/models/bilibili.png" width="20" height="20" alt=""> | `bilibili` | `bilibili` | 0 |
| <img src="assets/models/lg.png" width="20" height="20" alt=""> | `lg` | `kmmlu`, `exaone`, `lgai` | 0 |
| <img src="assets/models/tii.png" width="20" height="20" alt=""> | `tii` | `falcon` | 1 |
| <img src="assets/models/menlo.png" width="20" height="20" alt=""> | `menlo` | `menlo`, `lucy`, `jan-nano` | 0 |
| <img src="assets/models/longcat.png" width="20" height="20" alt=""> | `longcat` | `longcat` | 20 |
| <img src="assets/models/kwaipilot.png" width="20" height="20" alt=""> | `kwaipilot` | `kat-` | 24 |
| <img src="assets/models/nova.png" width="20" height="20" alt=""> | `nova` | `^nova-`, `/nova-` | 28 |
| <img src="assets/models/xiaomimimo.png" width="20" height="20" alt=""> | `xiaomimimo` | `^mimo-`, `/mimo-` | 112 |
| <img src="assets/models/baai.png" width="20" height="20" alt=""> | `baai` | `^baai`, `^bge-`, `/bge-`, `touchd`, `robobrain` | 4 |
| <img src="assets/models/ace.png" width="20" height="20" alt=""> | `ace` | `ace-step` | 0 |
| <img src="assets/models/cursor.png" width="20" height="20" alt=""> | `cursor` | `^composer`, `/composer`, `-composer` | 4 |
| <img src="assets/models/typesafeai.png" width="20" height="20" alt=""> | `typesafeai` | `(^\|/)jev($\|-)`, `typesafe` | 14 |

**Fallback matched against the provider id** (only when no model rule matches):

| Logo | Key | Provider id contains | omp catalog models |
| --- | --- | --- | --- |
| <img src="assets/models/alibaba.png" width="20" height="20" alt=""> | `alibaba` | `alibaba` | 0 |
| <img src="assets/models/alephalpha.png" width="20" height="20" alt=""> | `alephalpha` | `alephalpha` | 0 |
| <img src="assets/models/antgroup.png" width="20" height="20" alt=""> | `antgroup` | `antgroup` | 0 |
| <img src="assets/models/anyscale.png" width="20" height="20" alt=""> | `anyscale` | `anyscale` | 0 |
| <img src="assets/models/apple.png" width="20" height="20" alt=""> | `apple` | `apple` | 0 |
| <img src="assets/models/baidu.png" width="20" height="20" alt=""> | `baidu` | `baidu` | 0 |
| <img src="assets/models/bailian.png" width="20" height="20" alt=""> | `bailian` | `bailian`, `bailiancodingplan` | 0 |
| <img src="assets/models/baseten.png" width="20" height="20" alt=""> | `baseten` | `baseten` | 0 |
| <img src="assets/models/bilibili.png" width="20" height="20" alt=""> | `bilibili` | `bilibili` | 0 |
| <img src="assets/models/bytedance.png" width="20" height="20" alt=""> | `bytedance` | `bytedance` | 34 |
| <img src="assets/models/centml.png" width="20" height="20" alt=""> | `centml` | `centml` | 0 |
| <img src="assets/models/civitai.png" width="20" height="20" alt=""> | `civitai` | `civitai` | 0 |
| <img src="assets/models/crusoe.png" width="20" height="20" alt=""> | `crusoe` | `crusoe` | 0 |
| <img src="assets/models/deepinfra.png" width="20" height="20" alt=""> | `deepinfra` | `deepinfra` | 6 |
| <img src="assets/models/deepmind.png" width="20" height="20" alt=""> | `deepmind` | `deepmind` | 0 |
| <img src="assets/models/empiriolabs.png" width="20" height="20" alt=""> | `empiriolabs` | `empiriolabs` | 0 |
| <img src="assets/models/exa.png" width="20" height="20" alt=""> | `exa` | `exa` | 0 |
| <img src="assets/models/featherless.png" width="20" height="20" alt=""> | `featherless` | `featherless` | 0 |
| <img src="assets/models/friendli.png" width="20" height="20" alt=""> | `friendli` | `friendli` | 0 |
| <img src="assets/models/googlecloud.png" width="20" height="20" alt=""> | `googlecloud` | `googlecloud` | 0 |
| <img src="assets/models/huawei.png" width="20" height="20" alt=""> | `huawei` | `huawei` | 0 |
| <img src="assets/models/huaweicloud.png" width="20" height="20" alt=""> | `huaweicloud` | `huaweicloud` | 0 |
| <img src="assets/models/hyperbolic.png" width="20" height="20" alt=""> | `hyperbolic` | `hyperbolic` | 0 |
| <img src="assets/models/ibm.png" width="20" height="20" alt=""> | `ibm` | `ibm` | 15 |
| <img src="assets/models/iflytekcloud.png" width="20" height="20" alt=""> | `iflytekcloud` | `iflytekcloud` | 0 |
| <img src="assets/models/inference.png" width="20" height="20" alt=""> | `inference` | `inference` | 0 |
| <img src="assets/models/infermatic.png" width="20" height="20" alt=""> | `infermatic` | `infermatic` | 0 |
| <img src="assets/models/kluster.png" width="20" height="20" alt=""> | `kluster` | `kluster` | 0 |
| <img src="assets/models/lambda.png" width="20" height="20" alt=""> | `lambda` | `lambda` | 0 |
| <img src="assets/models/leptonai.png" width="20" height="20" alt=""> | `leptonai` | `leptonai` | 0 |
| <img src="assets/models/llmapi.png" width="20" height="20" alt=""> | `llmapi` | `llmapi` | 0 |
| <img src="assets/models/llmgateway.png" width="20" height="20" alt=""> | `llmgateway` | `llmgateway` | 0 |
| <img src="assets/models/lg.png" width="20" height="20" alt=""> | `lg` | `lg` | 0 |
| <img src="assets/models/menlo.png" width="20" height="20" alt=""> | `menlo` | `menlo` | 0 |
| <img src="assets/models/metaai.png" width="20" height="20" alt=""> | `metaai` | `meta` | 0 |
| <img src="assets/models/microsoft.png" width="20" height="20" alt=""> | `microsoft` | `microsoft` | 31 |
| <img src="assets/models/nplcloud.png" width="20" height="20" alt=""> | `nplcloud` | `nplcloud` | 0 |
| <img src="assets/models/nousresearch.png" width="20" height="20" alt=""> | `nousresearch` | `nousresearch` | 19 |
| <img src="assets/models/parasail.png" width="20" height="20" alt=""> | `parasail` | `parasail` | 0 |
| <img src="assets/models/searchapi.png" width="20" height="20" alt=""> | `searchapi` | `searchapi` | 0 |
| <img src="assets/models/snowflake.png" width="20" height="20" alt=""> | `snowflake` | `snowflake` | 0 |
| <img src="assets/models/stability.png" width="20" height="20" alt=""> | `stability` | `stability` | 2 |
| <img src="assets/models/statecloud.png" width="20" height="20" alt=""> | `statecloud` | `statecloud` | 0 |
| <img src="assets/models/streamlake.png" width="20" height="20" alt=""> | `streamlake` | `streamlake` | 0 |
| <img src="assets/models/sub2api.png" width="20" height="20" alt=""> | `sub2api` | `sub2api` | 0 |
| <img src="assets/models/submodel.png" width="20" height="20" alt=""> | `submodel` | `submodel` | 0 |
| <img src="assets/models/targon.png" width="20" height="20" alt=""> | `targon` | `targon` | 0 |
| <img src="assets/models/tencent.png" width="20" height="20" alt=""> | `tencent` | `tencent` | 0 |
| <img src="assets/models/tii.png" width="20" height="20" alt=""> | `tii` | `tii` | 1 |
| <img src="assets/models/typesafeai.png" width="20" height="20" alt=""> | `typesafeai` | `typesafe`, `typesafe-ai`, `typesafeai` | 14 |
| <img src="assets/models/unsloth.png" width="20" height="20" alt=""> | `unsloth` | `unsloth` | 0 |
| <img src="assets/models/yandex.png" width="20" height="20" alt=""> | `yandex` | `yandex` | 0 |
| <img src="assets/models/aimass.png" width="20" height="20" alt=""> | `aimass` | `aimass` | 0 |
| <img src="assets/models/aistudio.png" width="20" height="20" alt=""> | `aistudio` | `aistudio` | 0 |
| <img src="assets/models/novita.png" width="20" height="20" alt=""> | `novita` | `novita` | 12 |
| <img src="assets/models/openai.png" width="20" height="20" alt=""> | `openai` | `chatgpt`, `openai` | 879 |
| <img src="assets/models/opencode.png" width="20" height="20" alt=""> | `opencode` | `opencode`, `opencodecodingplan`, `opencodego`, `opencodezen` | 20 |
| <img src="assets/models/perplexity.png" width="20" height="20" alt=""> | `perplexity` | `perplexity` | 21 |
| <img src="assets/models/mistral.png" width="20" height="20" alt=""> | `mistral` | `mistral` | 213 |
| <img src="assets/models/groq.png" width="20" height="20" alt=""> | `groq` | `groq` | 2 |
| <img src="assets/models/together.png" width="20" height="20" alt=""> | `together` | `togetherai` | 0 |
| <img src="assets/models/doubao.png" width="20" height="20" alt=""> | `doubao` | `doubao` | 32 |
| <img src="assets/models/hunyuan.png" width="20" height="20" alt=""> | `hunyuan` | `hunyuan` | 37 |
| <img src="assets/models/nvidia.png" width="20" height="20" alt=""> | `nvidia` | `nvidia` | 170 |
| <img src="assets/models/tencentcloud.png" width="20" height="20" alt=""> | `tencentcloud` | `tencentcloud` | 0 |
| <img src="assets/models/wenxin.png" width="20" height="20" alt=""> | `wenxin` | `wenxin` | 35 |
| <img src="assets/models/lmstudio.png" width="20" height="20" alt=""> | `lmstudio` | `lmstudio` | 0 |
| <img src="assets/models/magpie.png" width="20" height="20" alt=""> | `magpie` | `magpie`, `magpie` | 0 |
| <img src="assets/models/grok.png" width="20" height="20" alt=""> | `grok` | `supergrok` | 212 |
| <img src="assets/models/higress.png" width="20" height="20" alt=""> | `higress` | `higress` | 0 |
| <img src="assets/models/vertexai.png" width="20" height="20" alt=""> | `vertexai` | `vertexai` | 3 |
| <img src="assets/models/jina.png" width="20" height="20" alt=""> | `jina` | `jina` | 1 |
| <img src="assets/models/azureai.png" width="20" height="20" alt=""> | `azureai` | `azureai` | 0 |
| <img src="assets/models/volcengine.png" width="20" height="20" alt=""> | `volcengine` | `volcengine`, `volcenginecodingplan` | 0 |
| <img src="assets/models/cohere.png" width="20" height="20" alt=""> | `cohere` | `cohere` | 16 |
| <img src="assets/models/comfyui.png" width="20" height="20" alt=""> | `comfyui` | `comfyui` | 0 |
| <img src="assets/models/cometapi.png" width="20" height="20" alt=""> | `cometapi` | `cometapi` | 0 |
| <img src="assets/models/vercel.png" width="20" height="20" alt=""> | `vercel` | `v0` | 0 |
| <img src="assets/models/bfl.png" width="20" height="20" alt=""> | `bfl` | `bfl` | 0 |
| <img src="assets/models/flexai.png" width="20" height="20" alt=""> | `flexai` | `flexai` | 0 |
| <img src="assets/models/ollama.png" width="20" height="20" alt=""> | `ollama` | `ollamacloud` | 0 |
<!-- model-icons:end -->

#### Updating the logos

`extensions/model-icons.generated.ts`, `assets/models/` and the tables above are generated. Don't edit them by hand. Regenerate them after bumping `LOBE_ICONS_VERSION` / `STATIC_PNG_VERSION` in `scripts/sync-model-icons.ts`, or after updating `@oh-my-pi/pi-catalog` to refresh the omp catalog counts:

```bash
pnpm sync-icons
```

The script:

1. Reads lobe's `modelMappings` / `providerMappings` from `@lobehub/icons` (pinned version).
2. Downloads a PNG for **every icon those rules can select** into `assets/models/`, not only the ones omp's catalog uses today, so custom gateway models and future models already have a logo. Lobe's other icons (apps and tools no rule points to) are left out; Discord allows 300 Art Assets per application.
3. Writes the rules in lobe's order. A rule whose icon has no PNG maps to `null`: no badge rather than a wrong one.
4. Regenerates the tables above. It resolves every model in omp's bundled catalog (`@oh-my-pi/pi-catalog`) the same way the extension does, to count coverage.
5. Compares the result with the application's public Art Asset list and prints which keys to **upload** and which to **delete** in the portal.

### Environment overrides

```bash
# Use your own Discord application (it needs its own Art Assets)
export OMP_DISCORD_CLIENT_ID=1566329796068384808
# Large image: an Art Asset key (at least 512×512) or any image URL
export OMP_DISCORD_LARGE_IMAGE_KEY=omp-logo
```
