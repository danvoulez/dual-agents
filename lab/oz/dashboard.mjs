#!/usr/bin/env node
/**
 * Oz Dashboard — live web UI for the oz-local orchestrator
 *
 * Tails an NDJSON log file written by oz-local.mjs and streams events
 * to connected browsers via Server-Sent Events (SSE).
 *
 * Env vars:
 *   OZ_LOG_FILE   Path to the NDJSON log file (default: ./oz.log)
 *   DASH_PORT     HTTP port (default: 4000)
 *   DASH_HOST     Bind host (default: 127.0.0.1)
 *
 * Usage:
 *   # In one terminal – run the orchestrator and write its logs to a file:
 *   node lab/oz/oz-local.mjs 2>&1 | tee oz.log
 *
 *   # In another terminal – start the dashboard:
 *   node lab/oz/dashboard.mjs
 *   # Then open http://localhost:4000
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_FILE = process.env.OZ_LOG_FILE || path.join(process.cwd(), "oz.log");
const PORT = parseInt(process.env.DASH_PORT || "4000", 10);
const HOST = process.env.DASH_HOST || "127.0.0.1";

/* ── SSE client registry ────────────────────────────────────────────────── */
const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

/* ── Log file tailer ────────────────────────────────────────────────────── */
let fileSize = 0;
let tailBuffer = "";

function startTail() {
  // Seed with existing content first
  if (fs.existsSync(LOG_FILE)) {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    fileSize = Buffer.byteLength(content, "utf8");
    // Parse and re-broadcast historic lines for new SSE clients
    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      try { broadcast({ type: "log", entry: JSON.parse(line) }); } catch { /* skip */ }
    }
  }

  // Watch for new bytes
  fs.watchFile(LOG_FILE, { interval: 500, persistent: false }, () => {
    let stat;
    try { stat = fs.statSync(LOG_FILE); } catch { return; }
    if (stat.size <= fileSize) {
      // File was truncated/rotated – reset
      fileSize = 0;
      tailBuffer = "";
      broadcast({ type: "reset" });
    }
    const delta = stat.size - fileSize;
    if (delta <= 0) return;
    const fd = fs.openSync(LOG_FILE, "r");
    const buf = Buffer.alloc(delta);
    fs.readSync(fd, buf, 0, delta, fileSize);
    fs.closeSync(fd);
    fileSize = stat.size;

    tailBuffer += buf.toString("utf8");
    const parts = tailBuffer.split("\n");
    tailBuffer = parts.pop(); // keep incomplete tail
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        broadcast({ type: "log", entry });
      } catch { /* ignore malformed lines */ }
    }
  });
}

