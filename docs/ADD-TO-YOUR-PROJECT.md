# Adding Pixel Agent Office to your project

You don't copy this tool *into* your repo — you keep it separate and **point it at**
your repo with `--project`. That keeps your project clean and lets one office drive
many repos.

## 1. One-time setup

```bash
git clone https://github.com/pruthiviraj/pixel-agent-office.git
cd pixel-agent-office
# nothing to install — pure Node. Just make sure Claude Code is on PATH:
claude --version            # need 2.1.141+
```

## 2. Start the office (the viewer)

```bash
node server.js              # http://localhost:4040   (add ?demo=1 for sample data)
```

## 3. Write an epic

An epic is a plain-English description of the work — see
[`examples/sample-epic.md`](../examples/sample-epic.md). Outcome-focused is best;
let the PM agent decide the task breakdown.

## 4. Run a sprint on your repo

```bash
node orchestrate.js \
  --project /path/to/your/repo \
  --epic ./my-epic.md \
  --profile software            # or your own profile; see ../profiles/README.md
```

Watch the team build it in the office tab. When it finishes, review the diff in
your repo and commit what you want to keep.

> **Run it on a branch.** Workers edit real files and (with `ORCH_SKIP_PERMISSIONS=1`)
> run your shell/test commands. Treat a sprint like a very productive, slightly
> reckless contributor: review before you merge.

## 5. (Optional) Let an AI assistant launch it for you

Drop this into your repo's `AGENTS.md` or `CLAUDE.md` so an assistant knows the tool
exists and how to drive it:

```md
## Pixel Agent Office (multi-agent sprints)
This repo can be built by a Claude Code agent team via Pixel Agent Office
(cloned at <PATH-TO>/pixel-agent-office). To run a sprint:
1. Start the viewer:  `node <PATH-TO>/pixel-agent-office/server.js`  (http://localhost:4040)
2. Write the work as an epic markdown file.
3. Run:
   `node <PATH-TO>/pixel-agent-office/orchestrate.js --project . --epic ./epic.md --profile <profile>`
Use `--dry-run` first to preview the task breakdown with no API spend.
Always run on a branch; review the diff before merging.
```

## Tips

- **Concurrency:** `ORCH_CONCURRENCY=5` runs more devs at once (more API usage).
- **Reworks:** `ORCH_MAX_RETRIES=2` is the dev↔QA loop budget per task.
- **Cheaper workers:** `ORCH_MODEL=claude-sonnet-4-6` for routine tasks.
- **Lessons:** after sprints you'll see a `.orch-lessons.md` grow in your repo — the
  team's accumulated "scar tissue". Keep it; it makes future sprints smarter. Delete
  lines that are no longer true.
