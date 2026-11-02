# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/hiiruki/omp-discord-presence/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hiiruki/omp-discord-presence/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hiiruki/omp-discord-presence/releases/tag/v0.1.0