/* ── HTML dashboard (self-contained) ───────────────────────────────────── */
const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Oz Dashboard</title>
<style>
  /* ── reset & tokens ─────────────────────────────────── */
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0d1117;--surface:#161b22;--surface2:#21262d;--surface3:#30363d;
    --border:#30363d;--text:#e6edf3;--text2:#8b949e;--text3:#656d76;
    --green:#3fb950;--yellow:#d29922;--red:#f85149;--blue:#58a6ff;
    --purple:#bc8cff;--orange:#ffa657;--teal:#39d353;
    --r:8px;--r2:12px;
    --font:'Inter',system-ui,-apple-system,sans-serif;
  }
  html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
  a{color:var(--blue);text-decoration:none}
  a:hover{text-decoration:underline}

  /* ── layout ──────────────────────────────────────────── */
  .app{display:grid;grid-template-rows:56px 1fr;height:100vh;overflow:hidden}
  .topbar{display:flex;align-items:center;gap:12px;padding:0 20px;border-bottom:1px solid var(--border);background:var(--surface);z-index:10}
  .topbar-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px;letter-spacing:.5px}
  .topbar-logo svg{flex-shrink:0}
  .topbar-spacer{flex:1}
  .conn-dot{width:8px;height:8px;border-radius:50%;background:var(--text3);transition:background .3s}
  .conn-dot.live{background:var(--green);box-shadow:0 0 6px var(--green)}
  .conn-label{color:var(--text2);font-size:12px}
  .ts{color:var(--text3);font-size:11px;font-variant-numeric:tabular-nums}

  .body{display:grid;grid-template-columns:320px 1fr;grid-template-rows:1fr;overflow:hidden}
  .sidebar{border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;background:var(--surface)}
  .main{display:flex;flex-direction:column;overflow:hidden}

  /* ── panels ─────────────────────────────────────────── */
  .panel{border-bottom:1px solid var(--border);padding:14px 16px}
  .panel-title{font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--text3);margin-bottom:10px}

  /* ── phase indicator ────────────────────────────────── */
  .phase-ring{display:flex;align-items:center;justify-content:center;padding:18px 0 14px}
  .ring-wrap{position:relative;width:96px;height:96px}
  .ring-svg{transform:rotate(-90deg)}
  .ring-bg{fill:none;stroke:var(--surface3);stroke-width:6}
  .ring-fg{fill:none;stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset .6s ease,stroke .4s}
  .ring-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
  .ring-icon{font-size:22px}
  .ring-label{font-size:10px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:.5px}

  /* ── stat cards ─────────────────────────────────────── */
  .stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .stat-card{background:var(--surface2);border-radius:var(--r);padding:10px 12px;border:1px solid var(--border)}
  .stat-val{font-size:24px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
  .stat-lbl{font-size:11px;color:var(--text2);margin-top:3px}
  .stat-val.green{color:var(--green)}
  .stat-val.red{color:var(--red)}
  .stat-val.yellow{color:var(--yellow)}
  .stat-val.blue{color:var(--blue)}

  /* ── current issue ──────────────────────────────────── */
  .issue-card{background:var(--surface2);border-radius:var(--r);padding:12px;border:1px solid var(--border)}
  .issue-id{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--blue);background:rgba(88,166,255,.1);border-radius:4px;padding:2px 7px;margin-bottom:6px}
  .issue-title{font-size:13px;font-weight:600;line-height:1.4;word-break:break-word}
  .issue-state{display:inline-flex;align-items:center;gap:5px;margin-top:6px;font-size:11px;color:var(--text2)}
  .issue-dot{width:7px;height:7px;border-radius:50%}
  .empty-issue{color:var(--text3);font-size:12px;font-style:italic}

  /* ── mini CI bar ─────────────────────────────────────── */
  .ci-bar{display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:var(--r);padding:10px 12px;border:1px solid var(--border)}
  .ci-icon{font-size:18px;line-height:1}
  .ci-label{font-size:12px;font-weight:600}
  .ci-sub{font-size:11px;color:var(--text2);margin-top:1px}

  /* ── activity feed ──────────────────────────────────── */
  .feed-wrap{flex:1;overflow-y:auto;padding:10px 0;scroll-behavior:smooth}
  .feed-wrap::-webkit-scrollbar{width:6px}
  .feed-wrap::-webkit-scrollbar-track{background:transparent}
  .feed-wrap::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:3px}
  .feed-item{display:flex;gap:10px;padding:5px 16px;transition:background .15s;cursor:default}
  .feed-item:hover{background:var(--surface2)}
  .feed-time{color:var(--text3);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;padding-top:1px;min-width:58px}
  .feed-badge{font-size:10px;font-weight:700;border-radius:4px;padding:1px 6px;white-space:nowrap;align-self:flex-start;margin-top:1px;flex-shrink:0}
  .feed-content{font-size:12px;color:var(--text);word-break:break-word;flex:1}
  .feed-content code{font-family:'JetBrains Mono','Fira Mono',monospace;font-size:11px;background:var(--surface3);padding:1px 4px;border-radius:3px}
  .badge-boot{background:rgba(88,166,255,.2);color:var(--blue)}
  .badge-plan{background:rgba(188,140,255,.2);color:var(--purple)}
  .badge-code{background:rgba(255,166,87,.2);color:var(--orange)}
  .badge-review{background:rgba(57,211,83,.2);color:var(--teal)}
  .badge-ci{background:rgba(210,153,34,.2);color:var(--yellow)}
  .badge-done{background:rgba(63,185,80,.2);color:var(--green)}
  .badge-blocked{background:rgba(248,81,73,.2);color:var(--red)}
  .badge-warn{background:rgba(210,153,34,.15);color:var(--yellow)}
  .badge-info{background:rgba(139,148,158,.15);color:var(--text2)}
  .badge-fatal{background:rgba(248,81,73,.3);color:var(--red)}

  /* ── main content area ───────────────────────────────── */
  .main-header{display:flex;align-items:center;gap:12px;padding:14px 20px 10px;border-bottom:1px solid var(--border);background:var(--surface)}
  .main-header-title{font-size:15px;font-weight:700;flex:1}
  .auto-scroll-btn{font-size:11px;color:var(--text2);cursor:pointer;display:flex;align-items:center;gap:5px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:3px 8px;transition:color .2s,border-color .2s}
  .auto-scroll-btn:hover{color:var(--text);border-color:var(--text2)}
  .auto-scroll-btn.active{color:var(--green);border-color:var(--green)}

  /* ── issue history table ─────────────────────────────── */
  .table-wrap{overflow-y:auto;flex:1}
  .table-wrap::-webkit-scrollbar{width:6px}
  .table-wrap::-webkit-scrollbar-track{background:transparent}
  .table-wrap::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:3px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  thead th{position:sticky;top:0;background:var(--surface);padding:9px 14px;text-align:left;font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)}
  tbody tr{border-bottom:1px solid var(--border);transition:background .1s}
  tbody tr:hover{background:var(--surface2)}
  tbody td{padding:9px 14px;vertical-align:middle}
  .pill{display:inline-flex;align-items:center;gap:4px;border-radius:12px;font-size:11px;font-weight:600;padding:2px 8px}
  .pill-green{background:rgba(63,185,80,.15);color:var(--green)}
  .pill-red{background:rgba(248,81,73,.15);color:var(--red)}
  .pill-yellow{background:rgba(210,153,34,.15);color:var(--yellow)}
  .pill-blue{background:rgba(88,166,255,.15);color:var(--blue)}
  .pill-purple{background:rgba(188,140,255,.15);color:var(--purple)}

  /* ── throughput sparkline ────────────────────────────── */
  .spark-wrap{padding:14px 16px 10px}
  .spark-canvas-row{display:flex;align-items:flex-end;gap:3px;height:40px}
  .spark-bar{flex:1;min-width:4px;background:var(--surface3);border-radius:2px 2px 0 0;transition:height .4s ease,background .3s}
  .spark-bar.has-data{background:var(--blue)}
  .spark-label-row{display:flex;justify-content:space-between;margin-top:4px;font-size:10px;color:var(--text3)}

  /* ── empty states ────────────────────────────────────── */
  .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:var(--text3)}
  .empty-state svg{opacity:.3}
  .empty-state p{font-size:13px}

  /* ── animations ──────────────────────────────────────── */
  @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .feed-item-new{animation:fadeIn .25s ease forwards}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .pulsing{animation:pulse 1.5s ease-in-out infinite}

  /* ── responsive ──────────────────────────────────────── */
  @media(max-width:780px){
    .body{grid-template-columns:1fr}
    .sidebar{max-height:320px;border-right:none;border-bottom:1px solid var(--border)}
  }
