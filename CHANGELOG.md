# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.1] - 2026-11-02

### Changed

- **Faster start, fewer requests:** GitHub repo visibility is cached per repo. A session in a known repo uses the cached answer right away and rechecks in the background.
- **Smaller package:** the npm package is about 60% smaller (1.9 MB → 0.8 MB). The logo images are no longer shipped; the README's logo tables load them from GitHub.

### Fixed

- When GitHub was unreachable or rate-limited, a known-public repo was hidden as `private project` and lost its GitHub button.

## [0.4.0] - 2026-11-02

### Added

- **Timer** setting in `/discord-presence settings`: the elapsed time on Discord counts from the latest prompt (default, as before) or from when the omp session started.
- Hovering the large omp icon now shows how many omp sessions are open, across all omp processes, e.g. `oh-my-pi v18.15.0 · 2 sessions open`. Sessions left behind by a crashed omp aren't counted.
- `/discord-presence status` shows the timer setting and the open session count.

## [0.3.0] - 2026-11-02

### Added

- Automated tests (`pnpm test`, bun:test). They cover:
  - GitHub remote parsing, model-logo matching and per-project setting precedence;
  - the generated logo assets;
  - behaviour end to end against a fake Discord: status flow, approval waiting, private-repo hiding, GitHub button and `hide`, live per-project overrides, the subagent party, presence off, and Tab completion.
- CI on every push and pull request: typecheck, lint, tests and an `npm pack` dry run.
- Release workflow: pushing a `vX.Y.Z` tag checks that it matches `package.json` and `CHANGELOG.md`, publishes to npm through trusted publishing (OIDC, with provenance), and creates the GitHub release from the changelog.

### Changed

- The settings file now lives in omp's active agent directory instead of always `~/.omp/agent`. Each `omp --profile` gets its own settings, and `PI_CODING_AGENT_DIR` is respected. The default profile's path is unchanged.

### Fixed

- Closing the Discord connection before it had opened (a session that exits right after starting, or a login that times out) could raise an unhandled rejection, which omp treats as fatal. Found by the new CI run.

## [0.2.0] - 2026-11-02

### Added

- Tab completion for `/discord-presence` subcommands. Type `/discord-presence ` to list `settings`, `status`, `hide`, `show`, `on`, `off`, `refresh`, `context on` and `context off`, each with a short description. `context o` narrows the list to the two context options.

### Changed

- npm package metadata: description, keywords, homepage, repository and issue links. The changelog now ships with the package.

## [0.1.0] - 2026-11-02

First release on npm, ported from the pi `pi-discord-presence` extension to omp (oh-my-pi).

### Added

- **Status:**
  - idle, thinking, using a tool, waiting for you (tool approval, the `ask` tool, plan review), compacting context, retrying, and away after a configurable idle time;
  - parallel tools are tracked until the last one ends;
  - updates are spaced 4 s apart to stay within Discord's rate limit.
- **Session details:** installed omp version, project name, active omp modes (plan, goal, loop, vibe), and the live model and effort. A switch shows within 3 s, without a prompt.
- **Model logos:** 156 logos from lobe-icons, matched with lobe's model and provider rules. `pnpm sync-icons` regenerates them and reports which Discord Art Assets to upload or delete.
- **GitHub button:** **View on GitHub** for public repos.
- **Subagents:** running subagents show as a Discord party, `(running of batch)`.
- **Optional extras:** git branch (`project @ main`) and context-window usage, both off by default.
- **Privacy:**
  - `/discord-presence hide` / `show`;
  - private GitHub repos are hidden automatically and fail closed;
  - the model, button and branch can each be turned off;
  - goal objectives, plan paths, approval reasons and retry errors are never sent.
- **`/discord-presence settings`:** interactive TUI menu with per-project overrides, applied live to all sessions.
- **`/discord-presence status`:** what Discord receives, the connection path, and why a logo or button is missing.
- **WSL:** a bundled `npiperelay.exe` bridge, so no `socat` relay is needed. Sessions share one bridge, and another session takes it over when its owner exits.

[Unreleased]: https://github.com/hiiruki/omp-discord-presence/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/hiiruki/omp-discord-presence/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/hiiruki/omp-discord-presence/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hiiruki/omp-discord-presence/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/hiiruki/omp-discord-presence/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hiiruki/omp-discord-presence/releases/tag/v0.1.0
