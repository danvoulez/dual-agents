#!/usr/bin/env node
/**
 * Oz Local Orchestrator (no Docker)
 * - Premium LLM: planning + review (mode: "premium")
 * - Local LLM: code generation (mode: "local")
 * - Linear: issue intake + state transitions + comments
 *
 * Env vars:
 *   LINEAR_API_KEY        (required)
 *   LINEAR_TEAM_KEY       e.g. "DAN"
 *   LINEAR_TEAM_ID        alternative to LINEAR_TEAM_KEY
 *   LINEAR_STATE_TODO     (default: "Todo")
 *   LINEAR_STATE_IN_PROGRESS (default: "In Progress")
 *   LINEAR_STATE_DONE     (default: "Done")
 *   GATEWAY_URL           (default: http://localhost:3000/v1/chat/completions)
 *   GATEWAY_API_KEY       (optional)
 *   REPO_ROOT             (default: process.cwd())
 *   CI_CMD                (default: pnpm -r test)
 *   OZ_MAX_CONTEXT_FILES  (default: 8)
 *   OZ_MAX_FILE_BYTES     (default: 12000)
 *   OZ_POLL_INTERVAL_MS   (default: 30000)
 *
 * Assumes:
 * - Linear GraphQL endpoint: https://api.linear.app/graphql
 * - Gateway OpenAI-compatible endpoint: ${GATEWAY_URL}
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cfg = {
  linearApiKey: mustEnv("LINEAR_API_KEY"),
  linearTeamKey: process.env.LINEAR_TEAM_KEY || "",
  linearTeamId: process.env.LINEAR_TEAM_ID || "",
  linearStateTodo: process.env.LINEAR_STATE_TODO || "Todo",
  linearStateInProgress: process.env.LINEAR_STATE_IN_PROGRESS || "In Progress",
  linearStateDone: process.env.LINEAR_STATE_DONE || "Done",

  gatewayUrl: process.env.GATEWAY_URL || "http://localhost:3000/v1/chat/completions",
  gatewayApiKey: process.env.GATEWAY_API_KEY || "",

  repoRoot: process.env.REPO_ROOT || process.cwd(),
  ciCmd: process.env.CI_CMD || "pnpm -r test",

  maxContextFiles: parseInt(process.env.OZ_MAX_CONTEXT_FILES || "8", 10),
  maxFileBytes: parseInt(process.env.OZ_MAX_FILE_BYTES || "12000", 10),
  pollIntervalMs: parseInt(process.env.OZ_POLL_INTERVAL_MS || "30000", 10),

  dryRun: process.argv.includes("--dry-run"),
  once: process.argv.includes("--once"),
  issueIdArg: getArg("--issue"),
};

/* --------------------------------- constants --------------------------------- */

const MAX_CI_OUTPUT_BYTES = 12_000;

main().catch((e) => {
  log("fatal", { error: String(e?.stack || e) });
  process.exit(1);
});

