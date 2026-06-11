#!/usr/bin/env node
/**
 * Pixel Agent Office — CLI
 * -----------------------------------------------------------------
 * One entry point, npx-friendly. Install/run with a single line:
 *
 *   npx github:pruthiviraj/pixel-agent-office              # start the office viewer
 *   npx github:pruthiviraj/pixel-agent-office demo         # viewer + sample data
 *   npx github:pruthiviraj/pixel-agent-office init         # scaffold an epic in YOUR repo
 *   npx github:pruthiviraj/pixel-agent-office sprint --epic ./epic.md
 *                                                          # run a sprint on the cwd repo
 *
 * `sprint` passes every flag through to orchestrate.js and defaults
 * --project to the directory you run it from, so the natural flow is:
 *   cd your-project && npx github:pruthiviraj/pixel-agent-office sprint --epic ./epic.md
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HERE = __dirname;
const PORT = process.env.PORT || 4040;
const argv = process.argv.slice(2);
const KNOWN = new Set(["office", "start", "demo", "sprint", "init", "install-command", "uninstall-command", "help"]);
// first positional that isn't a known command → treat as a sprint epic
// (so `npx pao "build a discount engine"` Just Works)
let cmd = "office";
let rest = argv.slice();
if (argv[0] && !argv[0].startsWith("-")) {
  if (KNOWN.has(argv[0])) { cmd = argv[0]; rest = argv.slice(1); }
  else { cmd = "sprint"; rest = argv.slice(); }
}

function run(script, args, opts = {}) {
  const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
    stdio: "inherit",
    env: process.env,
    cwd: opts.cwd || process.cwd(),
  });
  child.on("exit", (code) => process.exit(code || 0));
}

function openBrowser(url) {
  // best effort, never fatal
  const p = process.platform;
  const c = p === "win32" ? ["cmd", ["/c", "start", "", url]]
    : p === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try { spawn(c[0], c[1], { stdio: "ignore", detached: true }).unref(); } catch {}
}

const EPIC_TEMPLATE = `# Epic: <one-line goal>

> Plain-English description of the work. The PM agent reads this and breaks it
> into parallel dev + QA tasks. Outcome-focused beats prescriptive.

## Goal
What should be true for users when this ships?

## What "done" looks like
- Observable, checkable outcomes (the QA agents verify against these).
- ...

## Out of scope
- Things the team must NOT touch in this sprint.

## Notes
- Follow the existing project conventions and test setup.
`;

// Markdown body for the Claude Code slash command we install at
// ~/.claude/commands/sprint.md. Claude Code reads this file and exposes
// `/sprint <args>` in any conversation; `$ARGUMENTS` becomes the user's text.
const SLASH_COMMAND = `---
description: Run a Pixel Agent Office sprint on the current repo (PM → devs → QA, live pixel office UI).
allowed-tools: Bash, Read
---

The user wants a multi-agent Pixel Agent Office sprint in their current repo.

Sprint goal: $ARGUMENTS

Follow this exact protocol:

1. **Plan-only first** to preview the REAL task breakdown for this goal (one
   cheap PM call — writes no code, creates no branch):
   \`\`\`
   npx -y github:pruthiviraj/pixel-agent-office sprint "$ARGUMENTS" --plan-only
   \`\`\`
   Show the user the planned tasks and ask them to confirm. The stack profile is
   auto-detected (an SFDX repo uses the salesforce profile). NOTE: --dry-run is a
   UI/HUD demo that shows a canned sample plan, NOT your goal — don't use it to
   preview real work.

2. **On approval, run for real**. This auto-creates an \`agent/run-*\` branch and
   refuses to touch main/master or a dirty worktree:
   \`\`\`
   npx -y github:pruthiviraj/pixel-agent-office sprint "$ARGUMENTS"
   \`\`\`
   Live viewer: http://localhost:4040 (start with \`npx -y github:pruthiviraj/pixel-agent-office\` in another terminal).

3. **After it finishes**, run \`git status\` and \`git diff main...HEAD\` so the user
   can review the agent's work before merging.

Rules:
- Never pass \`ORCH_SKIP_PERMISSIONS=1\` unless the user explicitly asks (and only with \`--i-understand-risk\`).
- If the repo is dirty, ask the user to commit/stash first instead of using \`--allow-dirty\`.
- If \`$ARGUMENTS\` is empty, ask the user what they want the sprint to build.
`;

const AGENTS_SNIPPET = `
## Pixel Agent Office (multi-agent sprints)
This repo can be built by a Claude Code agent team via Pixel Agent Office.
To run a sprint from the repo root:
  npx github:pruthiviraj/pixel-agent-office sprint --epic ./epic.md
Viewer: npx github:pruthiviraj/pixel-agent-office   (http://localhost:4040)
Use --plan-only first to preview the real task breakdown for your goal (cheap,
writes no code). (--dry-run is only a UI demo with a canned sample plan.)
Always run on a branch; review the diff before merging.
`;

switch (cmd) {
  case "office":
  case "start": {
    console.log(`\n  Pixel Agent Office`);
    console.log(`  → viewer on http://localhost:${PORT}  (Ctrl-C to stop)`);
    console.log(`  → sample data: http://localhost:${PORT}/?demo=1`);
    console.log(`\n  Run a sprint from your project directory:`);
    console.log(`    npx github:pruthiviraj/pixel-agent-office sprint --epic ./epic.md\n`);
    run("server.js", []);
    break;
  }

  case "demo": {
    console.log(`\n  Pixel Agent Office — demo`);
    console.log(`  → http://localhost:${PORT}/?demo=1\n`);
    setTimeout(() => openBrowser(`http://localhost:${PORT}/?demo=1`), 800);
    run("server.js", []);
    break;
  }

  case "sprint": {
    // default --project to the caller's cwd so `cd your-repo && ... sprint --epic ./epic.md` just works
    const args = rest.slice();
    // accept a positional epic: `sprint ./epic.md` or `sprint "build a discount engine"`
    if (args[0] && !args[0].startsWith("-") && !args.includes("--epic")) {
      args.unshift("--epic", args.shift());
    }
    if (!args.includes("--project") && !process.env.ORCH_PROJECT) {
      args.push("--project", process.cwd());
    }
    run("orchestrate.js", args);
    break;
  }

  case "install-command": {
    // Drop a Claude Code slash command into ~/.claude/commands/ so users can just type
    // `/sprint <goal>` inside Claude Code and it runs Pixel Agent Office on their repo.
    const dir = path.join(os.homedir(), ".claude", "commands");
    const target = path.join(dir, "sprint.md");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      console.error("  could not create " + dir + ": " + e.message); process.exit(1);
    }
    fs.writeFileSync(target, SLASH_COMMAND);
    console.log(`  ✓ installed Claude Code slash command at ${target}`);
    console.log(`    Open Claude Code in your project and type:  /sprint <your goal>`);
    console.log(`    (uninstall with: pixel-agent-office uninstall-command)\n`);
    break;
  }
  case "uninstall-command": {
    const target = path.join(os.homedir(), ".claude", "commands", "sprint.md");
    try { fs.unlinkSync(target); console.log(`  ✓ removed ${target}`); }
    catch (e) { console.log(`  nothing to remove at ${target}`); }
    break;
  }

  case "init": {
    // scaffold into the USER'S project (cwd), never into the tool itself
    const target = path.join(process.cwd(), "epic.md");
    if (fs.existsSync(target)) {
      console.log(`  epic.md already exists here — not overwriting.`);
    } else {
      fs.writeFileSync(target, EPIC_TEMPLATE);
      console.log(`  ✓ wrote epic.md — describe your goal in it.`);
    }
    console.log(`\n  Optional: add this to your repo's AGENTS.md / CLAUDE.md so AI assistants`);
    console.log(`  know how to launch sprints here:\n${AGENTS_SNIPPET}`);
    console.log(`  Next:`);
    console.log(`    1. edit epic.md`);
    console.log(`    2. npx github:pruthiviraj/pixel-agent-office sprint --epic ./epic.md --dry-run`);
    console.log(`    3. drop --dry-run when the plan looks right (runs real agents)\n`);
    break;
  }

  case "help":
  default: {
    console.log(`
  Pixel Agent Office — a live pixel office where Claude Code agents build your project

  Usage:
    npx github:pruthiviraj/pixel-agent-office [command|<epic>]

  Commands:
    (none) | office       start the office viewer        http://localhost:4040
    demo                  viewer + sample data (opens browser)
    init                  scaffold epic.md + AGENTS.md snippet in the current repo
    sprint <epic>         run a PM→dev→QA sprint (positional epic = file or text)
    install-command       add /sprint to Claude Code (~/.claude/commands/sprint.md)
    uninstall-command     remove the /sprint slash command
    help                  this help

  Shortcuts:
    npx github:pruthiviraj/pixel-agent-office "build a discount engine"
                              # same as: sprint "build a discount engine"

  Preview:  --plan-only   real PM breakdown of your goal, no code/branch (cheap)
            --dry-run     UI/HUD demo only — canned sample plan, ignores your goal
  Safety flags (sprint): --allow-main --allow-dirty --no-branch
                         --i-understand-risk        (required with ORCH_SKIP_PERMISSIONS=1)
  See README for the full env-var surface.
`);
    if (cmd !== "help") process.exit(1);
  }
}
