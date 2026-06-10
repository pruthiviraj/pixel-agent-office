"use strict";
// ============================================================================
// OFFICE EXTRAS — feature subsystems layered on top of the pixel.html engine:
//   · LIVE HUD (sprint cost / tokens / throughput / budget bar / paused)
//   · CONTROL PLANE (pause / resume / cancel + per-task retry / force-*)
//   · THEMES (crt / clean / night — persisted in localStorage)
//   · PRESENTATION MODE (key P — fullscreen stage, minimal floating HUD)
//   · REPLAY (?replay=<runId> — timeline reconstruction with scrubber)
// Loaded as a classic script AFTER the inline engine, so it shares the
// engine's top-level bindings (state, ingest, ROOM_ZONE, …). Everything is
// defensive: all orchestrator fields may be absent (back-compat).
// ============================================================================
(() => {
  const $ = (id) => document.getElementById(id);

  // ---- formatting helpers ---------------------------------------------------
  function fmtK(n) {
    n = +n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n | 0);
  }
  function fmtMoney(v) {
    v = +v || 0;
    return "$" + (v >= 10 ? v.toFixed(2) : v.toFixed(3));
  }
  function fmtDur(ms) {
    ms = Math.max(0, +ms || 0);
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h
      ? h + ":" + String(m).padStart(2, "0") + ":" + ss
      : m + ":" + ss;
  }

  // ---- toast ------------------------------------------------------------------
  let toastTimer = 0;
  function toast(msg, isErr) {
    const el = $("toast");
    el.textContent = msg;
    el.className = isErr ? "err" : "";
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.display = "none"), 2600);
  }

  // ---- live HUD ---------------------------------------------------------------
  let lastOrch = null;
  let lastDemo = false;
  const anim = { cost: 0, target: 0, have: false };

  function updateHud() {
    const tot = lastOrch && lastOrch.totals;
    anim.have = !!tot;
    anim.target = tot ? +tot.costUsd || 0 : 0;
    $("h-tin").textContent = tot ? fmtK(tot.tokensIn) : "—";
    $("h-tout").textContent = tot ? fmtK(tot.tokensOut) : "—";
    $("h-done").textContent = tot ? String(tot.tasksDone || 0) : "—";
    $("h-fail").textContent = tot ? String(tot.tasksFailed || 0) : "—";
    $("h-tph").textContent =
      tot && tot.tasksPerHour ? (+tot.tasksPerHour).toFixed(1) : "—";
    // budget bar (green → amber → red as spend approaches the cap)
    const bud = lastOrch && lastOrch.budget;
    const cell = $("h-budget");
    if (bud && +bud.capUsd > 0) {
      cell.style.display = "";
      const spent = +bud.spentUsd || 0;
      const ratio = Math.max(0, Math.min(1, spent / +bud.capUsd));
      const bar = $("h-bbar");
      bar.style.width = (ratio * 100).toFixed(1) + "%";
      bar.className = ratio >= 0.85 ? "red" : ratio >= 0.6 ? "amber" : "";
      $("h-btxt").textContent =
        "$" + spent.toFixed(2) + " / $" + (+bud.capUsd).toFixed(2);
    } else {
      cell.style.display = "none";
    }
  }

  // ---- control plane ------------------------------------------------------------
  function controlsBlockedWhy() {
    if (window.__replayMode) return "replay";
    if (lastDemo) return "demo";
    if (!lastOrch || !Array.isArray(lastOrch.board) || !lastOrch.board.length)
      return "no active sprint";
    if (lastOrch.active === false) return "sprint finished";
    return "";
  }
  function updateControls() {
    const why = controlsBlockedWhy();
    const bp = $("btn-pause"),
      bc = $("btn-cancel");
    bp.textContent = lastOrch && lastOrch.paused ? "RESUME" : "PAUSE";
    bp.disabled = !!why;
    bc.disabled = !!why;
    bp.title = why;
    bc.title = why || "cancel the whole sprint";
  }
  async function control(type, taskId) {
    if (window.__replayMode) return toast("replay — controls disabled", true);
    if (lastDemo) return toast("demo mode — controls disabled", true);
    try {
      const body = taskId ? { type, taskId } : { type };
      const r = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j && j.ok) {
        toast(type.toUpperCase() + (taskId ? " " + taskId : "") + " → queued");
        // optimistic flip so the button reads right before the next poll
        if (lastOrch && (type === "pause" || type === "resume")) {
          lastOrch.paused = type === "pause";
          updateControls();
          $("paused").style.display = lastOrch.paused ? "block" : "none";
        }
      } else {
        toast("control error: " + ((j && j.error) || r.status), true);
      }
    } catch (e) {
      toast("control failed: " + e.message, true);
    }
  }
  $("btn-pause").addEventListener("click", () => {
    control(lastOrch && lastOrch.paused ? "resume" : "pause");
  });
  $("btn-cancel").addEventListener("click", () => {
    if (
      window.confirm(
        "Cancel the sprint?\n\nRunning workers are killed and all unfinished tasks are marked cancelled."
      )
    )
      control("cancel");
  });
  // per-task buttons on the sprint board (rendered by pixel.html renderBoard)
  $("board").addEventListener("click", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button.act");
    if (!b || b.disabled) return;
    control(b.dataset.act, b.dataset.task);
  });

  // ---- themes --------------------------------------------------------------------
  const THEMES = ["clean", "crt", "night"];
  let theme = localStorage.getItem("pao-theme");
  if (THEMES.indexOf(theme) === -1) theme = "clean";
  function applyTheme(t) {
    theme = t;
    if (t === "clean") delete document.body.dataset.theme;
    else document.body.dataset.theme = t;
    try {
      localStorage.setItem("pao-theme", t);
    } catch (e) {
      /* private mode */
    }
    $("btn-theme").textContent = "THEME: " + t.toUpperCase();
    if (window.applyCanvasTheme) window.applyCanvasTheme(t);
  }
  $("btn-theme").addEventListener("click", () => {
    applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]);
  });
  applyTheme(theme);

  // ---- presentation mode ------------------------------------------------------
  function setPresent(on) {
    document.body.classList.toggle("present", on);
  }
  $("btn-present").addEventListener("click", () => setPresent(true));
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") setPresent(false);
    else if (
      (e.key === "p" || e.key === "P") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    )
      setPresent(!document.body.classList.contains("present"));
  });

  // ---- replay (?replay=<runId>) ----------------------------------------------
  // Reconstructs the sprint from data/history/<runId>.json: board states are
  // replayed from the timestamped event log, workers are re-seated from the
  // run's roster, and the whole thing is fed through the normal ingest() so
  // walk-handoffs/confetti replay exactly like they happened live.
  const RP = {
    active: false,
    run: null,
    ev: [],
    t0: 0,
    t1: 0,
    sim: 0,
    playing: false,
    speed: 1,
    lastRender: 0
  };
  function applyEvent(states, msg) {
    msg = String(msg || "");
    let m;
    if ((m = msg.match(/\bDONE\s+(T\d+)/i))) states[m[1]] = "done";
    else if ((m = msg.match(/\bFAIL\w*\s+(T\d+)/i))) states[m[1]] = "failed";
    else if ((m = msg.match(/\bRETRY\s+(T\d+)/i))) states[m[1]] = "dev";
    else if ((m = msg.match(/\bQA\s+(T\d+)/i))) states[m[1]] = "qa";
    else if ((m = msg.match(/\bDEV\s+(T\d+)/i))) states[m[1]] = "dev";
    else if ((m = msg.match(/(T\d+)\s+cancel/i))) states[m[1]] = "cancelled";
    else if ((m = msg.match(/cancel\w*\s+(T\d+)/i))) states[m[1]] = "cancelled";
  }
  function boardAt(T) {
    const base = (RP.run && RP.run.board) || [];
    const states = {};
    for (const t of base) states[t.id] = "planned";
    for (const ev of RP.ev) {
      if ((ev.at || 0) > T) break;
      applyEvent(states, ev.msg);
    }
    if (T >= RP.t1) for (const t of base) states[t.id] = t.state; // ground truth
    return base.map((t) =>
      Object.assign({}, t, { state: states[t.id] || "planned" })
    );
  }
  function logAt(T) {
    const out = [];
    for (const ev of RP.ev) {
      if ((ev.at || 0) > T) break;
      out.push(ev.msg);
    }
    return out;
  }
  function sessionsAt(T, board) {
    const ended = T >= RP.t1;
    const anyDev = board.some((t) => t.state === "dev");
    const anyQa = board.some((t) => t.state === "qa");
    const firstEvAt = RP.ev.length ? RP.ev[0].at : RP.t0;
    return ((RP.run && RP.run.workers) || []).map((w) => {
      const zone =
        (w.room && typeof ROOM_ZONE !== "undefined" && ROOM_ZONE[w.room]) ||
        w.team ||
        "unassigned";
      let status;
      if (ended) status = "completed";
      else if (zone === "developer") status = anyDev ? "working" : "idle";
      else if (zone === "tester") status = anyQa ? "working" : "idle";
      else if (zone === "planning") status = T <= firstEvAt ? "working" : "idle";
      else status = "idle";
      return {
        id: w.id,
        name: w.name || w.id,
        status,
        team: zone,
        summary:
          (w.model ? w.model + " · " : "") +
          "$" +
          (+w.costUsd || 0).toFixed(2) +
          " · " +
          fmtK(w.tokensIn) +
          " in / " +
          fmtK(w.tokensOut) +
          " out",
        startedAt: RP.run.startedAt || RP.t0
      };
    });
  }
  function renderReplay() {
    if (!RP.active) return;
    const T = RP.sim;
    const board = boardAt(T);
    const span = Math.max(1, RP.t1 - RP.t0);
    const prog = Math.max(0, Math.min(1, (T - RP.t0) / span));
    const doneN = board.filter((t) => t.state === "done").length;
    const failN = board.filter((t) => t.state === "failed").length;
    const tot = (RP.run && RP.run.totals) || {};
    const bud = RP.run && RP.run.budget;
    const orch = {
      active: T < RP.t1,
      phase: T < RP.t1 ? "building" : "done",
      runId: RP.run.runId,
      paused: false,
      epic: RP.run.epic || RP.run.runId,
      summary: RP.run.summary || "",
      budget:
        bud && +bud.capUsd > 0
          ? { capUsd: +bud.capUsd, spentUsd: (+bud.spentUsd || 0) * prog }
          : null,
      totals: {
        tasksDone: doneN,
        tasksFailed: failN,
        tokensIn: ((+tot.tokensIn || 0) * prog) | 0,
        tokensOut: ((+tot.tokensOut || 0) * prog) | 0,
        costUsd: (+tot.costUsd || 0) * prog,
        startedAt: RP.run.startedAt || RP.t0,
        tasksPerHour: +tot.tasksPerHour || 0
      },
      workers: RP.run.workers || [],
      board,
      log: logAt(T)
    };
    // demo:true keeps every control disabled during replay
    ingest({
      demo: true,
      sessions: sessionsAt(T, board),
      knowledge: null,
      orch,
      error: null
    });
    $("rp-scrub").value = String((prog * 1000) | 0);
    $("rp-time").textContent = fmtDur(T - RP.t0) + " / " + fmtDur(span);
    $("rp-play").textContent = RP.playing
      ? "PAUSE"
      : T >= RP.t1
        ? "REPLAY"
        : "PLAY";
  }
  async function initReplay(id) {
    const demoQ =
      new URL(window.location.href).searchParams.get("demo") === "1"
        ? "?demo=1"
        : "";
    let run = null;
    try {
      const r = await fetch("/api/history/" + encodeURIComponent(id) + demoQ);
      if (r.ok) run = await r.json();
    } catch (e) {
      /* fall through to error toast */
    }
    if (!run || run.error || !Array.isArray(run.board)) {
      window.__replayMode = false; // resume normal polling
      toast("replay: run not found — " + id, true);
      return;
    }
    RP.active = true;
    RP.run = run;
    RP.ev = (run.events || [])
      .slice()
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    RP.t0 = run.startedAt || (RP.ev.length ? RP.ev[0].at : Date.now());
    RP.t1 = run.endedAt || (RP.ev.length ? RP.ev[RP.ev.length - 1].at : 0);
    if (RP.t1 <= RP.t0) RP.t1 = RP.t0 + 60e3;
    RP.speed = (RP.t1 - RP.t0) / 45000; // whole run plays back in ~45s
    RP.sim = RP.t0;
    RP.playing = true;
    $("replaybar").style.display = "flex";
    $("replaychip").style.display = "block";
    $("rp-epic").textContent = run.epic || run.runId;
    $("rp-exit").href = demoQ || "?";
    const live = $("live");
    if (live) live.style.display = "none";
    $("rp-play").addEventListener("click", () => {
      if (!RP.playing && RP.sim >= RP.t1) RP.sim = RP.t0; // restart from top
      RP.playing = !RP.playing;
      renderReplay();
    });
    $("rp-scrub").addEventListener("input", (e) => {
      RP.sim = RP.t0 + (+e.target.value / 1000) * (RP.t1 - RP.t0);
      renderReplay();
    });
    renderReplay();
  }

  // ---- shared rAF: animated cost counter, elapsed clock, replay playback ------
  let lastTs = performance.now();
  function tick(ts) {
    const dt = Math.min(ts - lastTs, 200);
    lastTs = ts;
    // cost eases toward its target so spend visibly "counts up"
    anim.cost += (anim.target - anim.cost) * Math.min(1, dt / 300);
    if (Math.abs(anim.target - anim.cost) < 0.0005) anim.cost = anim.target;
    $("h-cost").textContent = anim.have ? fmtMoney(anim.cost) : "—";
    // elapsed
    const tot = lastOrch && lastOrch.totals;
    if (tot && tot.startedAt) {
      const now = RP.active
        ? RP.sim
        : lastOrch.active === false && lastOrch.updatedAt
          ? lastOrch.updatedAt
          : Date.now();
      $("h-elapsed").textContent = fmtDur(now - tot.startedAt);
    } else {
      $("h-elapsed").textContent = "—";
    }
    // replay playback
    if (RP.active && RP.playing) {
      RP.sim += dt * RP.speed;
      if (RP.sim >= RP.t1) {
        RP.sim = RP.t1;
        RP.playing = false;
      }
      if (ts - RP.lastRender > 250 || !RP.playing) {
        RP.lastRender = ts;
        renderReplay();
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---- engine hook -------------------------------------------------------------
  window.OfficeExtras = {
    onState(data) {
      lastDemo = !!(data && data.demo);
      lastOrch = (data && data.orch) || null;
      updateHud();
      updateControls();
      $("paused").style.display =
        lastOrch && lastOrch.paused && !RP.active ? "block" : "none";
    },
    control,
    toast
  };

  // ---- boot ---------------------------------------------------------------------
  const replayId = new URL(window.location.href).searchParams.get("replay");
  if (replayId) initReplay(replayId);
})();