async function main() {
  log("boot", {
    repoRoot: cfg.repoRoot,
    gatewayUrl: cfg.gatewayUrl,
    ciCmd: cfg.ciCmd,
    modeSplit: { planner: "premium", coder: "local", reviewer: "premium" },
  });

  const teamId = cfg.linearTeamId || (await getTeamIdByKey(cfg.linearTeamKey));
  if (!teamId) throw new Error("Could not resolve Linear team id (set LINEAR_TEAM_ID or LINEAR_TEAM_KEY).");

  while (true) {
    const issue = cfg.issueIdArg
      ? await getIssue(cfg.issueIdArg)
      : await pickNextIssue(teamId, [cfg.linearStateTodo]);

    if (!issue) {
      log("idle", { note: "No eligible issues found." });
      if (cfg.once) return;
      await sleep(cfg.pollIntervalMs);
      continue;
    }

    log("issue.selected", { identifier: issue.identifier, title: issue.title, state: issue.state?.name });

    // Move to In Progress
    await moveIssueToState(teamId, issue.id, cfg.linearStateInProgress);

    // Build repo context (lightweight)
    const context = buildRepoContext(issue);

    // 1) PLAN (premium)
    const plan = await premiumPlan(issue, context);

    await addLinearComment(issue.id, [
      `### Oz: Plan (premium)`,
      `**Summary:** ${plan.summary || "(no summary)"}`,
      `**Approach:** ${plan.approach || "(no approach)"}`,
      `**Files:**`,
      ...(plan.files || []).map((f) => `- \`${f.path}\` (${f.action}) — ${f.purpose || ""}`),
      ``,
      `> Next: local coder will generate patches + run CI.`,
    ].join("\n"));

    if (cfg.dryRun) {
      log("dry_run.stop_after_plan", { identifier: issue.identifier });
      return;
    }

    // 2) CODE (local) => unified diff
    const diff = await localCode(issue, plan, context);

    if (!diff?.trim()) {
      await addLinearComment(issue.id, `### Oz: coder returned empty diff\nAborting.`);
      await failAndStop(issue, "Empty diff from local coder.");
      continue;
    }

    // Apply patch
    const applied = applyGitPatch(diff);
    if (!applied.ok) {
      await addLinearComment(issue.id, [
        `### Oz: patch apply failed`,
        "```",
        applied.stderr || applied.stdout || "(no output)",
        "```",
      ].join("\n"));
      await failAndStop(issue, "Patch apply failed.");
      continue;
    }

    // 3) CI
    const ci = run(cfg.ciCmd, { cwd: cfg.repoRoot });
    const ciOk = ci.code === 0;

    // 4) REVIEW (premium) — include diff + CI output
    const review = await premiumReview(issue, diff, ciOk, (ci.stdout + "\n" + ci.stderr).slice(0, MAX_CI_OUTPUT_BYTES));

    // Always comment evidence
    await addLinearComment(issue.id, [
      `### Oz: Review (premium)`,
      `**Verdict:** ${review.verdict}`,
      review.manual_required ? `**Manual required:** YES` : `**Manual required:** no`,
      review.blockers?.length ? `**Blockers:**\n${review.blockers.map((b) => `- ${b}`).join("\n")}` : `**Blockers:** none`,
      review.notes?.length ? `**Notes:**\n${review.notes.map((n) => `- ${n}`).join("\n")}` : ``,
      ``,
      `### Oz: CI`,
      `**Status:** ${ciOk ? "PASS" : "FAIL"}`,
      "```",
      (ci.stdout + "\n" + ci.stderr).slice(0, MAX_CI_OUTPUT_BYTES),
      "```",
    ].filter(Boolean).join("\n"));

    // Gate decisions
    if (!ciOk || review.verdict !== "APPROVE" || review.manual_required) {
      await failAndStop(issue, `Gate blocked (ciOk=${ciOk}, verdict=${review.verdict}, manual=${review.manual_required}).`);
      continue;
    }

    // Commit + mark done (swap to PR flow later if needed)
    const commitMsg = plan.commit_message || `oz: ${issue.identifier} ${issue.title}`;
    git(["add", "-A"]);
    const commitRes = git(["commit", "-m", commitMsg]);
    if (commitRes.code !== 0) {
      await addLinearComment(issue.id, [
        `### Oz: git commit failed`,
        "```",
        commitRes.stderr || commitRes.stdout || "(no output)",
        "```",
      ].join("\n"));
      await failAndStop(issue, "Git commit failed.");
      continue;
    }

    await moveIssueToState(teamId, issue.id, cfg.linearStateDone);
    log("issue.done", { identifier: issue.identifier });

    if (cfg.once || cfg.issueIdArg) return;
  }
}

/* ----------------------------- Linear helpers ----------------------------- */

async function linearGql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: cfg.linearApiKey.startsWith("Bearer ") ? cfg.linearApiKey : `Bearer ${cfg.linearApiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors || json, null, 2)}`);
  }
  return json.data;
}

async function getTeamIdByKey(teamKey) {
  if (!teamKey) return "";
  const q = `
    query TeamByKey($key: String!) {
      teams(filter: { key: { eq: $key } }) { nodes { id key name } }
    }
  `;
  const data = await linearGql(q, { key: teamKey });
  return data.teams.nodes?.[0]?.id || "";
}

async function getTeamStates(teamId) {
  const q = `
    query TeamStates($id: String!) {
      team(id: $id) {
        id
        name
        states { nodes { id name type position } }
      }
    }
  `;
  const data = await linearGql(q, { id: teamId });
  return data.team?.states?.nodes || [];
}

