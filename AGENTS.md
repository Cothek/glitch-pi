<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **glitch-pi**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/glitch-pi/context` | Codebase overview, check index freshness |
| `gitnexus://repo/glitch-pi/clusters` | All functional areas |
| `gitnexus://repo/glitch-pi/processes` | All execution flows |
| `gitnexus://repo/glitch-pi/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Local GitNexus notes (hand-written, outside the generated block, preserved by analyze)

- **Volatile counts are disabled.** `.gitnexusrc` sets `stats: false`, so the block above never carries symbol/edge/flow counts (they churned on every changed-index run). Current counts live in `.gitnexus/meta.json` and the MCP `context` resource. Do not hand-count them back into the block.
- **FTS is unavailable on this machine.** The LadybugDB FTS extension INSTALLs but `LOAD fts` fails, so analyze skips search-index creation. That is the SAFE state: graph tools (impact/context/detect_changes/query) and BM25-free queries work, only full-text search degrades. Do NOT run `analyze --repair-fts` while LOAD fails: a DB carrying FTS indexes cannot be written incrementally, and the next analyze dies with `COPY failed for File: ... its extension is not loaded`. To re-enable later: unset `GITNEXUS_LBUG_EXTENSION_INSTALL`, confirm analyze/doctor reports FTS usable, then repair.
- **Analyze policy is pinned** to `GITNEXUS_LBUG_EXTENSION_INSTALL=never` (user env var) so runs are offline, deterministic and cannot create FTS indexes.
- **A failed analyze self-heals.** It sets `incrementalInProgress`; the next run detects that and forces a full rebuild (~20s) that restores a known-good index. Just re-run it.
- **`CLAUDE.md` is deleted and gitignored.** Analyze regenerates it for Claude Code, which this repo does not use; it may reappear on disk after a changed-index run. Expected, not a regression.
