# Contributing to Pixel Agent Office

Thanks for wanting to help! This project is deliberately small and hackable — please keep it that way.

## The zero-dependency principle

**No npm dependencies. None.** The whole project is pure Node 18+ stdlib (CommonJS), a single HTML canvas, and no build step. PRs that add a package — even a tiny one — will be asked to inline the ~20 lines they actually needed. This is what keeps the project clone-and-run on any machine (Windows included) and trivially auditable, which matters for a tool that spawns agents that edit real repos.

House style: 2-space indent, compact, CommonJS (`require`), match the file you're editing.

## How to run it

```bash
git clone https://github.com/pruthiviraj/pixel-agent-office.git
cd pixel-agent-office

node server.js                 # viewer → http://localhost:4040 (?demo=1 for sample data)
npm run dry-run                # orchestration loop with mocked agents — no API spend
node orchestrate.js --project /path/to/repo --epic ./examples/sample-epic.md   # the real thing
```

A real sprint needs [Claude Code](https://claude.com/claude-code) on your `PATH`. Everything else (viewer, demo mode, dry-run) works with plain Node.

## How to test

There is no test framework (see principle above). The bar for a PR is:

```bash
npm run smoke
```

which syntax-checks `orchestrate.js` and `server.js` and runs a full dry-run sprint. CI runs the same command on Ubuntu + Windows, Node 18 + 20 — please make sure your change passes on Windows path/spawn semantics too (no `sh -c`-isms, no hardcoded `/`).

For UI changes, open `http://localhost:4040/?demo=1` and eyeball the office; for engine changes, run a dry-run and check `data/team.json` and `data/history/` look sane.

## What contributions are welcome

- **Profiles, especially.** A profile is a small object in `profiles/` that briefs the agents for a stack (see `profiles/README.md` — it's a 2-minute copy-and-edit). Profiles for Python/Django, Rails, Go, mobile, data… all welcome. They're the lowest-risk, highest-value contribution.
- Bug fixes with a dry-run or demo-mode reproduction.
- Viewer polish (themes, animations, presentation mode) — keep it canvas + vanilla JS.
- Docs that shorten someone's time-to-first-sprint.

For anything that changes the engine ↔ server ↔ UI contract (`data/team.json`, `data/control.json`, the `/api/*` routes), open an issue first — those shapes are load-bearing and intentionally backward-compatible.

## Ground rules

- Don't break `?demo=1` — it's the zero-setup showcase.
- Don't make the orchestrator deploy anything to production. Ever.
- Keep new state files inside `data/` (it's git-ignored).
- One concern per PR, with a sentence on how you verified it.