async function getIssue(issueIdOrIdentifier) {
  const q = `
    query Issue($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        url
        priority
        state { id name type }
        labels { nodes { id name } }
      }
    }
  `;
  const data = await linearGql(q, { id: issueIdOrIdentifier });
  return data.issue;
}

async function pickNextIssue(teamId, allowedStateNames) {
  const q = `
    query TeamIssues($id: String!, $first: Int!, $stateNames: [String!]!) {
      team(id: $id) {
        issues(filter: { state: { name: { in: $stateNames } } }, first: $first) {
          nodes {
            id
            identifier
            title
            description
            url
            priority
            createdAt
            updatedAt
            state { id name type }
            labels { nodes { id name } }
          }
        }
      }
    }
  `;
  const data = await linearGql(q, { id: teamId, first: 25, stateNames: allowedStateNames });
  const nodes = data.team?.issues?.nodes || [];
  if (!nodes.length) return null;

  // Sort by priority descending (highest first)
  nodes.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return nodes[0];
}

async function moveIssueToState(teamId, issueId, targetStateName) {
  const states = await getTeamStates(teamId);
  const target = states.find((s) => s.name === targetStateName);
  if (!target) throw new Error(`State not found on team: ${targetStateName}`);

  const m = `
    mutation IssueUpdate($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { id state { id name } }
      }
    }
  `;
  await linearGql(m, { id: issueId, stateId: target.id });
  log("linear.state", { issueId, state: targetStateName });
}

async function addLinearComment(issueId, body) {
  const m = `
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id }
      }
    }
  `;
  try {
    await linearGql(m, { input: { issueId, body } });
  } catch (e) {
    // Comment failure shouldn't brick the run
    log("warn.linear.comment_failed", { error: String(e) });
  }
}

/* ----------------------------- Gateway helpers ---------------------------- */