</style>
</head>
<body>
<div class="app">
  <!-- top bar -->
  <header class="topbar">
    <div class="topbar-logo">
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <circle cx="11" cy="11" r="10" stroke="#58a6ff" stroke-width="1.5"/>
        <path d="M7 11c0-2.2 1.8-4 4-4s4 1.8 4 4-1.8 4-4 4" stroke="#bc8cff" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="11" cy="11" r="2" fill="#58a6ff"/>
      </svg>
      Oz Dashboard
    </div>
    <div class="topbar-spacer"></div>
    <span class="conn-dot" id="connDot"></span>
    <span class="conn-label" id="connLabel">connecting…</span>
    <span class="ts" id="clockEl"></span>
  </header>

  <div class="body">
    <!-- ── sidebar ─────────────────────────────────────── -->
    <aside class="sidebar">

      <!-- phase ring -->
      <div class="panel phase-ring" style="padding:18px 16px 14px">
        <div class="ring-wrap">
          <svg class="ring-svg" width="96" height="96" viewBox="0 0 96 96">
            <circle class="ring-bg" cx="48" cy="48" r="42"/>
            <circle class="ring-fg" id="ringFg" cx="48" cy="48" r="42"
              stroke-dasharray="263.9" stroke-dashoffset="263.9" stroke="var(--blue)"/>
          </svg>
          <div class="ring-center">
            <span class="ring-icon" id="phaseIcon">💤</span>
            <span class="ring-label" id="phaseLabel">idle</span>
          </div>
        </div>
      </div>

      <!-- stats -->
      <div class="panel">
        <div class="panel-title">Stats</div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-val green" id="statDone">0</div>
            <div class="stat-lbl">Done</div>
          </div>
          <div class="stat-card">
            <div class="stat-val red" id="statBlocked">0</div>
            <div class="stat-lbl">Blocked</div>
          </div>
          <div class="stat-card">
            <div class="stat-val yellow" id="statInProgress">0</div>
            <div class="stat-lbl">In Progress</div>
          </div>
          <div class="stat-card">
            <div class="stat-val blue" id="statTotal">0</div>
            <div class="stat-lbl">Total Seen</div>
          </div>
        </div>
      </div>

      <!-- current issue -->
      <div class="panel">
        <div class="panel-title">Current Issue</div>
        <div id="currentIssue" class="empty-issue">No active issue</div>
      </div>

      <!-- CI status -->
      <div class="panel">
        <div class="panel-title">Last CI</div>
        <div class="ci-bar" id="ciBar">
          <span class="ci-icon">⏳</span>
          <div>
            <div class="ci-label" id="ciLabel">Waiting…</div>
            <div class="ci-sub" id="ciSub">—</div>
          </div>
        </div>
      </div>

      <!-- 7-day throughput sparkline -->
      <div class="spark-wrap">
        <div class="panel-title" style="margin-bottom:8px">Throughput (last 12 hours)</div>
        <div class="spark-canvas-row" id="sparkBars"></div>
        <div class="spark-label-row" id="sparkLabels"></div>
      </div>
    </aside>

    <!-- ── main ────────────────────────────────────────── -->
    <main class="main">
      <div class="main-header">
        <div class="main-header-title">Live Activity Feed</div>
        <button class="auto-scroll-btn active" id="autoScrollBtn" onclick="toggleAutoScroll()">
          <span>⬇</span> Auto-scroll
        </button>
      </div>

      <!-- activity feed -->
      <div class="feed-wrap" id="feedWrap">
        <div class="empty-state" id="feedEmpty">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="22" stroke="currentColor" stroke-width="2"/>
            <path d="M16 24h16M24 16v16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <p>Waiting for logs from <code>oz-local.mjs</code>…</p>
          <p style="font-size:11px">Run: <code>node lab/oz/oz-local.mjs 2&gt;&amp;1 | tee oz.log</code></p>
        </div>
      </div>

      <!-- issue history table -->
      <div style="border-top:1px solid var(--border);background:var(--surface);padding:10px 20px 6px;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--text3)">Issue History</span>
        <span style="font-size:11px;color:var(--text3)" id="histCount">0 issues</span>
      </div>
      <div class="table-wrap" style="max-height:220px;border-top:1px solid var(--border)">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Verdict</th>
              <th>CI</th>
              <th>Status</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody id="histBody"></tbody>
        </table>
      </div>
    </main>
  </div>
