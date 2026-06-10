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
const path = require("path");

const HERE = __dirname;
const PORT = process.env.PORT || 4040;
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "office";
const rest = cmd === argv[0] ? argv.slice(1) : argv;

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

const AGENTS_SNIPPET = `
## Pixel Agent Office (multi-agent sprints)
This repo can be built by a Claude Code agent team via Pixel Agent Office.
To run a sprint from the repo root:
  npx github:pruthiviraj/pixel-agent-office sprint --epic ./epic.md
Viewer: npx github:pruthiviraj/pixel-agent-office   (http://localhost:4040)
Use --dry-run first to preview the task breakdown with no API spend.
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
    if (!args.includes("--project") && !process.env.ORCH_PROJECT) {
      args.push("--project", process.cwd());
    }
    run("orchestrate.js", args);
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
    npx github:pruthiviraj/pixel-agent-office [command]

  Commands:
    (none) | office   start the office viewer            http://localhost:4040
    demo              viewer + sample data (opens browser)
    init              scaffold epic.md into the current repo + AGENTS.md snippet
    sprint [flags]    run a PM→dev→QA sprint (flags pass through to orchestrate.js;
                      --project defaults to the current directory)
    help              this help

  Sprint flags: --epic <file|text> --profile <name> --dry-run   (see README for env vars)
`);
    if (cmd !== "help") process.exit(1);
  }
}