async function gatewayChat({ mode, messages, temperature = 0.2, max_tokens = 4096 }) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.gatewayApiKey) {
    headers.Authorization = cfg.gatewayApiKey.startsWith("Bearer ")
      ? cfg.gatewayApiKey
      : `Bearer ${cfg.gatewayApiKey}`;
  }

  const res = await fetch(cfg.gatewayUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages,
      temperature,
      max_tokens,
      stream: false,
      mode, // "premium" | "local"
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gateway error ${res.status}: ${JSON.stringify(json)}`);

  const text =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.delta?.content ??
    "";

  return String(text);
}

async function premiumPlan(issue, context) {
  const system = [
    `You are the PREMIUM planner.`,
    `Goal: produce a concrete implementation plan that a LOCAL coder can execute.`,
    `Return STRICT JSON only.`,
    `Constraints: max 8 file items; prefer patches; be explicit about commands/tests.`,
  ].join("\n");

  const user = [
    `ISSUE: ${issue.identifier} — ${issue.title}`,
    ``,
    `DESCRIPTION:\n${issue.description || "(none)"}`,
    ``,
    `REPO CONTEXT (snippets):\n${context}`,
    ``,
    `OUTPUT JSON SCHEMA:`,
    `{`,
    `  "summary": "string",`,
    `  "approach": "string",`,
    `  "files": [`,
    `     { "path":"string", "action":"create|modify|delete", "purpose":"string", "spec":"string" }`,
    `  ],`,
    `  "commands": ["string"],`,
    `  "commit_message": "string"`,
    `}`,
  ].join("\n");

  const raw = await gatewayChat({
    mode: "premium",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  });

  return safeJson(raw, "plan");
}

async function localCode(issue, plan, context) {
  const system = [
    `You are the LOCAL coder.`,
    `You write production-quality code and output a single UNIFIED DIFF patch.`,
    `Do NOT include explanations. Output ONLY the diff.`,
    `If you need to add files, include them in the diff.`,
  ].join("\n");

  const user = [
    `ISSUE: ${issue.identifier} — ${issue.title}`,
    ``,
    `PLAN JSON:\n${JSON.stringify(plan, null, 2)}`,
    ``,
    `REPO CONTEXT (snippets):\n${context}`,
    ``,
    `Generate ONE unified diff against the repository root.`,
    `Remember: output ONLY the diff.`,
  ].join("\n");

  const diff = await gatewayChat({
    mode: "local",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: 4096,
  });

  return diff;
}

async function premiumReview(issue, diff, ciOk, ciOutput) {
  const system = [
    `You are the PREMIUM reviewer.`,
    `You review diffs + CI evidence and decide gate outcome.`,
    `Return STRICT JSON only.`,
    `If this change touches an INFLECTION CHECKPOINT, set manual_required=true.`,
  ].join("\n");

  const user = [
    `ISSUE: ${issue.identifier} — ${issue.title}`,
    ``,
    `CI_OK: ${ciOk}`,
    `CI_OUTPUT:\n${ciOutput || "(none)"}`,
    ``,
    `DIFF:\n${diff}`,
    ``,
    `OUTPUT JSON SCHEMA:`,
    `{`,
    `  "verdict": "APPROVE|CHANGES|REJECT",`,
    `  "manual_required": true|false,`,
    `  "blockers": ["string"],`,
    `  "notes": ["string"]`,
    `}`,
  ].join("\n");

  const raw = await gatewayChat({
    mode: "premium",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  });

  const out = safeJson(raw, "review");
  out.verdict ||= "CHANGES";
  out.manual_required = Boolean(out.manual_required);
  out.blockers ||= [];
  out.notes ||= [];
  return out;
}

/* ----------------------------- Repo context ------------------------------ */

function buildRepoContext(issue) {
  const keywords = tokenize(`${issue.title} ${issue.description || ""}`).slice(0, 24);
  const files = listFiles(cfg.repoRoot, {
    includeExt: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".toml", ".json", ".yml", ".yaml", ".md"],
    ignoreDirs: new Set([".git", "node_modules", "dist", "build", "target", ".turbo", ".next"]),
  });

  const scored = files
    .map((p) => ({ p, score: scorePath(p, keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.maxContextFiles)
    .map(({ p }) => p);

  let out = "";
  for (const p of scored) {
    const full = path.join(cfg.repoRoot, p);
    const buf = safeRead(full, cfg.maxFileBytes);
    out += `\n---\nFILE: ${p}\n${buf}\n`;
  }
  return out.trim() || "(no context files selected)";
}

function listFiles(root, { includeExt, ignoreDirs }) {
  const out = [];
  walk(root, "");
  return out;

  function walk(absDir, relDir) {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name)) continue;
        walk(path.join(absDir, e.name), path.join(relDir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!includeExt.includes(ext)) continue;
        out.push(path.join(relDir, e.name));
      }
    }
  }
}

function scorePath(p, keywords) {
  const s = p.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    if (k.length < 3) continue;
    if (s.includes(k)) score += 3;
  }
  // Prefer non-test files slightly
  if (!s.includes("test") && !s.includes("__tests__")) score += 1;
  return score;
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter(Boolean);
}

function safeRead(file, maxBytes) {
  try {
    const buf = fs.readFileSync(file);
    return buf.slice(0, maxBytes).toString("utf8");
  } catch {
    return "(unreadable)";
  }
}

/* ----------------------------- Git + patch ------------------------------- */

function applyGitPatch(diff) {
  return run("git apply --whitespace=nowarn -", {
    cwd: cfg.repoRoot,
    input: diff,
  });
}

function git(args) {
  return run(["git", ...args].join(" "), { cwd: cfg.repoRoot });
}

/* --------------------------------- util --------------------------------- */

function run(cmd, { cwd, input } = {}) {
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    input: input ? Buffer.from(input, "utf8") : undefined,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return { code: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "", ok: (result.status ?? 1) === 0 };
}

function safeJson(raw, label) {
  const txt = String(raw || "").trim();
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`Could not parse ${label} JSON (no braces). Raw:\n${txt}`);
  }
  const slice = txt.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (e) {
    throw new Error(`Could not parse ${label} JSON. Error=${String(e)} Raw:\n${slice}`);
  }
}

async function failAndStop(issue, reason) {
  log("gate.blocked", { identifier: issue.identifier, reason });
  // Keep issue in progress; human can inspect comment evidence
}

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return "";
  return process.argv[i + 1] || "";
}

function mustEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

function log(event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  process.stdout.write(line + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
