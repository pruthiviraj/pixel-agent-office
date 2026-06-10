# Architecture

Three small pieces, one shared state file. No build step, no framework, no DB.

```
        you ──(epic)──▶  orchestrate.js  ──writes──▶  data/team.json  ──reads──▶  server.js  ──▶  public/pixel.html
                              │                                                       ▲                (your browser)
                       spawns │ claude -p workers                                     │ also polls
                              ▼                                                  `claude agents --json`
                     your repo (--project)                                       (any live sessions)
```

## `orchestrate.js` — the engine

- Loads a **profile** (`./profiles/<name>.js`) that supplies the PM/dev/QA briefings for your stack.
- **PM phase:** one `claude -p` call turns the epic into a JSON task graph (`id`, `title`, `description`, `components`, `acceptance`, `deps`, `qa`).
- **Scheduler:** dispatches dependency-ready tasks up to `ORCH_CONCURRENCY`. Each task runs **dev → QA**:
  - dev worker implements the task in `--project`.
  - QA worker verifies it and must end with `VERDICT: PASS` or `VERDICT: FAIL — …`.
  - FAIL → the task goes back to dev with the reason, up to `ORCH_MAX_RETRIES`.
  - A failed dependency fails its dependents.
- **Lessons memory:** each QA failure appends a deduped one-liner to `.orch-lessons.md` in the target repo; every later dev/QA prompt includes it.
- Continuously writes the whole team's state to `data/team.json` (+ `data/team-logs.json`).

Each worker is a real headless `claude -p` process launched with `--name` (so it shows
up as a labelled agent) and either `--permission-mode` or `--dangerously-skip-permissions`.

## `server.js` — the viewer + brain

- Zero-dependency Node HTTP server (default port `4040`).
- `GET /api/state` merges the orchestrator's `team.json` with any live `claude agents --json`
  sessions, so the office shows both orchestrated workers and your other Claude sessions.
- Routes session names to teams (planning / developer / tester) by simple regex.
- Keeps a per-project **knowledge** store (`data/knowledge.json`): task outcomes, team XP,
  and an optional learned project brief (the `LEARN` button / `AUTO_LEARN=1`).
- Serves `public/pixel.html` (and `index.html`). `?demo=1` returns sample data.

## `public/pixel.html` — the office

- A single `<canvas>` pixel-art renderer. Polls `/api/state` (~2s) and animates each
  agent as a sprite that walks, works, hands off, and celebrates passes. No dependencies.

## `data/` (gitignored, runtime)

- `team.json` — current sprint state (workers, board, log).
- `team-logs.json` — captured worker output for the UI drawer.
- `knowledge.json` — the per-project brain.

## State contract (`team.json`)

```jsonc
{
  "active": true,
  "updatedAt": 1730000000000,
  "project": "/abs/path", "epic": "…", "profile": "software",
  "summary": "PM's one-line plan",
  "phase": "building",                       // planning | building | done
  "workers": [ { "id", "name", "team", "status", "summary", "startedAt" } ],
  "board":   [ { "id", "title", "state", "retries", "deps", "components" } ],
  "log":     [ "human-readable events…" ]
}
```

Anything that writes this shape can drive the office — the orchestrator is just the
reference producer.