</div>

<script>
/* ── state ─────────────────────────────────────────────── */
const state = {
  connected: false,
  autoScroll: true,
  stats: { done: 0, blocked: 0, inProgress: 0, total: new Set() },
  currentIssue: null,
  lastCi: null,
  phase: 'idle',
  history: [],          // { id, title, verdict, ciOk, status, ts }
  hourlyBuckets: {},    // "YYYY-MM-DDTHH" => count of done
};

// Convenience alias for the stats sub-object
const stats = state.stats;

/* ── clock ──────────────────────────────────────────────── */
const clockEl = document.getElementById('clockEl');
function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString();
}
tickClock();
setInterval(tickClock, 1000);

/* ── auto-scroll toggle ─────────────────────────────────── */
let autoScroll = true;
function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('autoScrollBtn');
  btn.classList.toggle('active', autoScroll);
}
document.getElementById('feedWrap').addEventListener('scroll', function() {
  const el = this;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (!atBottom && autoScroll) {
    autoScroll = false;
    document.getElementById('autoScrollBtn').classList.remove('active');
  }
});

/* ── phase config ───────────────────────────────────────── */
const PHASES = {
  idle:       { icon: '💤', label: 'Idle',     color: 'var(--text3)', pct: 0   },
  boot:       { icon: '🚀', label: 'Boot',     color: 'var(--blue)',  pct: 5   },
  planning:   { icon: '🧠', label: 'Planning', color: 'var(--purple)',pct: 30  },
  coding:     { icon: '⚙️', label: 'Coding',   color: 'var(--orange)',pct: 55  },
  ci:         { icon: '🔬', label: 'CI',       color: 'var(--yellow)',pct: 75  },
  reviewing:  { icon: '👁️', label: 'Review',   color: 'var(--teal)',  pct: 90  },
  done:       { icon: '✅', label: 'Done',     color: 'var(--green)', pct: 100 },
  blocked:    { icon: '🚫', label: 'Blocked',  color: 'var(--red)',   pct: 100 },
};

