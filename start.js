#!/usr/bin/env node
/**
 * Pixel Agent Office — launcher
 * -----------------------------------------------------------------
 * Starts the pixel office web server (server.js) so you can watch your
 * agents at http://localhost:4040. Kicking off a sprint stays a separate,
 * deliberate step (it spends API quota and edits your repo):
 *
 *   node orchestrate.js --project /path/to/project --epic ./examples/sample-epic.md
 *
 * This launcher only starts the viewer. It is idempotent-ish: if the port
 * is busy it just exits and you keep the office you already have open.
 */
"use strict";
const { spawn } = require("child_process");
const path = require("path");

const PORT = process.env.PORT || 4040;
const server = path.join(__dirname, "server.js");

console.log(`\n  Pixel Agent Office`);
console.log(`  → starting the office viewer on http://localhost:${PORT}`);
console.log(`  → open http://localhost:${PORT}/?demo=1 for a sample office (no agents needed)`);
console.log(`\n  Run a sprint in another terminal:`);
console.log(`    node orchestrate.js --project /path/to/project --epic ./examples/sample-epic.md\n`);

const child = spawn(process.execPath, [server], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code || 0));
