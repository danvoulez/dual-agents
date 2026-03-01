# Oz Local Orchestrator

A "dual-brain loop" orchestrator that combines a premium LLM (for planning and reviewing) with a local LLM (for code generation and execution), integrated with Linear for issue management.

## Architecture

```
Premium LLM (plan/review)  ←→  Linear (issue tracking)
        ↕
Local LLM (code/exec)
        ↕
Git + CI
```

### Loop

1. **Select** — picks the next `Todo` issue from Linear (or `--issue <ID>` directly)
2. **Plan** — premium LLM produces a JSON implementation plan (files, approach, commit message)
3. **Code** — local LLM generates a unified diff patch
4. **Apply + CI** — patch applied with `git apply`; CI command runs
5. **Review** — premium LLM reviews the diff + CI output and verdicts `APPROVE / CHANGES / REJECT`
6. **Gate** — auto-merge (commit + `Done`) only when CI passes, verdict is `APPROVE`, and `manual_required` is `false`

Inflection checkpoints (`manual_required=true`) leave the issue in `In Progress` with full evidence in a Linear comment.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LINEAR_API_KEY` | ✅ | — | Linear personal API key |
| `LINEAR_TEAM_KEY` | one of | — | Team key, e.g. `DAN` |
| `LINEAR_TEAM_ID` | one of | — | Team UUID (alternative to `LINEAR_TEAM_KEY`) |
| `LINEAR_STATE_TODO` | | `Todo` | Name of the "todo" state |
| `LINEAR_STATE_IN_PROGRESS` | | `In Progress` | Name of the "in progress" state |
| `LINEAR_STATE_DONE` | | `Done` | Name of the "done" state |
| `GATEWAY_URL` | | `http://localhost:3000/v1/chat/completions` | OpenAI-compatible gateway endpoint |
| `GATEWAY_API_KEY` | | — | Gateway API key (if required) |
| `REPO_ROOT` | | `process.cwd()` | Absolute path to the repository root |
| `CI_CMD` | | `pnpm -r test` | Command to run CI |
| `OZ_MAX_CONTEXT_FILES` | | `8` | Max repo files sent as context |
| `OZ_MAX_FILE_BYTES` | | `12000` | Max bytes read per context file |
| `OZ_POLL_INTERVAL_MS` | | `30000` | Polling interval (ms) when no issues are found |

## Usage

```bash
# Export required env vars
export LINEAR_API_KEY="lin_api_..."
export LINEAR_TEAM_KEY="DAN"          # or LINEAR_TEAM_ID="<uuid>"
export GATEWAY_URL="http://localhost:3000/v1/chat/completions"
export CI_CMD="pnpm -r test"

# Run once (picks the next Todo issue, completes it, then exits)
node lab/oz/oz-local.mjs --once

# Run on a specific issue
node lab/oz/oz-local.mjs --issue DAN-117

# Dry-run: plan only, no code generation or CI
node lab/oz/oz-local.mjs --dry-run --issue DAN-117

# Continuous 24/7 loop
node lab/oz/oz-local.mjs
```

## CLI Flags

| Flag | Description |
|---|---|
| `--once` | Exit after processing one issue |
| `--issue <ID>` | Target a specific issue by identifier (e.g. `DAN-117`) |
| `--dry-run` | Stop after the plan step; do not generate code or run CI |

## Output

All output is newline-delimited JSON (`{ ts, event, ...data }`), making it easy to pipe into log aggregators.

Example events: `boot`, `issue.selected`, `linear.state`, `gate.blocked`, `issue.done`, `fatal`.
