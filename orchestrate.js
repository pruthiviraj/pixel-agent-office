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
 *   --dry-run        | ORCH_DRYRUN=1     mock the claude calls (test the loop)
 *   ORCH_CONCURRENCY=3                   max workers running at once
 *   ORCH_MAX_RETRIES=2                   dev<->QA rework attempts per task
 *   ORCH_PERMISSION_MODE=acceptEdits     permission mode for worker agents
 *   ORCH_SKIP_PERMISSIONS=1              add --dangerously-skip-permissions
 *                                        (needed for full autonomy incl. shell)
 *   ORCH_MODEL=claude-sonnet-4-6         model for worker agents (optional)
 *   ORCH_TIMEOUT_MIN=30                  per-worker timeout
 * ===========================================================================
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ---------- config ----------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : undefined;
}
const DATA_DIR   = path.join(__dirname, "data");
const TEAM_FILE  = path.join(DATA_DIR, "team.json");
const DRY        = !!flag("dry-run") || process.env.ORCH_DRYRUN === "1";
const PROJECT    = path.resolve(flag("project") || process.env.ORCH_PROJECT || ".");
const CAP        = +(process.env.ORCH_CONCURRENCY || 3);
const MAX_RETRY  = +(process.env.ORCH_MAX_RETRIES || 2);
const PMODE      = process.env.ORCH_PERMISSION_MODE || "acceptEdits";
const SKIP       = process.env.ORCH_SKIP_PERMISSIONS === "1";
const MODEL      = process.env.ORCH_MODEL || "";
const TIMEOUT    = +(process.env.ORCH_TIMEOUT_MIN || 30) * 60000;

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

// ---------- team state written for the dashboard ----------------------------
const workers = {};            // id -> { id,name,team,status,summary,cwd,startedAt,role }
const logs = {};               // id -> captured worker output (capped)
const log = [];                // human-readable event log
let summary = "";              // PM's one-line plan summary
let phase = "planning";        // planning | building | done

function note(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  log.push(line);
  console.log(line);
}
function setWorker(id, patch) {
  workers[id] = { ...(workers[id] || {}), id, ...patch };
}
function writeState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const board = tasks.map((t) => ({
    id: t.id, title: t.title, state: t.state, retries: t.retries,
    deps: t.deps, components: t.components,
  }));
  const out = {
    active: phase !== "done",
    updatedAt: Date.now(),
    project: PROJECT, epic: EPIC, profile: PROFILE.name, summary, phase,
    workers: Object.values(workers),
    board,
    log: log.slice(-60),
  };
  fs.writeFileSync(TEAM_FILE, JSON.stringify(out, null, 2));
  // logs served by the dashboard drawer (separate file to keep team.json lean)
  fs.writeFileSync(path.join(DATA_DIR, "team-logs.json"), JSON.stringify(logs));
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
    if (MODEL) args.push("--model", MODEL);
    const env = { ...process.env };
    if (GITBASH) env.CLAUDE_CODE_GIT_BASH_PATH = GITBASH;
    execFile(CLAUDE_BIN, args, { cwd: PROJECT, env, timeout: TIMEOUT, maxBuffer: 24 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = ((stdout || "") + (stderr ? "\n--- stderr ---\n" + stderr : "")).trim();
        resolve({ ok: !err, out: text, code: err && err.code });
      });
  });
}
// dry-run stand-in: realistic timing, QA fails ~once then passes on retry
function mockWorker(w) {
  return new Promise((resolve) => {
    const ms = 1500 + Math.random() * 3500;
    setTimeout(() => {
      if (w.role === "tester") {
        const t = tasks.find((x) => x.id === w.taskId);
        const pass = (t && t.retries > 0) || Math.random() > 0.4;
        resolve({
          ok: true,
          out: pass
            ? `Ran the project's tests for ${w.taskId}. All green.\nVERDICT: PASS`
            : `Failing assertion / missing edge case in ${w.taskId}. Fix the null-check path.\nVERDICT: FAIL — add guard + test`,
        });
      } else {
        resolve({ ok: true, out: `(dry-run) implemented ${w.taskId} — edited components, added a test.` });
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
    plan = PROFILE.examplePlan;
  } else {
    const res = await runWorker(PLAN_PROMPT(EPIC), { name: "pm: planning", role: "pm" });
    plan = parsePlan(res.out);
    if (!plan) { note("⚠ PM did not return parseable JSON. Raw output saved to data/pm-output.txt");
      fs.writeFileSync(path.join(DATA_DIR, "pm-output.txt"), res.out); process.exit(1); }
  }
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

function depsOk(t) { return t.deps.every((d) => { const x = tasks.find((y) => y.id === d); return x && x.state === "done"; }); }
function depFailed(t) { return t.deps.some((d) => { const x = tasks.find((y) => y.id === d); return x && x.state === "failed"; }); }

function schedule() {
  // fail tasks whose dependency failed
  for (const t of tasks) if (t.state === "planned" && depFailed(t)) {
    t.state = "failed"; t.notes = "blocked: a dependency failed";
    note(`✗ ${t.id} blocked — dependency failed`);
  }
  // dispatch ready dev work up to the concurrency cap
  for (const t of tasks) {
    if (running >= CAP) break;
    if (t.state === "planned" && depsOk(t)) startDev(t);
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
    t.devOut = cap(res.out); logs[id] = t.devOut;
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
    t.qaOut = cap(res.out); logs[id] = t.qaOut;
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
  if (tasks.length && tasks.every((t) => t.state === "done" || t.state === "failed")) {
    if (phase !== "done") {
      phase = "done";
      const ok = tasks.filter((t) => t.state === "done").length;
      const bad = tasks.length - ok;
      setWorker("pm", { status: bad ? "needs_input" : "completed",
        summary: `sprint complete — ${ok} shipped, ${bad} failed` });
      note(`■ SPRINT COMPLETE — ${ok} shipped, ${bad} failed`);
      writeState();
      resolveAll();
    }
  }
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

// ---------- main ------------------------------------------------------------
async function main() {
  if (!EPIC) {
    console.error("No epic provided. Use --epic <file|text> or ORCH_EPIC.\n" +
      "Example:\n  node orchestrate.js --project \"/path/to/project\" --epic ./examples/sample-epic.md\n" +
      "  node orchestrate.js --epic ./examples/sample-epic.md --dry-run");
    process.exit(1);
  }
  if (!DRY && !fs.existsSync(PROJECT)) { console.error("Project folder not found: " + PROJECT); process.exit(1); }

  console.log(`\n  Pixel Agent Office — Orchestrator${DRY ? "  (DRY RUN)" : ""}`);
  console.log(`  project : ${PROJECT}`);
  console.log(`  profile : ${PROFILE.name}`);
  console.log(`  workers : up to ${CAP} concurrent · ${MAX_RETRY} reworks · perm=${PMODE}${SKIP ? "+skip" : ""}${MODEL ? " · " + MODEL : ""}`);
  console.log(`  view    : start the office (node server.js) and watch the team →\n`);
  if (!DRY && !GITBASH && process.platform === "win32")
    console.log("  ⚠ git bash not found — set CLAUDE_CODE_GIT_BASH_PATH if workers fail to start.\n");

  phase = "building";
  await planEpic();
  phase = "building";
  schedule();
  await allDone;

  console.log("\n  ── sprint board ──");
  for (const t of tasks) console.log(`  ${t.state === "done" ? "✓" : "✗"} ${t.id}  ${t.title}  (${t.state}${t.retries ? ", " + t.retries + " reworks" : ""})`);
  console.log(`\n  team.json written for the office. Done.\n`);
  writeState();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
