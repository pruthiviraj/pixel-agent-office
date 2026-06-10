# 🏢 Pixel Agent Office

**A live pixel-art office where a team of [Claude Code](https://claude.com/claude-code) agents builds your project — a PM plans, developers implement in parallel, and QA verifies every piece before it ships.**

You hand it an *epic* (plain-English goal). A **PM agent** breaks it into parallel tasks. **Developer agents** implement them. Each finished piece goes to a **QA agent** that runs your tests and votes **PASS / FAIL** — failures loop back to the developer with the feedback. The whole team animates in a retro pixel office you can watch in your browser.

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

## ✨ Why it's neat

- **Real PM → dev → QA loop.** Work is decomposed, parallelised across a concurrency cap, dependency-ordered, and gated by QA. Failures retry with the rejection reason.
- **It learns.** Every QA failure is distilled into a one-line lesson in `.orch-lessons.md` in your repo and injected into *future* prompts — the team stops repeating mistakes across retries and sprints.
- **Stack-agnostic via profiles.** Ships a generic `software` profile; a `salesforce` profile is included as a worked example. A profile is just a small object — adapt it to any stack.
- **Watchable.** A zero-dependency Node server renders a pixel-art office: the PM, devs and testers walk around, hand off work, and celebrate passes. Great for demos and standups.
- **Lightweight.** Pure Node + a single HTML canvas. No build step, no framework, no database.

## 🚀 Quickstart

**Requirements:** [Node.js](https://nodejs.org) 18+ and [Claude Code](https://claude.com/claude-code) **2.1.141+** on your `PATH` (`claude --version`). On Windows, Git for Windows (git-bash) so workers can spawn.

```bash
git clone https://github.com/pruthiviraj/pixel-agent-office.git
cd pixel-agent-office

# 1) See the office with sample data — no agents, no API spend
node server.js          # → http://localhost:4040/?demo=1

# 2) Try the orchestration loop with mocked agents (no API spend)
node orchestrate.js --epic ./examples/sample-epic.md --dry-run

# 3) Run a real sprint on YOUR project (spends API quota, edits the repo)
node orchestrate.js --project /path/to/your/project --epic ./examples/sample-epic.md
#   …and keep `node server.js` open in another terminal to watch it.
```

> 💡 Run the sprint on a branch. Workers edit real files. For full autonomy
> (so workers can run your test/build commands without prompts) add
> `ORCH_SKIP_PERMISSIONS=1` — only on a repo you trust it to change.

## 🧩 Adapt it to your stack — profiles

The orchestrator stays generic; a **profile** supplies the stack-specific briefing for the agents.

```bash
node orchestrate.js --epic ./epic.md                       # software (default)
node orchestrate.js --epic ./epic.md --profile salesforce  # Apex/LWC example
```

Writing your own is a 2-minute copy-and-edit job — see [`profiles/README.md`](./profiles/README.md).

## 🛠️ Add it to your project (for humans *and* AI agents)

You don't install it *into* your repo — you point it *at* your repo with `--project`.
See [`docs/ADD-TO-YOUR-PROJECT.md`](./docs/ADD-TO-YOUR-PROJECT.md) for the full guide, including a copy-paste block you can drop into your repo's `AGENTS.md` / `CLAUDE.md` so an AI assistant knows how to launch a sprint for you.

## ⚙️ Configuration

| Flag / env | Default | What it does |
|---|---|---|
| `--project <dir>` / `ORCH_PROJECT` | `.` | the repo the agents work in |
| `--epic <file\|text>` / `ORCH_EPIC` | — | the work to break down & build |
| `--profile <name>` / `ORCH_PROFILE` | `software` | stack profile in `./profiles` |
| `--dry-run` / `ORCH_DRYRUN=1` | off | mock the agents (test the loop, no API spend) |
| `ORCH_CONCURRENCY` | `3` | max workers running at once |
| `ORCH_MAX_RETRIES` | `2` | dev↔QA rework attempts per task |
| `ORCH_SKIP_PERMISSIONS=1` | off | full autonomy (`--dangerously-skip-permissions`) |
| `ORCH_MODEL` | inherit | model for worker agents, e.g. `claude-sonnet-4-6` |
| `ORCH_TIMEOUT_MIN` | `30` | per-worker timeout (minutes) |
| `PORT` (server) | `4040` | office web server port |

## 🏗️ How it works

- **`orchestrate.js`** — the engine. Spawns headless `claude -p` workers, runs the PM→dev→QA scheduler with dependencies + retries, and streams live state to `data/team.json`.
- **`server.js`** — a zero-dep web server (port 4040) that reads `data/team.json` (and your live `claude agents`) and serves the office. Also keeps a per-project "knowledge" brain.
- **`public/pixel.html`** — the pixel-art office canvas.
- **`profiles/`** — per-stack agent briefings.

More detail in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## 📋 Notes & safety

- Workers edit **real files** and can run shell commands. Run on a branch; review the diff.
- The orchestrator never deploys to production — that's left to you (and reinforced in the prompts).
- API usage scales with `concurrency × tasks × retries`. Start small; `--dry-run` is free.

## 📜 License

[MIT](./LICENSE) — free to use, fork, and adapt. If you build something cool with it, a mention is appreciated. 🙂

---

*Built on top of Claude Code. Not affiliated with Anthropic.*