function setPhase(name) {
  const p = PHASES[name] || PHASES.idle;
  const circumference = 263.9;
  const offset = circumference - (p.pct / 100) * circumference;
  const ring = document.getElementById('ringFg');
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = p.color;
  document.getElementById('phaseIcon').textContent = p.icon;
  document.getElementById('phaseLabel').textContent = p.label;
}
setPhase('idle');

/* ── event → phase / badge mapping ─────────────────────── */
function eventToPhase(ev) {
  if (ev === 'boot') return 'boot';
  if (ev === 'issue.selected') return 'planning';
  if (ev === 'idle') return 'idle';
  if (ev.startsWith('linear.')) return 'planning';
  if (ev === 'dry_run.stop_after_plan') return 'planning';
  if (ev === 'gate.blocked') return 'blocked';
  if (ev === 'issue.done') return 'done';
  if (ev.includes('ci')) return 'ci';
  if (ev.includes('review')) return 'reviewing';
  if (ev.includes('code') || ev.includes('patch') || ev.includes('apply') || ev.includes('commit')) return 'coding';
  return null;
}

function eventToBadge(ev) {
  if (ev === 'fatal') return 'fatal';
  if (ev === 'boot') return 'boot';
  if (ev === 'issue.done') return 'done';
  if (ev === 'gate.blocked') return 'blocked';
  if (ev.startsWith('warn')) return 'warn';
  if (ev.includes('plan')) return 'plan';
  if (ev.includes('review')) return 'review';
  if (ev.includes('ci') || ev.includes('CI')) return 'ci';
  if (ev.includes('code') || ev.includes('patch') || ev.includes('apply') || ev.includes('commit') || ev.includes('coder')) return 'code';
  return 'info';
}

