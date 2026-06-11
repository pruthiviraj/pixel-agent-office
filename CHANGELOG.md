# Changelog

All notable changes to this project are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.1] — 2026-06-11

### Added

- **Answer agents from the office — no terminal round-trip** (drawer reply + control plane). Click an orchestrated agent and a reply box appears: your text is sent as a `guide` control command, injected into the task as "OPERATOR GUIDANCE", and the task re-runs with it (re-queued if it had finished/failed). The sprint board also regains per-task **Retry / Pass / Fail** controls. So when an agent raises its hand for input you respond in-place instead of switching screens.
- **Persistent per-project crew with XP + leveling** (`orchestrate.js`, `server.js`, Project Brain). Each project keeps a named team (`roster.json`, keyed by project path) that **recurs across sprints**: agents are assigned to PM/dev/QA work, earn XP for **shipped** tasks (dev +2, tester +1, PM +1 per shipped task), and level up **Junior → Mid → Senior → Staff → Principal** (0 / 3 / 8 / 20 / 40 xp). Fixed crew sized to the concurrency cap; same names return more senior each run. The office **Project Brain** now shows the roster (name · level · xp · bar-to-next-tier · sprints/tasks of tenure) instead of bare aggregate XP, and promotions log live ("★ Maya promoted: MID → SENIOR").

### Fixed

- **LEARN-folder failures are now visible** (Project Brain) — the button shells a headless `claude -p` in the folder; if that fails it stored `lastError` silently. The Brain now surfaces the error + the requirement (claude on PATH + logged in, git-bash on Windows). XP also no longer requires `claude --bg` named sessions — orchestrated sprint work feeds the roster directly.

- **Viewer and sprint now share one state dir** (`orchestrate.js`, `server.js`) — state (`team.json`, `history/`, control channel) was keyed off `__dirname/data`, so when `npx github:...` resolved the viewer and the sprint to different cache installs they wrote/read different `data/` dirs and the office fell back to its built-in **demo** agents while a real sprint was running. `DATA_DIR` now resolves to an install-location-independent `~/.pixel-agent-office/data` (override with `PAO_DATA_DIR`); both startup banners print the resolved path.

### Changed

- **`/` now serves the full pixel office** (`server.js`) — the control plane (pause / resume / cancel) and the cost/budget HUD live in `office-extras.js`, which only `pixel.html` loads. Visiting the default route previously served the leaner `index.html` with none of those controls. The pixel office is now the default; `index.html` stays reachable at `/index.html`.
- **Unified office (`pixel.html` rebuilt on the Agent Office engine)** — `pixel.html` now uses index.html's animated character/office-space canvas (humans walking, typing, cheering across PM / Dev / QA / Lobby zones) and gains the **Sprint Board** and **Project Brain (project-folder + LEARN)** sections, *while keeping* the cost/budget HUD and pause/resume/cancel/theme/present control plane. One office with the floor view, the sprint, the project knowledge, and live controls — instead of two divergent pages. `office-extras.js` is wired via a shared global `ingest(data)` (also used by `?replay=`).

## [0.3.0] — 2026-06-10

### Added

- **Preflight safety checks** (`orchestrate.js`) — before any real (non-`--dry-run`) sprint:
  - refuses to run outside a git repo (override with `--allow-no-git`),
  - refuses to run with uncommitted changes (override with `--allow-dirty`),
  - **auto-creates an isolated `agent/run-<stamp>-<slug>` branch** so the agents never commit straight to your working branch — rollback is `git branch -D <branch>`. Opt out with `--no-branch`,
  - if `--no-branch` lands you on `main`/`master`, refuses unless `--allow-main`,
  - if `ORCH_SKIP_PERMISSIONS=1`, refuses unless `--i-understand-risk` (or `ORCH_I_UNDERSTAND_RISK=1`) is also set.
- **Server token auth** (`server.js`) — set `OFFICE_TOKEN=<random>` and every `/api/*` call requires `Authorization: Bearer <token>`. The boot banner prints a `?t=<token>` URL; opening it once stores the token in `sessionStorage` and a tiny `/auth.js` shim attaches the bearer header to every fetch. Server now binds to `127.0.0.1` by default (`OFFICE_BIND` to override, with a loud warning if you bind wider without a token).
- **Claude Code `/sprint` slash command** — `npx github:pruthiviraj/pixel-agent-office install-command` drops `~/.claude/commands/sprint.md`. Inside Claude Code, `/sprint <your goal>` now runs Pixel Agent Office on the current repo (dry-run first, then real run after approval). Remove with `uninstall-command`.
- **Shorter CLI** — `sprint` accepts a positional epic (`sprint ./epic.md` or `sprint "build a discount engine"`). The top-level CLI treats any unknown first arg as a sprint epic, so `npx github:pruthiviraj/pixel-agent-office "build X"` Just Works.

### Changed

- Default bind is now `127.0.0.1` (was `0.0.0.0`-ish via Node's default). Set `OFFICE_BIND=0.0.0.0` to expose on the network — but only with `OFFICE_TOKEN` set.

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
