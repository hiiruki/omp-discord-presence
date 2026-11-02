# AGENTS.md: omp-discord-presence

Conventions for working on this repo, for humans and coding agents. omp, Claude Code, Codex and other agents load this file automatically. Keep it current when the workflow changes.

## What this is

An omp (oh-my-pi) extension that shows the omp session as Discord Rich Presence. It ships on npm as `omp-discord-presence`; users install it with `omp install omp-discord-presence`.

| Path | What | Edit by hand? |
| --- | --- | --- |
| `extensions/discord-presence.ts` | the extension (default export = omp factory; named exports are test seams) | yes |
| `extensions/discord-ipc.ts` | minimal client for Discord's local IPC protocol (handshake, `SET_ACTIVITY`) | yes |
| `extensions/model-icons.generated.ts` | lobe-icons model/provider logo rules | no, `pnpm sync-icons` |
| `assets/models/*.png` | logos, uploaded as Discord Art Assets; repo only, not in the npm package (the README links them on GitHub) | no, `pnpm sync-icons` |
| `scripts/sync-model-icons.ts` | regenerates the two above and the README logo tables | yes |
| `bin/npiperelay.exe` | vendored WSL→Windows pipe relay (MIT, v0.1.0) | no |
| `test/` | bun:test suite, fake Discord, fake omp session | yes |
| `.github/workflows/` | `ci.yml` (checks), `release.yml` (publish on tag) | yes |
| `CHANGELOG.md` | Keep a Changelog, one entry per user-visible change | yes |

## Tooling

