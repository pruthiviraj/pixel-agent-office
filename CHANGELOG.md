# Changelog

All notable changes to this project are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-06-10

### Added

- **Control plane** — pause / resume / cancel a running sprint and retry / force-pass / force-fail individual tasks from the office UI. Commands flow through `POST /api/control` → `data/control.json`; the engine polls, executes, and acknowledges them in `data/control-ack.json`.
- **Cost & budget HUD** — workers report per-task cost, tokens in/out and model (parsed from `claude -p --output-format json`); the office shows live totals (`tasksDone`, `tasksFailed`, `tokensIn/Out`, `costUsd`, `tasksPerHour`) and a budget bar. Set `ORCH_BUDGET_USD` to hard-cap a sprint — when spend reaches the cap, remaining planned tasks are cancelled with a "budget cap" note and the sprint finishes.
- **Rooms, themes & presentation mode** — workers are placed in rooms by role (planning / dev / qa), the office canvas supports visual themes, and a presentation mode makes the viewer demo/standup friendly.
- **History & replay** — every sprint is written to `data/history/<runId>.json` (summary, totals, budget, board, workers, timestamped event log). Browse past runs via `GET /api/history` and replay one via `GET /api/history/<runId>`.
- **Completion webhook** — set `ORCH_WEBHOOK_URL` to POST the final sprint history JSON on completion (5s timeout, failures ignored).
- **Docker support** — `Dockerfile` + `.dockerignore` to host the office viewer (`node server.js`, port 4040) in a container.
- **CI** — GitHub Actions workflow running the smoke test (`node --check` + a dry-run sprint) on Ubuntu and Windows, Node 18 and 20.
- **`npm run smoke`** — one-command syntax check + dry-run sprint.
- `CONTRIBUTING.md` and this changelog.

### Changed

- New board task states: `planned | dev | qa | done | failed | cancelled` (previously no `cancelled`).
- `data/team.json` gained `runId`, `paused`, `budget`, `totals`, and per-worker `costUsd` / `tokensIn` / `tokensOut` / `model` / `room`. The UI tolerates all of these being absent for back-compat.

## [0.1.0] — Initial release

- PM → dev → QA orchestration loop over headless `claude -p` workers, with dependency ordering, a concurrency cap, and QA-gated retries.
- Lessons file (`.orch-lessons.md`) — QA failures distilled into one-line lessons injected into future prompts.
- Stack profiles (`software` default, `salesforce` worked example).
- Zero-dependency pixel-art office viewer (`server.js` + `public/pixel.html`) with `?demo=1` sample mode.
- Per-project knowledge brain and `POST /api/learn`.
