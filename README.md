# 🏢 Pixel Agent Office

**A live pixel-art office where a team of [Claude Code](https://claude.com/claude-code) agents builds your project — a PM plans, developers implement in parallel, and QA verifies every piece before it ships.**

You hand it an *epic* (plain-English goal). A **PM agent** breaks it into parallel tasks. **Developer agents** implement them. Each finished piece goes to a **QA agent** that runs your tests and votes **PASS / FAIL** — failures loop back to the developer with the feedback. The whole team animates in a retro pixel office you can watch in your browser — and now you can **steer it live** (pause, cancel, retry, force a verdict), watch the **cost HUD** tick, cap the spend with a **budget**, and **replay** any past sprint.

It's a real orchestration layer (not a toy): each worker is a full headless `claude -p` agent that edits files and runs commands in *your* repo.

```
        EPIC ──▶  🧠 PM plans  ──▶  task graph (T1…Tn, with deps)
                                         │
                 ┌───────────────────────┼───────────────────────┐
                 ▼                       ▼                       ▼
            👷 dev T1               👷 dev T2               👷 dev T3
                 │                       │                       │
                 ▼                       ▼                       ▼
            🧪 QA T1                🧪 QA T2                🧪 QA T3
            PASS ✓                  FAIL ✗ ──▶ rework ──▶ QA ✓
```

> 📺 **Watch it live:** `node server.js` → open **http://localhost:4040** → press **`?demo=1`** for a sample office with no setup.

*(Add a screenshot/GIF of the office here — `docs/office.png`. The `?demo=1` view is perfect for it.)*

---

## ✨ Features

| Feature | What you get |
|---|---|
| **PM → dev → QA loop** | Work is decomposed, parallelised across a concurrency cap, dependency-ordered, and gated by QA. Failures retry with the rejection reason. |
| **Control plane** | Pause / resume / cancel the sprint and retry / force-pass / force-fail individual tasks — from the office UI, mid-run. |
| **Cost & budget HUD** | Live per-worker and sprint-total cost, tokens in/out, model, tasks/hour — parsed straight from each worker's `claude -p --output-format json` result. Set `ORCH_BUDGET_USD` to hard-cap spend. |
| **History & replay** | Every sprint is archived to `data/history/<runId>.json` with a timestamped event log; browse and replay past runs in the viewer. |
| **Webhook** | `ORCH_WEBHOOK_URL` gets a POST with the full sprint history JSON when the sprint completes. |
| **It learns** | Every QA failure is distilled into a one-line lesson in `.orch-lessons.md` in your repo and injected into *future* prompts — the team stops repeating mistakes across retries and sprints. |
| **Rooms, themes & presentation mode** | Workers sit in role-based rooms (planning / dev / qa), the office supports visual themes, and presentation mode turns it into a standup/demo display. |
| **Stack-agnostic profiles** | Ships a generic `software` profile; a `salesforce` profile is included as a worked example. A profile is just a small object — adapt it to any stack. |
| **Zero dependencies** | Pure Node 18+ + a single HTML canvas. No packages, no build step, no framework, no database. Docker optional. |

## 🚀 Quickstart — one line, no install

**Requirements:** [Node.js](https://nodejs.org) 18+ and [Claude Code](https://claude.com/claude-code) **2.1.141+** on your `PATH` (`claude --version`). On Windows, Git for Windows (git-bash) so workers can spawn.

```bash
npx github:pruthiviraj/pixel-agent-office demo
```

That's the whole install — npm fetches this repo and runs it (zero dependencies). The full flow, from inside **your** project:

```bash
cd your-project
npx github:pruthiviraj/pixel-agent-office init                      # scaffold epic.md here
npx github:pruthiviraj/pixel-agent-office sprint --epic ./epic.md --dry-run   # preview, no API spend
npx github:pruthiviraj/pixel-agent-office sprint --epic ./epic.md   # real agents (project = cwd)
npx github:pruthiviraj/pixel-agent-office                           # the office viewer, port 4040
```

CLI commands: `office` (default) · `demo` · `init` · `sprint [flags]` · `help`.

Or clone it if you prefer:

```bash
git clone https://github.com/pruthiviraj/pixel-agent-office.git
cd pixel-agent-office

node server.js                                            # office → http://localhost:4040/?demo=1
node orchestrate.js --epic ./examples/sample-epic.md --dry-run    # mocked loop, no API spend
node orchestrate.js --project /path/to/your/project --epic ./epic.md   # real sprint
```

> 💡 Run the sprint on a branch. Workers edit real files. For full autonomy
> (so workers can run your test/build commands without prompts) add
> `ORCH_SKIP_PERMISSIONS=1` — only on a repo you trust it to change.

## 🎛️ Steering a live sprint — the control plane

The office isn't just a window — it's a console. While a sprint runs you can:

- **Pause** — stop dispatching new tasks (running workers finish what they're on), then **resume**.
- **Cancel** — kill running workers, mark unfinished tasks `cancelled`, end the sprint.
- **Retry** a failed/cancelled task (back to `planned`).
- **Force-pass / force-fail** a task when you know better than QA.

The UI posts to `POST /api/control` with `{type, taskId?, reason?}`; the server appends the command to `data/control.json`, and the engine polls (~2s), executes, and acknowledges in `data/control-ack.json`. Board states are `planned | dev | qa | done | failed | cancelled`.

## 💸 Cost, budget & webhook

Each worker runs as `claude -p ... --output-format json`, so the engine gets exact `total_cost_usd` and token usage per task (with a graceful plain-text fallback for older CLIs). The HUD shows per-worker cost/tokens/model and sprint totals (done/failed, tokens in/out, $, tasks per hour).

- **Budget cap:** `ORCH_BUDGET_USD=5 node orchestrate.js ...` — when spend reaches the cap, no new tasks are dispatched, remaining planned tasks are cancelled with a "budget cap" note, and the sprint finishes cleanly.
- **Webhook:** `ORCH_WEBHOOK_URL=https://...` — on sprint completion the final history JSON is POSTed there (5s timeout; errors are ignored, your sprint never blocks on it).

## 🕰️ History & replay

Every sprint gets a `runId` and is written (incrementally, and at the end) to `data/history/<runId>.json` — epic, profile, project, summary, totals, budget, final board, workers, and a timestamped event log. The server exposes:

- `GET /api/history` — list of past runs, newest first.
- `GET /api/history/<runId>` — the full run, which the viewer can replay.

## 🧩 Adapt it to your stack — profiles

The orchestrator stays generic; a **profile** supplies the stack-specific briefing for the agents.

```bash
node orchestrate.js --epic ./epic.md                       # software (default)
node orchestrate.js --epic ./epic.md --profile salesforce  # Apex/LWC example
```

Writing your own is a 2-minute copy-and-edit job — see [`profiles/README.md`](./profiles/README.md).

## 🐳 Docker

A `Dockerfile` is included for hosting the **viewer**:

```bash
docker build -t pixel-agent-office .
docker run -p 4040:4040 pixel-agent-office                       # office + ?demo=1
docker run -p 4040:4040 -v "$PWD/data:/app/data" pixel-agent-office  # show a live sprint from the host
```

**Honest caveat:** orchestration workers are headless `claude -p` processes — they need the Claude Code CLI *and* its authentication, which the image deliberately doesn't bundle. So Docker is primarily for hosting the viewer (demos, a team dashboard, a wall screen); **the orchestrator runs best on the host**, where `claude` is installed and logged in. Run `node orchestrate.js` on the host and share `./data` with the container to watch it from Docker.

## 🛠️ Add it to your project (for humans *and* AI agents)

You don't install it *into* your repo — you point it *at* your repo with `--project`.
See [`docs/ADD-TO-YOUR-PROJECT.md`](./docs/ADD-TO-YOUR-PROJECT.md) for the full guide, including a copy-paste block you can drop into your repo's `AGENTS.md` / `CLAUDE.md` so an AI assistant knows how to launch a sprint for you.

## ⚙️ Configuration

| Flag / env | Default | What it does |
|---|---|---|
| `--project <dir>` / `ORCH_PROJECT` | `.` | the repo the agents work in |
| `--epic <file\|text>` / `ORCH_EPIC` | — | the work to break down & build |
| `--profile <name>` / `ORCH_PROFILE` | `software` | stack profile in `./profiles` |
| `--dry-run` / `ORCH_DRYRUN=1` | off | mock the agents (test the loop + HUD, no API spend) |
| `ORCH_CONCURRENCY` | `3` | max workers running at once |
| `ORCH_MAX_RETRIES` | `2` | dev↔QA rework attempts per task |
| `ORCH_BUDGET_USD` | unset | hard spend cap for the sprint (cancels remaining tasks at the cap) |
| `ORCH_WEBHOOK_URL` | unset | POST the final sprint history JSON here on completion |
| `ORCH_SKIP_PERMISSIONS=1` | off | full autonomy (`--dangerously-skip-permissions`) |
| `ORCH_MODEL` | inherit | model for worker agents, e.g. `claude-sonnet-4-6` |
| `ORCH_TIMEOUT_MIN` | `30` | per-worker timeout (minutes) |
| `PORT` (server) | `4040` | office web server port |

## 🏗️ How it works

- **`orchestrate.js`** — the engine. Spawns headless `claude -p` workers (JSON output for cost/tokens), runs the PM→dev→QA scheduler with dependencies + retries, streams live state to `data/team.json`, polls `data/control.json` for operator commands, and archives each run to `data/history/`.
- **`server.js`** — a zero-dep web server (port 4040) that reads `data/team.json` (and your live `claude agents`) and serves the office. Also keeps a per-project "knowledge" brain.
  API surface: `GET /api/state` (`?demo=1`), `POST /api/control`, `GET /api/history`, `GET /api/history/<runId>`, `POST /api/learn`, `GET /api/logs/<id>`.
- **`public/pixel.html`** — the pixel-art office canvas: rooms, themes, presentation mode, control buttons, cost HUD.
- **`profiles/`** — per-stack agent briefings.

More detail in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## 📋 Notes & safety

- Workers edit **real files** and can run shell commands. Run on a branch; review the diff.
- The orchestrator never deploys to production — that's left to you (and reinforced in the prompts).
- API usage scales with `concurrency × tasks × retries`. Start small; `--dry-run` is free, and `ORCH_BUDGET_USD` is your seatbelt.

## 📜 License

[MIT](./LICENSE) — free to use, fork, and adapt. If you build something cool with it, a mention is appreciated. 🙂

---

*Built on top of Claude Code. Not affiliated with Anthropic.*
