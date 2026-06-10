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
const { execFile } = require("child_process");

const PORT = process.env.PORT || 4040;
const AUTO_LEARN = process.env.AUTO_LEARN === "1";
const AUTO_LEARN_TTL = 24 * 3600e3; // re-learn at most once a day
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const KNOWLEDGE_FILE = path.join(DATA_DIR, "knowledge.json");
const JOBS_DIR = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  "jobs"
);
const TEAM_FILE = path.join(DATA_DIR, "team.json");           // written by orchestrate.js
const TEAM_LOGS_FILE = path.join(DATA_DIR, "team-logs.json");

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
    epic: "Build a Quote line discount engine (tiered rules + LWC editor)",
    summary: "PM split the epic into 4 tasks; devs build, QA verifies each.",
    board: [
      { id: "T1", title: "Discount rule data model",   state: "done",    retries: 0, deps: [] },
      { id: "T2", title: "DiscountService Apex",        state: "qa",      retries: 1, deps: ["T1"] },
      { id: "T3", title: "Quote line LWC editor",       state: "dev",     retries: 0, deps: ["T2"] },
      { id: "T4", title: "Opportunity rollup trigger",  state: "planned", retries: 0, deps: ["T2"] },
    ],
    log: ["PM planned 4 tasks", "✓ DONE T1 — QA passed", "↻ RETRY T2 (attempt 2/3)", "→ QA T2 verifying", "→ DEV T3"],
  },
};

// ---------- http server ------------------------------------------------------

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
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
      return json(200, {
        demo: false,
        autoLearn: AUTO_LEARN,
        sessions: merged,
        knowledge,
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

    if (url.pathname.startsWith("/api/logs/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      // orchestrated worker? serve its captured output instead of `claude logs`
      const wl = loadTeamLogs();
      if (wl && wl[id]) return json(200, { id, logs: wl[id] });
      try { return json(200, { id, logs: await getLogs(id) }); }
      catch (e) { return json(200, { id, logs: "", error: e.message }); }
    }

    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const fp = path.join(PUBLIC_DIR, path.normalize(file).replace(/^([.][.][/\\])+/, ""));
    if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { json(500, { error: e.message }); }
});

server.listen(PORT, () => {
  console.log(`\n  Agent Office`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → http://localhost:${PORT}/?demo=1   (sample office, no sessions needed)\n`);
  console.log(`  Run it as a managed row inside agent view:`);
  console.log(`    claude --bg --exec 'node ${path.join(__dirname, "server.js")}'\n`);
  console.log(`  Auto-learning: ${AUTO_LEARN ? "ON (re-learns stale projects daily)" : "off — use the LEARN button, or AUTO_LEARN=1 node server.js"}\n`);
});
