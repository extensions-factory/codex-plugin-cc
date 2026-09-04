# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **plugin marketplace** (`.claude-plugin/marketplace.json`) shipping one plugin, `plugins/codex`, that lets Claude Code drive a local `codex` CLI for reviews and delegated tasks. There is no application to run — the deliverable is the plugin directory plus its Node runtime.

## Commands

```bash
npm test                              # node --test tests/*.test.mjs
node --test tests/runtime.test.mjs    # single test file
node --test --test-name-pattern "setup reports ready" tests/runtime.test.mjs

npm run build          # tsc -p tsconfig.app-server.json (checkJs, noEmit)
npm run bump-version 1.0.7   # rewrites version in all 4 manifests
npm run check-version        # verifies the 4 manifests agree
```

`npm run build` has a `prebuild` that shells out to `codex app-server generate-ts` and writes `plugins/codex/.generated/app-server-types` (gitignored). **A real `codex` binary must be on PATH for the build**; tests do not need one (see fixtures below). CI (`.github/workflows/pull-request-ci.yml`) runs `npm ci`, installs `@openai/codex` globally, then `npm test` and `npm run build`.

Version lives in four files that must stay in lockstep — `package.json`, `package-lock.json` (twice), `plugins/codex/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`. Always use `npm run bump-version`, never edit by hand.

## Architecture

Three layers, and the boundary between them is the thing to respect:

1. **Markdown UX** — `plugins/codex/commands/*.md`, `agents/codex-rescue.md`, `skills/*/SKILL.md`. These are prompts, not code. They own flag parsing hints, `AskUserQuestion` prompts, and the "return stdout verbatim" contract. `commands/*.md` files with `--background` launch the Bash call with `run_in_background: true`; the companion script's own `--background`/`--wait` flags do **not** detach anything by themselves.
2. **Node runtime** — `plugins/codex/scripts/codex-companion.mjs` is the single CLI entrypoint. Subcommands: `setup`, `workers`, `review`, `adversarial-review`, `task`, `transfer`, `status`, `result`, `cancel`, plus two internal ones not in `printUsage`: `task-worker` (the detached child spawned for background tasks) and `task-resume-candidate` (JSON probe used by `/codex:rescue` to decide whether to offer thread resume).
3. **Codex app-server** — JSON-RPC 2.0 over JSONL on stdio, spawned as `codex app-server`. Client in `scripts/lib/app-server.mjs`, orchestration (threads/turns/reviews/notification capture) in `scripts/lib/codex.mjs`.

### Broker

`scripts/app-server-broker.mjs` multiplexes one `codex app-server` process across a session over a Unix socket (named pipe on Windows — see `lib/broker-endpoint.mjs`). Only **one** streaming call may be in flight; `STREAMING_METHODS` = `turn/start`, `review/start`, `thread/compact/start`, and while one runs the broker rejects everything except `turn/interrupt` with `BROKER_BUSY_RPC_CODE` (-32001). `CodexAppServerClient.connect()` falls back to spawning a direct app-server when the broker is busy or unreachable. **Adding a method to `STREAMING_METHODS` that does not terminate in `turn/completed` deadlocks the broker.**

### Jobs and state

Every executable command routes through `runTrackedJob` (`lib/tracked-jobs.mjs`), so logs, progress, results, and failure handling are uniform — new commands should go through it rather than hand-rolling. Job lifecycle: `queued -> running -> completed|failed`, or `queued|running -> cancelled`.

State lives **outside the repo**, in `$CLAUDE_PLUGIN_DATA/state/<slug>-<sha256-16>` (falling back to `os.tmpdir()/codex-companion`), keyed by the realpath'd git root and capped at 50 jobs (`lib/state.mjs`). Jobs are also tagged with `CODEX_COMPANION_SESSION_ID`; the `SessionEnd` hook kills and prunes that session's jobs.

### Hooks

`plugins/codex/hooks/hooks.json` registers three: `SessionStart` and `SessionEnd` (`session-lifecycle-hook.mjs` — exports session id / transcript path / plugin data dir into `CLAUDE_ENV_FILE`, tears down the broker, prunes jobs) and an **opt-in** `Stop` gate (`stop-review-gate-hook.mjs`, toggled by `/codex:setup --enable-review-gate`) that runs a Codex review of the last turn and blocks the stop on a `BLOCK:` first line.

### Safety invariants in the app-server payloads

`approvalPolicy` is always `never`. Sandbox is `read-only` except `task --write`, which uses `workspace-write`; `danger-full-access` is never exposed. Raw `config`, `baseInstructions`, and `approvalsReviewer` are deliberately not reachable from a slash command — surfacing any of them is a policy change, not a new option. `developerInstructions` is populated only from the worker roster shipped in `plugins/codex/workers/` (`--worker <name>` picks a profile, `workers.json` `defaults` picks one per kind); free-text instructions are never accepted from a command. `plugins/codex/ARCHITECT.md` (Vietnamese) documents the full current-vs-available payload matrix.

## Testing

Tests are `node:test`, no framework. Two distinct styles:

- **Behavior tests** (`runtime.test.mjs`, `git.test.mjs`, `state.test.mjs`) spawn the real companion script against a **fake `codex` binary** written to a temp dir by `tests/fake-codex-fixture.mjs`. `installFakeCodex(binDir, behavior)` takes a behavior string (`review-ok`, `proxy-provider`, `auth-run-fails`, …) that selects the fake's canned app-server responses. Add a behavior there rather than mocking inside the runtime.
- **Prompt-contract tests** (`commands.test.mjs`) regex-assert the literal text of `commands/*.md`. Editing a command's wording — even a "Do not fix issues" line — will fail these; update both together.

`tests/helpers.mjs` gives `makeTempDir`, `run` (spawnSync with Windows shell handling), and `initGitRepo`.

## Conventions

- ESM only (`"type": "module"`), `.mjs`, Node >= 18.18, zero runtime dependencies — stdlib only. Keep it that way.
- Windows is a supported target: process teardown goes through `terminateProcessTree` (`lib/process.mjs`), and endpoints branch on `process.platform`. Don't assume POSIX.
- Type checking is JSDoc-driven `checkJs` over a small allowlist in `tsconfig.app-server.json`, not full-repo. App-server types are hand-written in `lib/app-server-protocol.d.ts` on top of the generated schema.