/* ── format feed entry ──────────────────────────────────── */
function formatEntry(entry) {
  const ev = entry.event || '';
  let text = ev;

  if (ev === 'boot') text = 'Orchestrator started — gateway: ' + (entry.gatewayUrl || '?');
  else if (ev === 'idle') text = 'No eligible issues — ' + (entry.note || 'sleeping…');
  else if (ev === 'issue.selected') text = '📋 ' + (entry.identifier || '') + ' — ' + (entry.title || '');
  else if (ev === 'linear.state') text = 'Linear → ' + (entry.state || '') + ' for ' + (entry.issueId || '');
  else if (ev === 'issue.done') text = '✅ Completed: ' + (entry.identifier || '');
  else if (ev === 'gate.blocked') text = '🚫 Gate blocked — ' + (entry.reason || '');
  else if (ev === 'dry_run.stop_after_plan') text = '🏃 Dry-run: stopped after plan for ' + (entry.identifier || '');
  else if (ev === 'warn.linear.comment_failed') text = '⚠️ Linear comment failed — ' + (entry.error || '');
  else if (ev === 'fatal') text = '💥 FATAL — ' + (entry.error || '');
  else {
    // Fall back: show all keys except ts/event
    const extra = Object.entries(entry)
      .filter(([k]) => k !== 'ts' && k !== 'event')
      .map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v))
      .join(' · ');
    text = ev + (extra ? ' — ' + extra : '');
  }
  return text;
}

/* ── time format ─────────────────────────────────────────── */
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ''; }
}

