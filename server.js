#!/usr/bin/env node
/**
 * Agent Office — live animated view of your Claude Code agents
 * -------------------------------------------------------------
 * v2: animated office UI + per-project self-learning knowledge.
 *
 * Run:            node server.js              → http://localhost:4040
 * Inside agent view (shows as a managed row, survives terminal close):
 *                 claude --bg --exec 'node /full/path/to/server.js'
 *
 * Self-learning:
 *   - The server polls `claude agents --json` every 5s and records every
 *     task completion/failure per project folder into data/knowledge.json.
 *   - Press "LEARN" in the UI (or set AUTO_LEARN=1) to run a headless
 *     `claude -p` inside that project folder and store a fresh project
 *     brief. Knowledge accumulates over time; agents level up per team.
 *
 * Needs: Claude Code v2.1.141+ on PATH.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 4040;
const BIND = process.env.OFFICE_BIND || "127.0.0.1";       // localhost-only by default
const TOKEN = (process.env.OFFICE_TOKEN || "").trim();     // empty = auth disabled
const AUTO_LEARN = process.env.AUTO_LEARN === "1";
const AUTO_LEARN_TTL = 24 * 3600e3; // re-learn at most once a day
const PUBLIC_DIR = path.join(__dirname, "public");
// Must match orchestrate.js exactly: install-location-independent so the viewer
// and the orchestrator share state even when launched from different npx caches.
// Override with PAO_DATA_DIR.
const DATA_DIR = process.env.PAO_DATA_DIR
  ? path.resolve(process.env.PAO_DATA_DIR)
  : path.join(os.homedir(), ".pixel-agent-office", "data");
const KNOWLEDGE_FILE = path.join(DATA_DIR, "knowledge.json");
const ROSTER_FILE = path.join(DATA_DIR, "roster.json");        // per-project crew (written by orchestrate.js)
function loadRoster() { try { return JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8")); } catch { return {}; } }
const JOBS_DIR = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  "jobs"
);
const TEAM_FILE = path.join(DATA_DIR, "team.json");           // written by orchestrate.js
const TEAM_LOGS_FILE = path.join(DATA_DIR, "team-logs.json");
const CONTROL_FILE = path.join(DATA_DIR, "control.json");     // UI -> engine command channel
const HISTORY_DIR = path.join(DATA_DIR, "history");           // engine writes <runId>.json per sprint

// ---------- claude CLI ---------------------------------------------------

// On Windows, `claude` needs git bash; find it so the live view works headless.
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

// Resolve the real `claude` binary. On Windows the PATH entry is a .cmd shim
// that execFile() can't run without a shell, so target the native .exe.
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

function runClaude(args, opts = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(opts.env || {}) };
    if (GITBASH) env.CLAUDE_CODE_GIT_BASH_PATH = GITBASH;
    execFile(
      CLAUDE_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...opts, env },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.toString().trim() || err.message));
        resolve(stdout.toString());
      }
    );
  });
}

// ---------- orchestrator team feed (data/team.json) ----------------------

function loadTeam() {
  try { return JSON.parse(fs.readFileSync(TEAM_FILE, "utf8")); }
  catch { return null; }
}
function loadTeamLogs() {
  try { return JSON.parse(fs.readFileSync(TEAM_LOGS_FILE, "utf8")); }
  catch { return {}; }
}

// ---------- control channel (UI -> orchestrate.js via data/control.json) --

const CONTROL_TYPES = new Set(["pause", "resume", "cancel", "retry", "force-pass", "force-fail"]);
const CONTROL_NEEDS_TASK = new Set(["retry", "force-pass", "force-fail"]);

function appendControl(cmd) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let doc = { commands: [] };
  try {
    const cur = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
    if (cur && Array.isArray(cur.commands)) doc = cur;
  } catch {}
  doc.commands.push(cmd);
  // atomic: write a temp file then rename over the real one
  const tmp = CONTROL_FILE + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, CONTROL_FILE);
}

// ---------- run history (data/history/<runId>.json) ------------------------

function safeRunId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.includes("..") ? id : null;
}

function listHistory() {
  let files = [];
  try { files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")); }
  catch { return []; }
  const runs = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf8"));
      runs.push({
        runId: r.runId || f.replace(/\.json$/, ""),
        startedAt: r.startedAt || null,
        endedAt: r.endedAt || null,
        epic: r.epic || "",
        summary: r.summary || "",
        totals: r.totals || null,
      });
    } catch {}
  }
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)); // newest first
  return runs;
}

function readHistoryRun(runId) {
  const id = safeRunId(runId);
  if (!id) return null;
  try { return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, id + ".json"), "utf8")); }
  catch { return null; }
}

function readStateFile(sessionId) {
  try {
    const p = path.join(JOBS_DIR, sessionId, "state.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return null; }
}

// ---------- team routing & status -----------------------------------------

const TEAM_RULES = [
  { team: "planning",  re: /^(pm|manager|lead|plan|planning|spec|design|arch)\b|planner|orchestrat/i },
  { team: "developer", re: /^(dev|feat|fix|impl|build|code)\b|developer|coder/i },
  { team: "tester",    re: /^(test|qa|verify|e2e|lint)\b|tester|reviewer/i },
];

function assignTeam(s) {
  const hay = [s.name, s.agent, s.kind].filter(Boolean).join(" ");
  for (const r of TEAM_RULES) if (r.re.test(hay)) return r.team;
  return "unassigned";
}

function normalizeStatus(raw) {
  const s = String(raw || "").toLowerCase();
  if (/work|run|active|generating|busy/.test(s)) return "working";
  if (/input|wait|block|question|permission/.test(s)) return "needs_input";
  if (/complete|done|success|finish/.test(s)) return "completed";
  if (/fail|error/.test(s)) return "failed";
  if (/stop|kill|cancel/.test(s)) return "stopped";
  if (/idle/.test(s)) return "idle";
  return s || "unknown";
}

// ---------- knowledge store (the office "brain") ---------------------------

function loadKnowledge() {
  try { return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, "utf8")); }
  catch { return {}; }
}
function saveKnowledge(k) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(k, null, 2));
}
let knowledge = loadKnowledge();

function projectEntry(cwd) {
  if (!knowledge[cwd]) {
    knowledge[cwd] = {
      summary: null,
      learnedAt: null,
      learning: false,
      tasks: [],                                  // recent task outcomes
      stats: { completed: 0, failed: 0 },
      teamXP: { planning: 0, developer: 0, tester: 0, unassigned: 0 },
      firstSeen: Date.now(),
    };
  }
  return knowledge[cwd];
}

function recordOutcome(session, outcome) {
  const cwd = session.cwd || "unknown";
  const p = projectEntry(cwd);
  p.tasks.unshift({ name: session.name, team: session.team, outcome, at: Date.now() });
  p.tasks = p.tasks.slice(0, 30);
  p.stats[outcome === "completed" ? "completed" : "failed"]++;
  if (outcome === "completed") p.teamXP[session.team] = (p.teamXP[session.team] || 0) + 1;
  saveKnowledge(knowledge);
}

const LEARN_PROMPT =
  "You are the office knowledge bot for this repository. In at most 6 short bullet " +
  "points, summarize: what this project is, the tech stack, how it's structured, " +
  "how to run/test it, and anything an agent team should know before working here. " +
  "Plain text bullets only, no preamble.";

async function learnProject(cwd) {
  const p = projectEntry(cwd);
  if (p.learning) return p;
  p.learning = true;
  try {
    // Headless one-shot: `claude -p "<prompt>"` run inside the project folder.
    const out = await runClaude(["-p", LEARN_PROMPT], { cwd }, 180000);
    p.summary = out.trim().slice(0, 4000);
    p.learnedAt = Date.now();
  } catch (e) {
    p.summary = p.summary || null;
    p.lastError = e.message.slice(0, 300);
  } finally {
    p.learning = false;
    saveKnowledge(knowledge);
  }
  return p;
}

// ---------- session polling (server-side, so we can detect transitions) ----

let cache = { sessions: [], error: null, at: 0 };
const lastStatus = new Map(); // sessionId -> status

async function pollSessions() {
  try {
    const out = await runClaude(["agents", "--json"]);
    let list;
    try { list = JSON.parse(out); }
    catch {
      throw new Error("`claude agents --json` did not return JSON — run `claude update` (needs v2.1.141+).");
    }
    if (!Array.isArray(list)) list = [];

    const sessions = list.map((s) => {
      const id = s.sessionId || s.id || null;
      const state = id ? readStateFile(id) : null;
      const m = {
        id,
        pid: s.pid ?? null,
        name: s.name || state?.name || state?.intent || (id ? id.slice(0, 8) : "unnamed"),
        cwd: s.cwd || state?.cwd || "",
        kind: s.kind || state?.kind || "",
        agent: s.agent || state?.agent || "",
        startedAt: s.startedAt || state?.startedAt || (state?.createdAt ? Date.parse(state.createdAt) : null),
        status: normalizeStatus(s.status || s.waitingFor || state?.status || state?.state),
        summary: state?.summary || state?.detail || state?.lastSummary || state?.activity || s.summary || "",
        prUrl: state?.prUrl || state?.pullRequestUrl || null,
      };
      m.team = assignTeam(m);
      return m;
    });

    // detect completion/failure transitions → feed the knowledge store
    for (const s of sessions) {
      if (!s.id) continue;
      const prev = lastStatus.get(s.id);
      if (prev && prev !== s.status && (s.status === "completed" || s.status === "failed")) {
        recordOutcome(s, s.status);
      }
      lastStatus.set(s.id, s.status);
      if (s.cwd) projectEntry(s.cwd); // make sure every active folder has a brain slot
    }

    // optional auto-learning of stale projects that have active agents
    if (AUTO_LEARN) {
      for (const s of sessions) {
        const p = s.cwd && knowledge[s.cwd];
        if (p && !p.learning && (!p.learnedAt || Date.now() - p.learnedAt > AUTO_LEARN_TTL)) {
          learnProject(s.cwd); // fire and forget
        }
      }
    }

    cache = { sessions, error: null, at: Date.now() };
  } catch (e) {
    cache = { sessions: [], error: e.message, at: Date.now() };
  }
}
pollSessions();
setInterval(pollSessions, 5000);

function getLogs(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return Promise.reject(new Error("invalid session id"));
  return runClaude(["logs", id], {}, 20000);
}

// ---------- demo data -------------------------------------------------------

const DEMO = {
  sessions: [
    { id: "demo-p1", name: "plan: billing refactor roadmap", status: "working",     team: "planning",  cwd: "~/projects/shop",  summary: "Drafting milestone breakdown in PLAN.md", startedAt: Date.now() - 7 * 60e3 },
    { id: "demo-p2", name: "plan: api v2 spec",              status: "needs_input", team: "planning",  cwd: "~/projects/shop",  summary: "needs input: REST or GraphQL for partner API?", startedAt: Date.now() - 22 * 60e3 },
    { id: "demo-d1", name: "dev: webhook retry queue",       status: "working",     team: "developer", cwd: "~/projects/shop",  summary: "Edit src/queue/RetryWorker.ts", startedAt: Date.now() - 14 * 60e3 },
    { id: "demo-d2", name: "dev: fix flaky auth refresh",    status: "completed",   team: "developer", cwd: "~/projects/shop",  summary: "result: token refresh race fixed, PR opened", startedAt: Date.now() - 95 * 60e3, prUrl: "#" },
    { id: "demo-d3", name: "dev: dark mode toggle",          status: "working",     team: "developer", cwd: "~/projects/site",  summary: "Edit src/theme/ThemeProvider.tsx", startedAt: Date.now() - 4 * 60e3 },
    { id: "demo-t1", name: "test: e2e checkout flow",        status: "working",     team: "tester",    cwd: "~/projects/shop",  summary: "run 7 · 31/34 specs passing", startedAt: Date.now() - 9 * 60e3 },
    { id: "demo-t2", name: "test: load test payment svc",    status: "failed",      team: "tester",    cwd: "~/projects/shop",  summary: "error: k6 threshold breached at 400 rps", startedAt: Date.now() - 51 * 60e3 },
    { id: "demo-u1", name: "investigate slow CI",            status: "idle",        team: "unassigned",cwd: "~/projects/infra", summary: "ready for next prompt", startedAt: Date.now() - 130 * 60e3 },
  ],
  knowledge: {
    "~/projects/shop": {
      summary: "• E-commerce monolith (Node 20 + TypeScript, Postgres, Redis)\n• src/queue handles async jobs; BullMQ with custom retry policy\n• Run: pnpm dev · Test: pnpm test (vitest) + e2e via Playwright\n• Payments through Stripe; webhooks are the current focus area\n• CI on GitHub Actions, deploys via Fly.io\n• Watch out: auth tokens cached in Redis, invalidation is tricky",
      learnedAt: Date.now() - 3 * 3600e3, learning: false,
      tasks: [
        { name: "dev: fix flaky auth refresh", team: "developer", outcome: "completed", at: Date.now() - 90 * 60e3 },
        { name: "test: load test payment svc", team: "tester", outcome: "failed", at: Date.now() - 48 * 60e3 },
        { name: "plan: q3 cleanup spec", team: "planning", outcome: "completed", at: Date.now() - 26 * 3600e3 },
      ],
      stats: { completed: 14, failed: 3 },
      teamXP: { planning: 4, developer: 8, tester: 2, unassigned: 0 },
      roster: {
        planning:  [{ name: "Maya", role: "planning", xp: 7, tasks: 7, sprints: 3 }],
        developer: [
          { name: "Ada",   role: "developer", xp: 22, tasks: 11, sprints: 3 },
          { name: "Linus", role: "developer", xp: 9,  tasks: 5,  sprints: 2 },
          { name: "Grace", role: "developer", xp: 2,  tasks: 1,  sprints: 1 }],
        tester: [
          { name: "Quinn", role: "tester", xp: 12, tasks: 12, sprints: 3 },
          { name: "Bly",   role: "tester", xp: 4,  tasks: 4,  sprints: 2 }],
      },
      firstSeen: Date.now() - 21 * 86400e3,
    },
    "~/projects/site": {
      summary: null, learnedAt: null, learning: false, tasks: [],
      stats: { completed: 1, failed: 0 },
      teamXP: { planning: 0, developer: 1, tester: 0, unassigned: 0 },
      firstSeen: Date.now() - 2 * 86400e3,
    },
  },
  orch: {
    active: true, phase: "building",
    runId: "run-" + (Date.now() - 18 * 60e3),
    paused: false,
    epic: "Build a Quote line discount engine (tiered rules + LWC editor)",
    summary: "PM split the epic into 5 tasks; devs build, QA verifies each.",
    budget: { capUsd: 5, spentUsd: 1.37 },
    totals: {
      tasksDone: 1, tasksFailed: 1, tokensIn: 184_220, tokensOut: 41_730,
      costUsd: 1.37, startedAt: Date.now() - 18 * 60e3, tasksPerHour: 3.3,
    },
    board: [
      { id: "T1", title: "Discount rule data model",   state: "done",      retries: 0, deps: [] },
      { id: "T2", title: "DiscountService Apex",        state: "qa",        retries: 1, deps: ["T1"] },
      { id: "T3", title: "Quote line LWC editor",       state: "dev",       retries: 0, deps: ["T2"] },
      { id: "T4", title: "Opportunity rollup trigger",  state: "planned",   retries: 0, deps: ["T2"] },
      { id: "T5", title: "Bulk discount import job",    state: "failed",    retries: 2, deps: ["T1"] },
    ],
    workers: [
      { id: "w-pm",   name: "pm: sprint planner",        team: "planning",  room: "planning", status: "idle",
        summary: "plan locked — monitoring board", model: "claude-opus-4-6", costUsd: 0.42, tokensIn: 61_000, tokensOut: 9_800 },
      { id: "w-dev1", name: "dev: T3 LWC editor",        team: "developer", room: "dev",      status: "working",
        summary: "Edit force-app/.../quoteLineEditor.js", model: "claude-sonnet-4-6", costUsd: 0.55, tokensIn: 78_400, tokensOut: 21_300 },
      { id: "w-qa1",  name: "qa: verify T2 service",     team: "tester",    room: "qa",       status: "working",
        summary: "running DiscountServiceTest (attempt 2)", model: "claude-haiku-4-5", costUsd: 0.40, tokensIn: 44_820, tokensOut: 10_630 },
    ],
    log: ["PM planned 5 tasks", "✓ DONE T1 — QA passed", "↻ RETRY T2 (attempt 2/3)", "→ QA T2 verifying", "→ DEV T3", "✗ FAIL T5 — import job spec rejected twice"],
  },
};

// sample sprint history shown when the UI is in demo mode (?demo=1)
const DEMO_HISTORY = [
  {
    runId: "run-demo-2", startedAt: Date.now() - 26 * 3600e3, endedAt: Date.now() - 25 * 3600e3,
    epic: "Student fee receipt PDF + email on payment", profile: "default", project: "~/projects/shop",
    summary: "4/4 tasks done in 58m under budget.",
    totals: { tasksDone: 4, tasksFailed: 0, tokensIn: 402_000, tokensOut: 88_500, costUsd: 2.84, startedAt: Date.now() - 26 * 3600e3, tasksPerHour: 4.1 },
    budget: { capUsd: 5, spentUsd: 2.84 },
    board: [
      { id: "T1", title: "Receipt PDF generator service", state: "done", retries: 0, deps: [] },
      { id: "T2", title: "Email send on payment trigger",  state: "done", retries: 0, deps: ["T1"] },
      { id: "T3", title: "Receipt template + branding",    state: "done", retries: 1, deps: ["T1"] },
      { id: "T4", title: "Tests + bulk scenarios",         state: "done", retries: 0, deps: ["T2", "T3"] },
    ],
    workers: [
      { id: "w-pm", name: "pm: planner", team: "planning", room: "planning", model: "claude-opus-4-6", costUsd: 0.61, tokensIn: 92_000, tokensOut: 14_000 },
      { id: "w-d1", name: "dev: builder", team: "developer", room: "dev", model: "claude-sonnet-4-6", costUsd: 1.58, tokensIn: 240_000, tokensOut: 58_000 },
      { id: "w-q1", name: "qa: verifier", team: "tester", room: "qa", model: "claude-haiku-4-5", costUsd: 0.65, tokensIn: 70_000, tokensOut: 16_500 },
    ],
    events: [
      { at: Date.now() - 26 * 3600e3, msg: "PM planned 4 tasks" },
      { at: Date.now() - 25.7 * 3600e3, msg: "✓ DONE T1 — QA passed" },
      { at: Date.now() - 25.4 * 3600e3, msg: "↻ RETRY T3 (attempt 2/3)" },
      { at: Date.now() - 25.1 * 3600e3, msg: "✓ DONE T4 — sprint complete" },
    ],
  },
  {
    runId: "run-demo-1", startedAt: Date.now() - 3 * 86400e3, endedAt: Date.now() - 3 * 86400e3 + 42 * 60e3,
    epic: "Hostel room allocation wizard (LWC)", profile: "default", project: "~/projects/shop",
    summary: "2/3 done — budget cap hit, T3 cancelled.",
    totals: { tasksDone: 2, tasksFailed: 0, tokensIn: 310_000, tokensOut: 61_000, costUsd: 3.01, startedAt: Date.now() - 3 * 86400e3, tasksPerHour: 2.9 },
    budget: { capUsd: 3, spentUsd: 3.01 },
    board: [
      { id: "T1", title: "Allocation rules engine",  state: "done",      retries: 0, deps: [] },
      { id: "T2", title: "Wizard LWC (3 steps)",     state: "done",      retries: 1, deps: ["T1"] },
      { id: "T3", title: "Occupancy report",         state: "cancelled", retries: 0, deps: ["T1"], note: "budget cap" },
    ],
    workers: [
      { id: "w-pm", name: "pm: planner", team: "planning", room: "planning", model: "claude-opus-4-6", costUsd: 0.55, tokensIn: 80_000, tokensOut: 12_000 },
      { id: "w-d1", name: "dev: builder", team: "developer", room: "dev", model: "claude-sonnet-4-6", costUsd: 1.92, tokensIn: 195_000, tokensOut: 41_000 },
      { id: "w-q1", name: "qa: verifier", team: "tester", room: "qa", model: "claude-haiku-4-5", costUsd: 0.54, tokensIn: 35_000, tokensOut: 8_000 },
    ],
    events: [
      { at: Date.now() - 3 * 86400e3, msg: "PM planned 3 tasks" },
      { at: Date.now() - 3 * 86400e3 + 20 * 60e3, msg: "✓ DONE T1 — QA passed" },
      { at: Date.now() - 3 * 86400e3 + 39 * 60e3, msg: "✓ DONE T2 — QA passed" },
      { at: Date.now() - 3 * 86400e3 + 42 * 60e3, msg: "⛔ budget cap $3 reached — T3 cancelled" },
    ],
  },
];

// ---------- http server ------------------------------------------------------

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

// Loaded by index.html / pixel.html before any other script. Reads ?t=<token>
// (or sessionStorage) and patches window.fetch so every /api/* request carries
// the bearer header. If the server has no OFFICE_TOKEN set this is a no-op.
const AUTH_SHIM = `(function(){
  try {
    var u = new URL(location.href);
    var qt = u.searchParams.get("t");
    if (qt) {
      sessionStorage.setItem("office_token", qt);
      u.searchParams.delete("t");
      history.replaceState({}, "", u.toString());
    }
    var T = sessionStorage.getItem("office_token");
    if (!T) return;
    var orig = window.fetch.bind(window);
    window.fetch = function(input, init){
      init = init || {};
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf("/api/") === 0 || url.indexOf(location.origin + "/api/") === 0) {
        var h = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
        if (!h.has("Authorization")) h.set("Authorization", "Bearer " + T);
        init.headers = h;
      }
      return orig(input, init);
    };
  } catch(e) { console.warn("auth shim:", e); }
})();`;

// Bearer-token gate for /api/*. Off when OFFICE_TOKEN is unset (current local-dev
// behaviour). When set, every /api/* call must carry Authorization: Bearer <token>
// — except /auth.js (the tiny client shim that puts the token into the page).
function authOk(req) {
  if (!TOKEN) return true;
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(TOKEN);
  if (got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(got, want); } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (url.pathname.startsWith("/api/") && !authOk(req)) {
      return json(401, { error: "unauthorized — set OFFICE_TOKEN and load the UI with ?t=<token>" });
    }
    // tiny client shim: makes the UI attach the Bearer header to every /api/* fetch
    if (url.pathname === "/auth.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(AUTH_SHIM);
    }
    if (url.pathname === "/api/state") {
      if (url.searchParams.get("demo") === "1")
        return json(200, { demo: true, autoLearn: false, ...DEMO, error: null });
      // merge the orchestrator's live team (data/team.json) with real bg sessions.
      // gate on freshness so a finished sprint's workers retire (walk out), while
      // the board lingers a little longer for review.
      const team = loadTeam();
      const age = team ? Date.now() - (team.updatedAt || 0) : Infinity;
      const showWorkers = team && (team.active || age < 2 * 60e3);
      const showBoard   = team && (team.active || age < 15 * 60e3);
      const merged = cache.sessions.slice();
      if (showWorkers && Array.isArray(team.workers)) {
        for (const w of team.workers) {
          merged.push({
            id: w.id, name: w.name, cwd: w.cwd || team.project || "",
            startedAt: w.startedAt || null, status: w.status || "working",
            summary: w.summary || "", team: w.team || "unassigned", orchestrated: true,
          });
        }
      }
      // fold each project's persistent crew (roster.json) into its brain entry
      const roster = loadRoster();
      const knowOut = Object.assign({}, knowledge);
      for (const p in roster) {
        knowOut[p] = Object.assign(
          { summary: null, learnedAt: null, learning: false, tasks: [], stats: { completed: 0, failed: 0 }, teamXP: {} },
          knowOut[p] || {}, { roster: roster[p] });
      }
      return json(200, {
        demo: false,
        autoLearn: AUTO_LEARN,
        sessions: merged,
        knowledge: knowOut,
        orch: showBoard ? team : null,
        error: cache.error,
      });
    }

    if (url.pathname === "/api/learn" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { cwd } = JSON.parse(body || "{}");
          if (!cwd || !fs.existsSync(cwd)) return json(400, { error: "folder not found: " + cwd });
          learnProject(cwd); // async; UI polls /api/state for the result
          return json(200, { ok: true, learning: true });
        } catch (e) { return json(500, { error: e.message }); }
      });
      return;
    }

    if (url.pathname === "/api/control" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { type, taskId, reason } = JSON.parse(body || "{}");
          if (!CONTROL_TYPES.has(type))
            return json(400, { error: "invalid type — expected one of: " + [...CONTROL_TYPES].join(", ") });
          if (CONTROL_NEEDS_TASK.has(type) && (typeof taskId !== "string" || !taskId.trim()))
            return json(400, { error: "taskId is required for " + type });
          const cmd = {
            id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
            at: Date.now(),
            type,
          };
          if (taskId) cmd.taskId = String(taskId).trim();
          if (reason) cmd.reason = String(reason).slice(0, 500);
          appendControl(cmd);
          return json(200, { ok: true, id: cmd.id });
        } catch (e) { return json(500, { error: e.message }); }
      });
      return;
    }

    if (url.pathname === "/api/history") {
      if (url.searchParams.get("demo") === "1")
        return json(200, { demo: true, runs: DEMO_HISTORY.map(({ runId, startedAt, endedAt, epic, summary, totals }) => ({ runId, startedAt, endedAt, epic, summary, totals })) });
      return json(200, { runs: listHistory() });
    }

    if (url.pathname.startsWith("/api/history/")) {
      const raw = decodeURIComponent(url.pathname.slice("/api/history/".length));
      if (!safeRunId(raw)) return json(400, { error: "invalid runId" });
      if (url.searchParams.get("demo") === "1") {
        const d = DEMO_HISTORY.find((r) => r.runId === raw);
        if (d) return json(200, d);
      }
      const run = readHistoryRun(raw);
      if (!run) return json(404, { error: "run not found: " + raw });
      return json(200, run);
    }

    if (url.pathname.startsWith("/api/logs/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      // orchestrated worker? serve its captured output instead of `claude logs`
      const wl = loadTeamLogs();
      if (wl && wl[id]) return json(200, { id, logs: wl[id] });
      try { return json(200, { id, logs: await getLogs(id) }); }
      catch (e) { return json(200, { id, logs: "", error: e.message }); }
    }

    // Default to the full pixel office (control plane + cost/budget HUD live here
    // via office-extras.js). The leaner index.html stays reachable at /index.html.
    let file = url.pathname === "/" ? "/pixel.html" : url.pathname;
    const fp = path.join(PUBLIC_DIR, path.normalize(file).replace(/^([.][.][/\\])+/, ""));
    if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { json(500, { error: e.message }); }
});

server.listen(PORT, BIND, () => {
  const host = BIND === "0.0.0.0" ? "<your-ip>" : BIND;
  const base = `http://${host === "127.0.0.1" ? "localhost" : host}:${PORT}`;
  const t = TOKEN ? `?t=${encodeURIComponent(TOKEN)}` : "";
  console.log(`\n  Agent Office`);
  console.log(`  → ${base}/${t}`);
  console.log(`  → ${base}/?demo=1   (sample office, no sessions needed)`);
  console.log(`  data : ${DATA_DIR}   (set PAO_DATA_DIR to match a running sprint)\n`);
  if (TOKEN) {
    console.log(`  Auth: OFFICE_TOKEN is set — /api/* require Bearer token.`);
    console.log(`         Open the URL above; the token is auto-stored in your browser.\n`);
  } else if (BIND !== "127.0.0.1") {
    console.log(`  ⚠  Bound to ${BIND} WITHOUT OFFICE_TOKEN — anyone on this network can drive`);
    console.log(`     the orchestrator. Set OFFICE_TOKEN=<random> or rebind to 127.0.0.1.\n`);
  } else {
    console.log(`  Auth: off (localhost-only). Set OFFICE_TOKEN=<random> to require a token.\n`);
  }
  console.log(`  Run it as a managed row inside agent view:`);
  console.log(`    claude --bg --exec 'node ${path.join(__dirname, "server.js")}'\n`);
  console.log(`  Auto-learning: ${AUTO_LEARN ? "ON (re-learns stale projects daily)" : "off — use the LEARN button, or AUTO_LEARN=1 node server.js"}\n`);
});
