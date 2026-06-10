#!/usr/bin/env node
/**
 * Pixel Agent Office — Orchestrator
 * ===========================================================================
 * A real coordination layer for a team of Claude Code agents on ANY project.
 * One PM agent plans; developer agents implement in parallel; each finished
 * piece is handed to a QA agent that verifies it and votes PASS / FAIL;
 * failures loop back to the developer with the QA feedback. Lessons learned
 * from QA failures are remembered and injected into future prompts.
 *
 * It drives the team with headless `claude -p` worker processes (each is a
 * full Claude Code agent that can edit files and run commands), and streams
 * the whole team's live state into data/team.json so the pixel office
 * (server.js) shows the PM, devs and testers working + handing off.
 *
 *   node orchestrate.js --project "/path/to/project" --epic ./epic.md
 *   node orchestrate.js --project . --epic "Add a discount engine to checkout"
 *   node orchestrate.js --epic ./epic.md --dry-run            # no API spend
 *   node orchestrate.js --epic ./epic.md --profile salesforce # specialise stack
 *
 * Flags / env:
 *   --project <dir>  | ORCH_PROJECT      project the agents work in (default .)
 *   --epic <file|text> | ORCH_EPIC       the work to break down & build
 *   --profile <name> | ORCH_PROFILE      stack profile in ./profiles (default "software")
 *   --dry-run        | ORCH_DRYRUN=1     mock the claude calls (test the loop;
 *                                        simulates cost/tokens so the HUD demos)
 *   ORCH_CONCURRENCY=3                   max workers running at once
 *   ORCH_MAX_RETRIES=2                   dev<->QA rework attempts per task
 *   ORCH_PERMISSION_MODE=acceptEdits     permission mode for worker agents
 *   ORCH_SKIP_PERMISSIONS=1              add --dangerously-skip-permissions
 *                                        (needed for full autonomy incl. shell)
 *   ORCH_MODEL=claude-sonnet-4-6         model for worker agents (optional)
 *   ORCH_TIMEOUT_MIN=30                  per-worker timeout
 *   ORCH_BUDGET_USD=5.00                 hard cost cap for the sprint — once total
 *                                        spend reaches the cap, no new tasks are
 *                                        dispatched; remaining planned tasks are
 *                                        marked "cancelled" (note "budget cap")
 *                                        and the sprint finishes
 *   ORCH_WEBHOOK_URL=https://...         on sprint completion, POST the final run
 *                                        history JSON to this URL (http/https,
 *                                        5s timeout, errors ignored)
 *
 * Engine surface (consumed by server.js / the office UI):
 *   data/team.json               live state: runId, paused, phase, budget
 *                                {capUsd, spentUsd}, totals {tasksDone,
 *                                tasksFailed, tokensIn, tokensOut, costUsd,
 *                                startedAt, tasksPerHour}, workers[] with
 *                                costUsd/tokensIn/tokensOut/model/room, board[]
 *                                (planned|dev|qa|done|failed|cancelled)
 *   data/control.json            UI -> engine commands (appended by server.js):
 *                                pause / resume / cancel / retry / force-pass /
 *                                force-fail. Polled ~2s; executed commands are
 *                                acked in data/control-ack.json {"acked":[ids]}
 *                                and removed from control.json
 *   data/history/<runId>.json    run record (written incrementally, finalized
 *                                with endedAt at sprint end) — powers replay
 *
 * Worker cost capture: workers run with `--output-format json`; the engine
 * parses stdout for result text + total_cost_usd + usage tokens, and falls
 * back to treating stdout as plain text on older CLIs.
 * ===========================================================================
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFile, spawnSync } = require("child_process");

// ---------- config ----------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : undefined;
}
const DATA_DIR     = path.join(__dirname, "data");
const TEAM_FILE    = path.join(DATA_DIR, "team.json");
const CONTROL_FILE = path.join(DATA_DIR, "control.json");
const ACK_FILE     = path.join(DATA_DIR, "control-ack.json");
const HISTORY_DIR  = path.join(DATA_DIR, "history");
const DRY        = !!flag("dry-run") || process.env.ORCH_DRYRUN === "1";
const PROJECT    = path.resolve(flag("project") || process.env.ORCH_PROJECT || ".");
const CAP        = +(process.env.ORCH_CONCURRENCY || 3);
const MAX_RETRY  = +(process.env.ORCH_MAX_RETRIES || 2);
const PMODE      = process.env.ORCH_PERMISSION_MODE || "acceptEdits";
const SKIP       = process.env.ORCH_SKIP_PERMISSIONS === "1";
const MODEL      = process.env.ORCH_MODEL || "";
const TIMEOUT    = +(process.env.ORCH_TIMEOUT_MIN || 30) * 60000;
const BUDGET     = process.env.ORCH_BUDGET_USD !== undefined && process.env.ORCH_BUDGET_USD !== ""
  ? +process.env.ORCH_BUDGET_USD : null;
const WEBHOOK    = process.env.ORCH_WEBHOOK_URL || "";
// safety flags (preflight)
const ALLOW_MAIN   = !!flag("allow-main")   || process.env.ORCH_ALLOW_MAIN === "1";
const ALLOW_DIRTY  = !!flag("allow-dirty")  || process.env.ORCH_ALLOW_DIRTY === "1";
const ALLOW_NOGIT  = !!flag("allow-no-git") || process.env.ORCH_ALLOW_NO_GIT === "1";
const NO_BRANCH    = !!flag("no-branch")    || process.env.ORCH_NO_BRANCH === "1";
const RISK_ACK     = !!flag("i-understand-risk") || process.env.ORCH_I_UNDERSTAND_RISK === "1";

// ---------- stack profile (how we talk to the agents) -----------------------
function loadProfile() {
  const name = String(flag("profile") || process.env.ORCH_PROFILE || "software").trim();
  const file = path.join(__dirname, "profiles", name + ".js");
  if (!fs.existsSync(file)) {
    console.error(`Profile not found: ${name} (looked for ${file}).\n` +
      `Available: ${fs.readdirSync(path.join(__dirname, "profiles")).filter(f => f.endsWith(".js")).map(f => f.slice(0, -3)).join(", ")}`);
    process.exit(1);
  }
  return require(file);
}
const PROFILE = loadProfile();
// replace {PROJECT} in any profile string with the absolute project path
const fill = (s) => String(s || "").replace(/\{PROJECT\}/g, PROJECT);

function loadEpic() {
  const raw = flag("epic") || process.env.ORCH_EPIC || "";
  if (raw && raw !== true && fs.existsSync(raw)) return fs.readFileSync(raw, "utf8").trim();
  if (raw && raw !== true) return String(raw).trim();
  return "";
}
const EPIC = loadEpic();

// ---------- locate git bash so `claude` works on Windows --------------------
function findGitBash() {
  const env = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (env && fs.existsSync(env)) return env;
  const c = [
    path.join(process.env.LOCALAPPDATA || "", "Programs/Git/bin/bash.exe"),
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
    path.join(process.env.ProgramW6432 || "", "Git/bin/bash.exe"),
  ];
  for (const p of c) if (p && fs.existsSync(p)) return p;
  return env || "";
}
const GITBASH = findGitBash();

// Resolve the real `claude` binary (on Windows the PATH entry is a .cmd shim
// that execFile can't run without a shell — target the native .exe instead).
function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  if (process.platform !== "win32") return "claude";
  const cands = [];
  if (process.env.APPDATA) {
    cands.push(path.join(process.env.APPDATA, "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"));
    cands.push(path.join(process.env.APPDATA, "npm/claude.exe"));
  }
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    cands.push(path.join(d, "claude.exe"));
    cands.push(path.join(d, "node_modules/@anthropic-ai/claude-code/bin/claude.exe"));
  }
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return "claude";
}
const CLAUDE_BIN = findClaude();

// ---------- run + team state written for the dashboard -----------------------
const RUN_ID = "run-" + Date.now();
const STARTED_AT = Date.now();
let endedAt = null;
let paused = false;          // pause: stop dispatching NEW tasks (running finish)
let cancelled = false;       // cancel: kill workers, cancel non-done tasks, finish
const children = {};         // worker id -> ChildProcess handle (so cancel can kill)
const events = [];           // { at, msg } — the note() log with timestamps
const workers = {};          // id -> { id,name,team,room,status,summary,cwd,startedAt,role,costUsd,tokensIn,tokensOut,model }
const logs = {};             // id -> captured worker output (capped)
const log = [];              // human-readable event log
let summary = "";            // PM's one-line plan summary
let phase = "planning";      // planning | building | done

function note(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  log.push(line);
  events.push({ at: Date.now(), msg });
  console.log(line);
}
const ROOM = { pm: "planning", developer: "dev", tester: "qa" };
function setWorker(id, patch) {
  const w = { ...(workers[id] || {}), id, ...patch };
  if (!w.room) w.room = ROOM[w.role] || "dev";
  if (w.costUsd == null) w.costUsd = 0;
  if (w.tokensIn == null) w.tokensIn = 0;
  if (w.tokensOut == null) w.tokensOut = 0;
  if (w.model == null) w.model = MODEL || "";
  workers[id] = w;
}
const round4 = (n) => Math.round((+n || 0) * 10000) / 10000;
function applyUsage(id, res) {
  if (!res) return;
  const w = workers[id] || {};
  setWorker(id, {
    costUsd: round4((w.costUsd || 0) + (res.costUsd || 0)),
    tokensIn: (w.tokensIn || 0) + (res.tokensIn || 0),
    tokensOut: (w.tokensOut || 0) + (res.tokensOut || 0),
    model: res.model || w.model || MODEL || "",
  });
}
function spentUsd() {
  return round4(Object.values(workers).reduce((s, w) => s + (w.costUsd || 0), 0));
}
function computeTotals() {
  const done = tasks.filter((t) => t.state === "done").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  let tin = 0, tout = 0;
  for (const w of Object.values(workers)) { tin += w.tokensIn || 0; tout += w.tokensOut || 0; }
  const hrs = Math.max(((endedAt || Date.now()) - STARTED_AT) / 3600000, 1e-9);
  return {
    tasksDone: done, tasksFailed: failed, tokensIn: tin, tokensOut: tout,
    costUsd: spentUsd(), startedAt: STARTED_AT,
    tasksPerHour: done ? Math.round((done / hrs) * 10) / 10 : 0,
  };
}
function boardView() {
  return tasks.map((t) => ({
    id: t.id, title: t.title, state: t.state, retries: t.retries,
    deps: t.deps, components: t.components, note: t.notes || "",
  }));
}
function writeState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = {
    active: phase !== "done",
    updatedAt: Date.now(),
    runId: RUN_ID, paused, cancelled,
    budget: { capUsd: BUDGET, spentUsd: spentUsd() },
    totals: computeTotals(),
    project: PROJECT, epic: EPIC, profile: PROFILE.name, summary, phase,
    workers: Object.values(workers),
    board: boardView(),
    log: log.slice(-60),
  };
  fs.writeFileSync(TEAM_FILE, JSON.stringify(out, null, 2));
  // logs served by the dashboard drawer (separate file to keep team.json lean)
  fs.writeFileSync(path.join(DATA_DIR, "team-logs.json"), JSON.stringify(logs));
  writeHistory();
}

// ---------- run history (data/history/<runId>.json, replayable) -------------
function writeHistory() {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const doc = {
      runId: RUN_ID, startedAt: STARTED_AT, endedAt,
      epic: EPIC, profile: PROFILE.name, project: PROJECT, summary,
      totals: computeTotals(),
      budget: { capUsd: BUDGET, spentUsd: spentUsd() },
      board: boardView(),
      workers: Object.values(workers),
      events,
    };
    fs.writeFileSync(path.join(HISTORY_DIR, RUN_ID + ".json"), JSON.stringify(doc, null, 2));
    return doc;
  } catch (e) { return null; }
}

// ---------- completion webhook (ORCH_WEBHOOK_URL) ----------------------------
function postWebhook(payload, cb) {
  let fired = false;
  const fin = () => { if (!fired) { fired = true; if (cb) cb(); } };
  if (!WEBHOOK || !payload) return fin();
  try {
    const u = new URL(WEBHOOK);
    const mod = u.protocol === "https:" ? https : http;
    const body = JSON.stringify(payload);
    const req = mod.request(u, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => { res.resume(); res.on("end", fin); res.on("error", fin); });
    req.on("timeout", () => { try { req.destroy(); } catch {} fin(); });
    req.on("error", fin);
    req.end(body);
    note(`↗ webhook: POSTing run history to ${u.hostname}`);
  } catch { fin(); }
}

// ---------- the claude worker primitive -------------------------------------
function runWorker(prompt, w) {
  if (DRY) return mockWorker(w);
  return new Promise((resolve) => {
    // --dangerously-skip-permissions IS a permission mode (bypass), so don't also
    // pass --permission-mode; they're mutually exclusive.
    const args = SKIP
      ? ["-p", prompt, "--name", w.name, "--dangerously-skip-permissions"]
      : ["-p", prompt, "--name", w.name, "--permission-mode", PMODE];
    args.push("--output-format", "json"); // cost/token capture (plain-text fallback below)
    if (MODEL) args.push("--model", MODEL);
    const env = { ...process.env };
    if (GITBASH) env.CLAUDE_CODE_GIT_BASH_PATH = GITBASH;
    const child = execFile(CLAUDE_BIN, args, { cwd: PROJECT, env, timeout: TIMEOUT, maxBuffer: 24 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (w && w.id) delete children[w.id];
        const parsed = parseWorkerOutput(stdout || "");
        const text = (parsed.text + (stderr ? "\n--- stderr ---\n" + stderr : "")).trim();
        resolve({ ok: !err, out: text, code: err && err.code,
          costUsd: parsed.costUsd, tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, model: parsed.model });
      });
    if (w && w.id) children[w.id] = child; // keep the handle so cancel can kill()
  });
}
// `claude -p --output-format json` prints one JSON object with the final text in
// `result` plus `total_cost_usd` and `usage` token counts. Older CLIs (or any
// parse failure) degrade gracefully to plain-text stdout with zero cost.
function parseWorkerOutput(stdout) {
  const out = String(stdout || "").trim();
  let j = null;
  try { j = JSON.parse(out); } catch {
    const a = out.indexOf("{"), b = out.lastIndexOf("}");
    if (a >= 0 && b > a) { try { j = JSON.parse(out.slice(a, b + 1)); } catch {} }
  }
  if (j && typeof j === "object" &&
      (j.result !== undefined || j.total_cost_usd !== undefined || j.usage)) {
    const u = j.usage || {};
    return {
      text: typeof j.result === "string" ? j.result : JSON.stringify(j.result == null ? "" : j.result),
      costUsd: +j.total_cost_usd || 0,
      tokensIn: (+u.input_tokens || 0) + (+u.cache_creation_input_tokens || 0) + (+u.cache_read_input_tokens || 0),
      tokensOut: +u.output_tokens || 0,
      model: j.model || (j.modelUsage && Object.keys(j.modelUsage)[0]) || MODEL || "",
    };
  }
  return { text: out, costUsd: 0, tokensIn: 0, tokensOut: 0, model: MODEL || "" };
}
// dry-run cost/token simulation so ?demo and dry-runs show a live HUD
function simUsage() {
  return {
    costUsd: round4(0.10 + Math.random() * 0.50),                 // $0.10–$0.60
    tokensIn: 4000 + Math.floor(Math.random() * 26000),           // ~5k–40k total
    tokensOut: 1000 + Math.floor(Math.random() * 10000),
    model: MODEL || "claude (dry-run)",
  };
}
// dry-run stand-in: realistic timing, QA fails ~once then passes on retry
function mockWorker(w) {
  return new Promise((resolve) => {
    const ms = 1500 + Math.random() * 3500;
    setTimeout(() => {
      const usage = simUsage();
      if (w.role === "tester") {
        const t = tasks.find((x) => x.id === w.taskId);
        const pass = (t && t.retries > 0) || Math.random() > 0.4;
        resolve({
          ok: true, ...usage,
          out: pass
            ? `Ran the project's tests for ${w.taskId}. All green.\nVERDICT: PASS`
            : `Failing assertion / missing edge case in ${w.taskId}. Fix the null-check path.\nVERDICT: FAIL — add guard + test`,
        });
      } else {
        resolve({ ok: true, ...usage, out: `(dry-run) implemented ${w.taskId} — edited components, added a test.` });
      }
    }, ms);
  });
}

// ---------- PM planning -----------------------------------------------------
const PLAN_PROMPT = (epic) =>
`You are the PROJECT MANAGER / tech lead for ${PROFILE.stackLabel} at:
${PROJECT}

Break this epic into a minimal set of INDEPENDENT, parallelizable implementation
tasks for a team of Claude developer agents — each paired with a QA verification
task for a tester agent.

EPIC:
${epic}

Return ONLY a JSON object (no prose, no markdown fences) matching exactly:
{
  "summary": "one line plan summary",
  "tasks": [
    {
      "id": "T1",
      "title": "short imperative title",
      "description": "what the developer must build, ${PROFILE.taskDescriptionHint}",
      "components": ["file / module / component names"],
      "acceptance": ["checkable acceptance criteria"],
      "deps": [],
      "qa": { "title": "verify ...", "checks": ["how to verify, using the project's own commands"] }
    }
  ]
}
Rules: ids T1,T2,...; deps reference only earlier ids; 3-7 tasks; realistic
components for this codebase; acceptance criteria must be objectively checkable.`;

async function planEpic() {
  setWorker("pm", { name: `pm: ${shorten(EPIC, 40)}`, team: "planning", status: "working",
    summary: "decomposing the epic into tasks…", cwd: PROJECT, startedAt: Date.now(), role: "pm" });
  writeState();
  note("PM is planning the epic…");
  let plan;
  if (DRY) {
    await new Promise((r) => setTimeout(r, 1200));
    applyUsage("pm", simUsage());
    plan = PROFILE.examplePlan;
  } else {
    const res = await runWorker(PLAN_PROMPT(EPIC), workers["pm"]);
    applyUsage("pm", res);
    if (cancelled) { finishSprint(); return; }
    plan = parsePlan(res.out);
    if (!plan) { note("⚠ PM did not return parseable JSON. Raw output saved to data/pm-output.txt");
      fs.writeFileSync(path.join(DATA_DIR, "pm-output.txt"), res.out); process.exit(1); }
  }
  if (cancelled) { finishSprint(); return; }
  summary = plan.summary || "";
  for (const t of plan.tasks) {
    tasks.push({ id: t.id, title: t.title, description: t.description || "", components: t.components || [],
      acceptance: t.acceptance || [], deps: t.deps || [], qa: t.qa || { title: "verify " + t.title, checks: [] },
      state: "planned", retries: 0, devOut: "", qaOut: "", notes: "" });
  }
  setWorker("pm", { status: "working", summary: `${tasks.length} tasks planned · supervising` });
  note(`PM planned ${tasks.length} tasks: ${tasks.map((t) => t.id).join(", ")}`);
  writeState();
}
function parsePlan(text) {
  try {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < 0) return null;
    const obj = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(obj.tasks) ? obj : null;
  } catch { return null; }
}

// ---------- scheduler: dev -> QA -> (rework) -> done -------------------------
const tasks = [];
let running = 0;
let resolveAll;
const allDone = new Promise((r) => (resolveAll = r));
const TERMINAL = ["done", "failed", "cancelled"];

function depsOk(t) { return t.deps.every((d) => { const x = tasks.find((y) => y.id === d); return x && x.state === "done"; }); }
function depFailed(t) { return t.deps.some((d) => { const x = tasks.find((y) => y.id === d); return x && (x.state === "failed" || x.state === "cancelled"); }); }

function schedule() {
  if (cancelled) { checkDone(); writeState(); return; }
  // budget cap: stop dispatching, cancel anything still planned, let in-flight finish
  if (BUDGET != null && spentUsd() >= BUDGET) {
    for (const t of tasks) if (t.state === "planned") {
      t.state = "cancelled"; t.notes = "budget cap";
      note(`✗ ${t.id} cancelled — budget cap ($${BUDGET.toFixed(2)}) reached`);
    }
  }
  // fail tasks whose dependency failed / was cancelled
  for (const t of tasks) if (t.state === "planned" && depFailed(t)) {
    t.state = "failed"; t.notes = "blocked: a dependency failed";
    note(`✗ ${t.id} blocked — dependency failed`);
  }
  // dispatch ready dev work up to the concurrency cap (unless operator paused)
  if (!paused) {
    for (const t of tasks) {
      if (running >= CAP) break;
      if (t.state === "planned" && depsOk(t)) startDev(t);
    }
  }
  checkDone();
  writeState();
}

function startDev(t) {
  t.state = "dev"; running++;
  const id = `${t.id}-dev`;
  setWorker(id, { name: `dev: ${t.title}`, team: "developer", status: "working",
    summary: t.retries ? `reworking (attempt ${t.retries + 1}) — ${t.notes}` : t.description,
    cwd: PROJECT, startedAt: Date.now(), role: "developer", taskId: t.id });
  note(`→ DEV  ${t.id} "${t.title}"${t.retries ? ` (rework #${t.retries})` : ""}`);
  writeState();
  runWorker(devPrompt(t), workers[id]).then((res) => {
    running--;
    applyUsage(id, res);
    t.devOut = cap(res.out); logs[id] = t.devOut;
    if (t.state !== "dev") { schedule(); return; } // cancelled / forced by operator mid-flight
    if (res.ok) { setWorker(id, { status: "completed", summary: "implemented · handing to QA" }); startQA(t); }
    else { setWorker(id, { status: "failed", summary: "worker error" }); failOrRetry(t, "developer process error"); }
    schedule();
  });
}

function startQA(t) {
  t.state = "qa"; running++;
  const id = `${t.id}-qa`;
  setWorker(id, { name: `test: ${t.qa.title}`, team: "tester", status: "working",
    summary: "verifying acceptance criteria…", cwd: PROJECT, startedAt: Date.now(), role: "tester", taskId: t.id });
  note(`→ QA   ${t.id} verifying`);
  writeState();
  runWorker(qaPrompt(t), workers[id]).then((res) => {
    running--;
    applyUsage(id, res);
    t.qaOut = cap(res.out); logs[id] = t.qaOut;
    if (t.state !== "qa") { schedule(); return; } // cancelled / forced by operator mid-flight
    const verdict = parseVerdict(res.out, res.ok);
    if (verdict === "pass") {
      t.state = "done";
      setWorker(id, { status: "completed", summary: "PASS ✓" });
      setWorker(`${t.id}-dev`, { status: "completed", summary: "shipped ✓" });
      note(`✓ DONE ${t.id} — QA passed`);
    } else {
      t.notes = firstFail(res.out);
      setWorker(id, { status: "failed", summary: "FAIL — " + t.notes });
      note(`✗ QA   ${t.id} failed — ${t.notes}`);
      appendLesson(t.title, t.notes);
      failOrRetry(t, t.notes);
    }
    schedule();
  });
}

function failOrRetry(t, reason) {
  if (t.retries < MAX_RETRY) {
    t.retries++; t.state = "planned";
    t.notes = reason;
    note(`↻ RETRY ${t.id} (attempt ${t.retries + 1}/${MAX_RETRY + 1})`);
  } else {
    t.state = "failed";
    setWorker(`${t.id}-dev`, { status: "failed", summary: "gave up after retries" });
    note(`✗ FAIL ${t.id} — exhausted ${MAX_RETRY} retries`);
  }
}

function checkDone() {
  if (phase === "done") return;
  if (tasks.length && tasks.every((t) => TERMINAL.includes(t.state))) {
    const ok = tasks.filter((t) => t.state === "done").length;
    const cn = tasks.filter((t) => t.state === "cancelled").length;
    const bad = tasks.length - ok - cn;
    setWorker("pm", { status: bad ? "needs_input" : "completed",
      summary: `sprint complete — ${ok} shipped, ${bad} failed${cn ? `, ${cn} cancelled` : ""}` });
    note(`■ SPRINT COMPLETE — ${ok} shipped, ${bad} failed${cn ? `, ${cn} cancelled` : ""}`);
    finishSprint();
  }
}

// finalize: stamp endedAt, persist state + history, fire the webhook, release main()
function finishSprint() {
  if (phase === "done") return;
  phase = "done";
  endedAt = Date.now();
  stopControl();
  writeState();
  const hist = writeHistory();
  postWebhook(hist, () => resolveAll());
}

// ---------- control channel (data/control.json -> engine) -------------------
// server.js appends { id, at, type, taskId?, reason? } commands; we poll ~2s,
// execute, record the ids in data/control-ack.json {"acked":[...]}, and remove
// the executed commands from control.json.
let controlTimer = null;
function startControl() { if (!controlTimer) controlTimer = setInterval(pollControl, 2000); }
function stopControl() { if (controlTimer) { clearInterval(controlTimer); controlTimer = null; } }

function pollControl() {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8")); } catch { return; }
  if (!doc || !Array.isArray(doc.commands) || !doc.commands.length) return;
  const executed = [];
  for (const c of doc.commands) {
    if (!c || !c.id) continue;
    try { execCommand(c); } catch (e) { note(`⚠ control "${c.type}" errored: ${e.message}`); }
    executed.push(c.id);
  }
  if (!executed.length) return;
  ackCommands(executed);
  // remove executed commands; re-read first so anything appended meanwhile survives
  let cur = { commands: [] };
  try {
    const d = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
    if (d && Array.isArray(d.commands)) cur = d;
  } catch {}
  cur.commands = cur.commands.filter((c) => !c || !executed.includes(c.id));
  try {
    const tmp = CONTROL_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
    fs.renameSync(tmp, CONTROL_FILE);
  } catch {}
  schedule();
}

function ackCommands(ids) {
  let acked = [];
  try {
    const d = JSON.parse(fs.readFileSync(ACK_FILE, "utf8"));
    if (d && Array.isArray(d.acked)) acked = d.acked;
  } catch {}
  acked = acked.concat(ids).slice(-500);
  try { fs.writeFileSync(ACK_FILE, JSON.stringify({ acked }, null, 2)); } catch {}
}

function execCommand(c) {
  const t = c.taskId ? tasks.find((x) => x.id === c.taskId) : null;
  switch (c.type) {
    case "pause":
      if (!paused && !cancelled) { paused = true; note(`⏸ PAUSED by operator${c.reason ? " — " + c.reason : ""} (running workers will finish)`); }
      break;
    case "resume":
      if (paused) { paused = false; note("▶ RESUMED by operator"); }
      break;
    case "cancel":
      doCancel(c.reason);
      break;
    case "retry":
      if (t && (t.state === "failed" || t.state === "cancelled")) {
        t.state = "planned"; t.retries = 0; t.notes = "";
        note(`↻ ${t.id} re-queued by operator${c.reason ? " — " + c.reason : ""}`);
      } else note(`⚠ retry ignored — ${c.taskId || "?"} not failed/cancelled`);
      break;
    case "force-pass":
      if (t && ["dev", "qa", "failed"].includes(t.state)) {
        killTask(t);
        t.state = "done"; t.notes = "forced by operator";
        setWorker(`${t.id}-dev`, { status: "completed", summary: "forced pass by operator" });
        if (workers[`${t.id}-qa`]) setWorker(`${t.id}-qa`, { status: "completed", summary: "forced pass by operator" });
        note(`✓ ${t.id} FORCE-PASSED by operator${c.reason ? " — " + c.reason : ""}`);
      } else note(`⚠ force-pass ignored — ${c.taskId || "?"} not in dev/qa/failed`);
      break;
    case "force-fail":
      if (t && t.state !== "done" && t.state !== "failed") {
        killTask(t);
        t.state = "failed"; t.notes = c.reason || "forced fail by operator";
        setWorker(`${t.id}-dev`, { status: "failed", summary: "forced fail by operator" });
        if (workers[`${t.id}-qa`]) setWorker(`${t.id}-qa`, { status: "failed", summary: "forced fail by operator" });
        note(`✗ ${t.id} FORCE-FAILED by operator${c.reason ? " — " + c.reason : ""}`);
      } else note(`⚠ force-fail ignored — ${c.taskId || "?"} not active`);
      break;
    default:
      note(`⚠ unknown control command: ${c.type}`);
  }
}

function killTask(t) {
  for (const id of [`${t.id}-dev`, `${t.id}-qa`]) {
    const ch = children[id];
    if (ch) { try { ch.kill(); } catch {} delete children[id]; }
  }
}

function doCancel(reason) {
  if (cancelled) return;
  cancelled = true; paused = false;
  note(`■ CANCELLED by operator${reason ? " — " + reason : ""}`);
  for (const id of Object.keys(children)) { try { children[id].kill(); } catch {} delete children[id]; }
  for (const t of tasks) {
    if (t.state === "done" || t.state === "failed") continue;
    t.state = "cancelled";
    if (!t.notes) t.notes = "cancelled by operator";
    for (const wid of [`${t.id}-dev`, `${t.id}-qa`])
      if (workers[wid] && workers[wid].status === "working")
        setWorker(wid, { status: "failed", summary: "cancelled by operator" });
  }
  setWorker("pm", { status: "needs_input", summary: "run cancelled by operator" });
}

// ---------- worker prompts --------------------------------------------------
// ── Lessons-learned memory ───────────────────────────────────────────────
// Pitfalls captured from QA failures, persisted per-project and injected into
// every dev/QA prompt so the team stops repeating the same mistakes across
// retries and future sprints. Each sprint inherits the last one's scar tissue.
const LESSONS_FILE = path.join(PROJECT, ".orch-lessons.md");
function loadLessons() {
  try { return fs.readFileSync(LESSONS_FILE, "utf8").trim() || ""; } catch { return ""; }
}
function lessonsBlock() {
  const l = loadLessons();
  return l ? `\nKNOWN PITFALLS in this repo — do NOT repeat these (learned from past QA failures):\n${l}\n` : "";
}
function appendLesson(taskTitle, reason) {
  const clean = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!clean) return;
  const existing = loadLessons();
  if (existing && existing.toLowerCase().includes(clean.toLowerCase().slice(0, 60))) return; // dedup
  try {
    const header = existing ? "" :
      "# Orchestrator lessons learned\n\nPitfalls captured from QA failures; auto-injected into future dev/QA prompts.\n\n";
    fs.appendFileSync(LESSONS_FILE, header + `- (${taskTitle}) ${clean}\n`);
    note(`📝 lesson recorded: ${clean.slice(0, 80)}`);
  } catch (e) {}
}

function devPrompt(t) {
  return [
    fill(PROFILE.devRole),
    `Implement this task end to end (create/modify the code, write tests where relevant):`,
    ``,
    `TASK ${t.id}: ${t.title}`,
    t.description,
    t.components.length ? `Components: ${t.components.join(", ")}` : "",
    t.acceptance.length ? `Acceptance criteria:\n- ${t.acceptance.join("\n- ")}` : "",
    t.notes ? `\nPREVIOUS QA REJECTED YOUR WORK — fix this specifically:\n${t.notes}` : "",
    lessonsBlock(),
    ``,
    fill(PROFILE.devGuidance),
    `When done, end with a 2-line summary of what you changed and how to verify it.`,
  ].filter(Boolean).join("\n");
}
function qaPrompt(t) {
  return [
    fill(PROFILE.qaRole),
    `A developer just implemented task ${t.id}: "${t.title}".`,
    t.acceptance.length ? `Acceptance criteria:\n- ${t.acceptance.join("\n- ")}` : "",
    t.qa.checks && t.qa.checks.length ? `Suggested checks:\n- ${t.qa.checks.join("\n- ")}` : "",
    lessonsBlock(),
    ``,
    `Verify the work objectively: inspect the changed code and RUN the relevant checks`,
    `(${fill(PROFILE.qaCommandsHint)}). Do not change code.`,
    PROFILE.visualQA ? fill(PROFILE.visualQA) : "",
    `Finish with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL — <specific reasons>".`,
  ].filter(Boolean).join("\n");
}
function parseVerdict(out, ok) {
  if (/VERDICT:\s*PASS/i.test(out)) return "pass";
  if (/VERDICT:\s*FAIL/i.test(out)) return "fail";
  return ok ? "pass" : "fail"; // fall back to process success if no explicit verdict
}
function firstFail(out) {
  const m = out.match(/VERDICT:\s*FAIL[\s—:-]*([^\n]+)/i);
  return (m && m[1].trim().slice(0, 160)) || "did not meet acceptance criteria";
}

// ---------- misc ------------------------------------------------------------
function shorten(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function cap(s) { s = String(s || ""); return s.length > 8000 ? s.slice(-8000) : s; }

// ---------- preflight safety -------------------------------------------------
// Block obviously-bad real runs before any agent spins up. Dry-runs are inert
// so we skip preflight entirely there. Real runs default to creating an
// isolated `agent/run-*` branch so the agents never commit straight to
// main/master and a stop-the-world `git branch -D` always rolls them back.
function git(args) {
  try {
    const r = spawnSync("git", args, { cwd: PROJECT, encoding: "utf8" });
    if (r.status === 0) return (r.stdout || "").trim();
  } catch {}
  return null;
}
function slugify(s, max) {
  return String(s || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, max || 40) || "sprint";
}
let SPRINT_BRANCH = "";
function preflight() {
  if (DRY) return;
  if (SKIP && !RISK_ACK) {
    console.error(
      "\n  ⚠  ORCH_SKIP_PERMISSIONS=1 lets agents run ANY shell command without prompting.\n" +
      "     If you truly want this, also pass --i-understand-risk\n" +
      "     (or ORCH_I_UNDERSTAND_RISK=1). Refusing for now.\n");
    process.exit(2);
  }
  const inGit = git(["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!inGit) {
    if (!ALLOW_NOGIT) {
      console.error(
        "\n  ⚠  " + PROJECT + " is not a git repo.\n" +
        "     Agents will edit files here with no undo. Run inside a git repo,\n" +
        "     or pass --allow-no-git to override.\n");
      process.exit(2);
    }
    note("preflight: not a git repo (--allow-no-git)");
    return;
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "?";
  const dirty  = git(["status", "--porcelain"]) || "";
  if (dirty && !ALLOW_DIRTY) {
    console.error(
      "\n  ⚠  Uncommitted changes in " + PROJECT + ".\n" +
      "     Agents may mix their work with yours. Commit or stash first,\n" +
      "     or pass --allow-dirty to proceed anyway.\n");
    process.exit(2);
  }
  if (NO_BRANCH) {
    if ((branch === "main" || branch === "master") && !ALLOW_MAIN) {
      console.error(
        "\n  ⚠  Refusing to run on `" + branch + "` with --no-branch.\n" +
        "     Drop --no-branch (recommended — a fresh agent/run-* branch is created),\n" +
        "     or pass --allow-main to commit straight to " + branch + ".\n");
      process.exit(2);
    }
    note("preflight: staying on `" + branch + "` (--no-branch)");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const head  = String(EPIC).split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || "sprint";
  const slug  = slugify(head, 32);
  SPRINT_BRANCH = "agent/run-" + stamp + "-" + slug;
  const r = spawnSync("git", ["checkout", "-b", SPRINT_BRANCH], { cwd: PROJECT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(
      "\n  ⚠  Could not create branch " + SPRINT_BRANCH + ":\n" +
      (r.stderr || r.stdout || "(no output)") +
      "\n     Re-run with --no-branch to skip auto-branching, or fix the git state.\n");
    process.exit(2);
  }
  note("preflight: created branch " + SPRINT_BRANCH + " (from " + branch + ")");
}

// ---------- main ------------------------------------------------------------
async function main() {
  if (!EPIC) {
    console.error("No epic provided. Use --epic <file|text> or ORCH_EPIC.\n" +
      "Example:\n  node orchestrate.js --project \"/path/to/project\" --epic ./examples/sample-epic.md\n" +
      "  node orchestrate.js --epic ./examples/sample-epic.md --dry-run");
    process.exit(1);
  }
  if (!DRY && !fs.existsSync(PROJECT)) { console.error("Project folder not found: " + PROJECT); process.exit(1); }

  preflight();

  console.log(`\n  Pixel Agent Office — Orchestrator${DRY ? "  (DRY RUN)" : ""}`);
  console.log(`  run     : ${RUN_ID}`);
  console.log(`  project : ${PROJECT}`);
  console.log(`  profile : ${PROFILE.name}`);
  console.log(`  workers : up to ${CAP} concurrent · ${MAX_RETRY} reworks · perm=${PMODE}${SKIP ? "+skip" : ""}${MODEL ? " · " + MODEL : ""}`);
  if (SPRINT_BRANCH) console.log(`  branch  : ${SPRINT_BRANCH}  (isolated sprint branch)`);
  if (BUDGET != null) console.log(`  budget  : $${BUDGET.toFixed(2)} hard cap (ORCH_BUDGET_USD)`);
  if (WEBHOOK) console.log(`  webhook : ${WEBHOOK}`);
  console.log(`  view    : start the office (node server.js) and watch the team →\n`);
  if (!DRY && !GITBASH && process.platform === "win32")
    console.log("  ⚠ git bash not found — set CLAUDE_CODE_GIT_BASH_PATH if workers fail to start.\n");

  startControl();
  phase = "building";
  await planEpic();
  if (!cancelled) { phase = "building"; schedule(); }
  await allDone;

  console.log("\n  ── sprint board ──");
  for (const t of tasks) console.log(`  ${t.state === "done" ? "✓" : "✗"} ${t.id}  ${t.title}  (${t.state}${t.retries ? ", " + t.retries + " reworks" : ""})`);
  const tot = computeTotals();
  console.log(`\n  spend: $${tot.costUsd.toFixed(4)} · tokens in/out: ${tot.tokensIn}/${tot.tokensOut} · ${tot.tasksPerHour} tasks/hr`);
  console.log(`  team.json + data/history/${RUN_ID}.json written for the office. Done.\n`);
  writeState();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