/* ── render feed item ────────────────────────────────────── */
let feedItemCount = 0;
function addFeedItem(entry, animate = true) {
  const wrap = document.getElementById('feedWrap');
  const empty = document.getElementById('feedEmpty');
  if (empty) empty.remove();

  feedItemCount++;
  if (feedItemCount > 2000) {
    // prune oldest 200
    const items = wrap.querySelectorAll('.feed-item');
    for (let i = 0; i < 200; i++) items[i]?.remove();
    feedItemCount -= 200;
  }

  const badgeClass = 'badge-' + eventToBadge(entry.event || '');
  const text = formatEntry(entry);

  const div = document.createElement('div');
  div.className = 'feed-item' + (animate ? ' feed-item-new' : '');
  div.innerHTML = \`
    <span class="feed-time">\${fmtTime(entry.ts)}</span>
    <span class="feed-badge \${badgeClass}">\${(entry.event || 'log').toUpperCase().slice(0,10)}</span>
    <span class="feed-content">\${escHtml(text)}</span>
  \`;
  wrap.appendChild(div);

  if (autoScroll) wrap.scrollTop = wrap.scrollHeight;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

/* ── update stats & current issue ───────────────────────── */
function processEntry(entry) {
  const ev = entry.event || '';

  // phase
  const p = eventToPhase(ev);
  if (p) setPhase(p);

  // current issue
  if (ev === 'issue.selected') {
    state.currentIssue = { identifier: entry.identifier, title: entry.title, state: entry.state };
    renderCurrentIssue();
    stats.total.add(entry.identifier);
    stats.inProgress++;
    renderStats();
    addHistoryRow(entry.identifier, entry.title, null, null, 'in_progress', entry.ts);
  }
  if (ev === 'idle') {
    state.currentIssue = null;
    renderCurrentIssue();
  }
  if (ev === 'issue.done') {
    const id = entry.identifier;
    stats.done++;
    if (stats.inProgress > 0) stats.inProgress--;
    updateHistoryRow(id, null, null, 'done');
    bumpHourlyBucket(entry.ts);
    renderStats();
    renderSparkline();
  }
  if (ev === 'gate.blocked') {
    const id = entry.identifier;
    stats.blocked++;
    if (stats.inProgress > 0) stats.inProgress--;
    updateHistoryRow(id, null, null, 'blocked');
    renderStats();
  }

  // CI
  if (ev.includes('ci') || ev.includes('CI')) {
    const ciOk = entry.ciOk !== undefined ? entry.ciOk : (ev.includes('pass') || ev.includes('PASS'));
    updateCi(ciOk, entry.ts);
    // update history ci
    if (state.currentIssue) updateHistoryRow(state.currentIssue.identifier, null, ciOk, null);
  }
  // review verdict
  if (ev.includes('review') && entry.verdict) {
    if (state.currentIssue) updateHistoryRow(state.currentIssue.identifier, entry.verdict, null, null);
  }
}

function renderStats() {
  document.getElementById('statDone').textContent = stats.done;
  document.getElementById('statBlocked').textContent = stats.blocked;
  document.getElementById('statInProgress').textContent = stats.inProgress || 0;
  document.getElementById('statTotal').textContent = stats.total.size;
}

function renderCurrentIssue() {
  const el = document.getElementById('currentIssue');
  if (!state.currentIssue) {
    el.innerHTML = '<span class="empty-issue">No active issue</span>';
    return;
  }
  const { identifier, title } = state.currentIssue;
  el.innerHTML = \`
    <div class="issue-card">
      <div class="issue-id">🔖 \${escHtml(identifier || '—')}</div>
      <div class="issue-title">\${escHtml(title || '—')}</div>
      <div class="issue-state"><span class="issue-dot pulsing" style="background:var(--yellow)"></span>In Progress</div>
    </div>
  \`;
}

function updateCi(ok, ts) {
  state.lastCi = { ok, ts };
  const bar = document.getElementById('ciBar');
  bar.innerHTML = \`
    <span class="ci-icon">\${ok ? '✅' : '❌'}</span>
    <div>
      <div class="ci-label" style="color:\${ok ? 'var(--green)' : 'var(--red)'}">\${ok ? 'PASS' : 'FAIL'}</div>
      <div class="ci-sub">\${fmtTime(ts)}</div>
    </div>
  \`;
}

/* ── issue history table ─────────────────────────────────── */
const histMap = new Map(); // id => row element

function addHistoryRow(id, title, verdict, ciOk, status, ts) {
  if (histMap.has(id)) return;
  const tbody = document.getElementById('histBody');
  const tr = document.createElement('tr');
  tr.dataset.id = id;
  tr.innerHTML = buildHistRow(id, title, verdict, ciOk, status, ts);
  tbody.prepend(tr);
  histMap.set(id, tr);
  document.getElementById('histCount').textContent = histMap.size + ' issue' + (histMap.size !== 1 ? 's' : '');
}

function updateHistoryRow(id, verdict, ciOk, status) {
  const tr = histMap.get(id);
  if (!tr) return;
  if (verdict !== null && verdict !== undefined) tr.dataset.verdict = verdict;
  if (ciOk !== null && ciOk !== undefined) tr.dataset.ciOk = String(ciOk);
  if (status) tr.dataset.status = status;
  tr.innerHTML = buildHistRow(
    id,
    tr.dataset.title,
    tr.dataset.verdict,
    tr.dataset.ciOk,
    tr.dataset.status,
    tr.dataset.ts
  );
}

function buildHistRow(id, title, verdict, ciOk, status, ts) {
  const verdictHtml = verdict
    ? \`<span class="pill pill-\${verdict==='APPROVE'?'green':verdict==='REJECT'?'red':'yellow'}">\${escHtml(verdict)}</span>\`
    : '<span style="color:var(--text3)">—</span>';
  const ciHtml = ciOk === undefined || ciOk === null || ciOk === ''
    ? '<span style="color:var(--text3)">—</span>'
    : (String(ciOk) === 'true' ? '<span class="pill pill-green">PASS</span>' : '<span class="pill pill-red">FAIL</span>');
  const statusColor = status === 'done' ? 'green' : status === 'blocked' ? 'red' : 'yellow';
  const statusLabel = status === 'done' ? 'Done' : status === 'blocked' ? 'Blocked' : 'In Progress';
  return \`
    <td><span style="color:var(--blue);font-weight:600">\${escHtml(id||'—')}</span></td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${escHtml(title||'—')}</td>
    <td>\${verdictHtml}</td>
    <td>\${ciHtml}</td>
    <td><span class="pill pill-\${statusColor}">\${statusLabel}</span></td>
    <td style="color:var(--text3)">\${ts ? fmtTime(ts) : '—'}</td>
  \`;
}

// Keep dataset attrs on first build
function addHistoryRowFull(id, title, verdict, ciOk, status, ts) {
  if (histMap.has(id)) return;
  const tbody = document.getElementById('histBody');
  const tr = document.createElement('tr');
  tr.dataset.id = id;
  tr.dataset.title = title || '';
  tr.dataset.verdict = verdict || '';
  tr.dataset.ciOk = ciOk !== null && ciOk !== undefined ? String(ciOk) : '';
  tr.dataset.status = status || 'in_progress';
  tr.dataset.ts = ts || '';
  tr.innerHTML = buildHistRow(id, title, verdict, ciOk, status, ts);
  tbody.prepend(tr);
  histMap.set(id, tr);
  document.getElementById('histCount').textContent = histMap.size + ' issue' + (histMap.size !== 1 ? 's' : '');
}

/* ── sparkline ───────────────────────────────────────────── */
function bumpHourlyBucket(ts) {
  try {
    const d = new Date(ts || Date.now());
    const key = d.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    state.hourlyBuckets[key] = (state.hourlyBuckets[key] || 0) + 1;
  } catch { /* */ }
}

function renderSparkline() {
  const N = 12;
  const now = new Date();
  const buckets = [];
  const labels = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000);
    const key = d.toISOString().slice(0, 13);
    buckets.push(state.hourlyBuckets[key] || 0);
    labels.push(d.getHours() + 'h');
  }
  const max = Math.max(...buckets, 1);

  const barsEl = document.getElementById('sparkBars');
  const labelsEl = document.getElementById('sparkLabels');
  barsEl.innerHTML = '';
  labelsEl.innerHTML = '';

  buckets.forEach((v, i) => {
    const bar = document.createElement('div');
    bar.className = 'spark-bar' + (v > 0 ? ' has-data' : '');
    bar.style.height = Math.max(4, (v / max) * 40) + 'px';
    bar.title = labels[i] + ': ' + v + ' done';
    barsEl.appendChild(bar);
  });

  // show first and last label only
  const first = document.createElement('span');
  first.textContent = labels[0];
  const last = document.createElement('span');
  last.textContent = labels[N - 1];
  labelsEl.appendChild(first);
  labelsEl.appendChild(last);
}
renderSparkline();

/* ── SSE connection ──────────────────────────────────────── */
let es;
let reconnectDelay = 1000;
let resetInProgress = false;

function connect() {
  if (es) { try { es.close(); } catch {} }
  es = new EventSource('/events');

  es.onopen = () => {
    reconnectDelay = 1000;
    const dot = document.getElementById('connDot');
    const lbl = document.getElementById('connLabel');
    dot.classList.add('live');
    lbl.textContent = 'Live';
  };

  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'reset') {
      // log file rotated — clear feed
      const wrap = document.getElementById('feedWrap');
      wrap.innerHTML = '';
      feedItemCount = 0;
      resetInProgress = true;
      return;
    }

    if (msg.type === 'log' && msg.entry) {
      processEntry(msg.entry);
      addFeedItem(msg.entry, !resetInProgress);
      resetInProgress = false;
    }
  };

  es.onerror = () => {
    const dot = document.getElementById('connDot');
    const lbl = document.getElementById('connLabel');
    dot.classList.remove('live');
    lbl.textContent = 'Reconnecting…';
    es.close();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  };
}

connect();
</script>
</body>
</html>`;

/* ── HTTP server ─────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // SSE endpoint
  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    clients.add(res);

    // Replay history from current log file to this new client
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          res.write(`data: ${JSON.stringify({ type: "log", entry })}\n\n`);
        } catch { /* skip */ }
      }
    }

    // Heartbeat to keep connection alive through proxies
    const hb = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); clients.delete(res); }
    }, 25_000);

    req.on("close", () => {
      clearInterval(hb);
      clients.delete(res);
    });
    return;
  }

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, logFile: LOG_FILE }));
    return;
  }

  // Dashboard HTML
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "dashboard.start",
    url: `http://${HOST}:${PORT}`,
    logFile: LOG_FILE,
  }));
});

server.on("error", (err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event: "dashboard.error", error: String(err) }));
  process.exit(1);
});

// Start tailing after server is ready
startTail();