- **pnpm** (version pinned in `package.json` `packageManager`) for dependencies. Don't use npm or yarn to install.
- **Bun** runs the tests, and it is also the runtime omp loads extensions in.
- **TypeScript 7** (`tsc`) for typechecking, **oxlint** for linting.

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # must pass before every commit
omp -e .                                   # try the checkout in a real omp session
pnpm sync-icons                            # after bumping lobe-icons or @oh-my-pi/pi-catalog
```

## Code rules

- **Never crash omp.** Extensions run in omp's process, and an unhandled rejection or a throwing timer callback kills the user's session. So:
  - give every async side effect a `.catch`, including fire-and-forget ones like `closeClient`;
  - give every socket and child process an `error` handler;
  - `unref()` raw timers;
  - prefer `ctx.setInterval` for periodic work.
- **Privacy is the product.** Never send any of the following to Discord:
  - a hidden project's name or branch;
  - a private repo's name, including while visibility is unknown (fail closed);
  - goal objectives, plan file paths, approval reasons, retry or error messages;
  - anything when presence is off.

  New fields that could leak something need a setting, and are off by default if they're sensitive.
- **Respect Discord's rate limit.** All updates go through `schedulePresenceUpdate` (0.75 s debounce, 4 s spacing). Never call `rpc.setActivity` directly.
- **Only the main session talks to Discord.** Subagent sessions only report to the shared counter.
- **Settings** live in `discord-presence-state.json` under `getAgentDir()` (profile-aware). Add new settings to `GlobalState`, `DEFAULT_STATE`, `readGlobalState` (validate the value), the settings menu, `/discord-presence status` and the README settings table.
- **Host packages** (`@oh-my-pi/*`) are optional peers resolved from the running omp. Never bundle them or add them to `dependencies`.
- **Comments** explain why, not what.

## Tests

- **What to test:** add or extend a test for each behaviour a user would notice when it breaks, such as what Discord shows, privacy, settings or commands. Don't test wiring, copies or wording.
- **Where:**
  - `test/helpers.test.ts`: pure functions;
  - `test/icons.test.ts`: the generated logo data;
  - `test/ipc.test.ts`: the IPC client against a misbehaving Discord (split frames, pings, refusals, drops);
  - `test/presence.test.ts`: end-to-end against the fake Discord in `test/support.ts`.
- **Isolation:** tests run in a throwaway agent dir (`PI_CODING_AGENT_DIR`) and Discord socket (`XDG_RUNTIME_DIR`), set up by `test/preload.ts`. Bun's `os.homedir()` ignores a changed `HOME`, so never rely on `HOME` for isolation. The same applies to manual experiments: point `PI_CODING_AGENT_DIR` at a temp dir, and never write to the maintainer's real `~/.omp/agent/discord-presence-state.json`.
- **No network:** the network is stubbed. Add new endpoints to `stubNetwork` instead of reaching the internet.
- **Timing:** wait with `waitForActivity`, never fixed sleeps. Updates are 4 s apart, so give multi-step tests `TIMEOUT`.
- **Check the test can fail:** when fixing a bug, make sure the new test fails without the fix.

## Commits

- [Conventional Commits](https://www.conventionalcommits.org/), in English:
  - imperative subject, at most 72 characters, no trailing period;
  - a body for the *why* when it isn't obvious.

  | Type | Use |
  | --- | --- |
  | `feat` | new user-visible behaviour |
  | `fix` | bug fix |
  | `docs` | README, AGENTS.md, comments only |
  | `ci` | workflows, Dependabot config |
  | `test` | tests only |
  | `refactor` | no behaviour change |
  | `perf` | faster or smaller, same behaviour |
  | `chore(deps)` | dependency updates |
  | `chore(release): x.y.z` | version bump + changelog heading |

- **One logical change per commit.** The code, its tests, its README section and its `CHANGELOG.md` entry go in the same commit.
- **GPG-signed:** commits and tags are signed (`git commit -S`, `git tag -s`). Run them in a TTY so the maintainer can enter the passphrase. Never disable signing in this repo.
- **Branching:** the maintainer works on `main`. Outside contributions come as pull requests and follow `.github/pull_request_template.md`.
- **Generated files:** never commit them out of sync with `pnpm sync-icons`.

## Changelog and versions

- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with these sections: `Added`, `Changed`, `Fixed`, `Removed`, `Security`.
- Write entries for users: what they'll notice, not the implementation.
- New entries go under `## [Unreleased]`.
- [SemVer](https://semver.org/). Below 1.0, a new feature or a behaviour change bumps the **minor** version, and a fix bumps the **patch**.
- Every feature is released on its own: one `feat`, then one release.

## Release

GitHub Actions publishes. Nobody runs `npm publish` by hand except in an emergency.

1. Make sure `main` is green in CI.
2. In `CHANGELOG.md`:
   1. rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`;
   2. add a fresh empty `## [Unreleased]` above it;
   3. update the compare links at the bottom.
3. Bump `version` in `package.json`.
4. Commit `chore(release): x.y.z` (signed).
5. Tag and push:

   ```bash
   git tag -s vx.y.z -m vx.y.z
   git push origin main vx.y.z
   ```

6. `release.yml` then:
   1. runs CI;
   2. checks that the tag matches `package.json` and that `CHANGELOG.md` has the version;
   3. runs `npm publish` with provenance through npm trusted publishing;
   4. creates the GitHub release from that changelog section.

   Watch it with `gh run watch`, and confirm with `npm view omp-discord-presence version`. npm can take about a minute to show a new version.

Rules:

- **Never republish or unpublish a version.** npm forbids reusing a number. A broken release gets a new patch version.
- **A release that failed before `npm publish`** (a check failed) may have its tag moved to the fixed commit: `git tag -s -f vx.y.z`, then `git push -f origin vx.y.z`. Once npm has the version, never move the tag.
- **Trusted publisher** (npmjs.com → package → Settings), must match exactly: repository `hiiruki/omp-discord-presence`, workflow `release.yml`, environment `npm`. Check it with `npm trust list omp-discord-presence`. A mismatch shows up as `E404` on publish.

## Dependencies

- **Dependabot** opens PRs weekly: grouped minor/patch for dev tooling, `@oh-my-pi/*` in lockstep, and majors one per package.
- **Merging:** merge once CI is green. If a major breaks the checks, fix the code in a `chore(deps)` commit on `main`. Dependabot then closes its PR as superseded.
- **No runtime dependencies.** Keep it that way: the Discord IPC client is our own (`extensions/discord-ipc.ts`). Don't add a dependency for a few lines of code.

## Discord application

App ID `1566329796068384808`, named "OH MY PI". The app name, icon and Art Assets reach every user immediately, without a release.

After `pnpm sync-icons`, upload the keys the script lists and delete the stale ones in Developer Portal → Rich Presence → Art Assets. Key = PNG file name without `.png`.
