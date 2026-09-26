<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **glitch-pi**.

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/glitch-pi/context` | Codebase overview, check index freshness |
| `gitnexus://repo/glitch-pi/clusters` | All functional areas |
| `gitnexus://repo/glitch-pi/processes` | All execution flows |
| `gitnexus://repo/glitch-pi/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Local GitNexus notes (hand-written, outside the generated block, preserved by analyze)

- **Volatile counts are disabled.** `.gitnexusrc` sets `stats: false`, so the block above never carries symbol/edge/flow counts (they churned on every changed-index run). Current counts live in `.gitnexus/meta.json` and the MCP `context` resource. Do not hand-count them back into the block.
- **FTS is unavailable on this machine.** The LadybugDB FTS extension INSTALLs but `LOAD fts` fails, so analyze skips search-index creation. That is the SAFE state: graph tools (impact/context/detect_changes/query) and BM25-free queries work, only full-text search degrades. Do NOT run `analyze --repair-fts` while LOAD fails: a DB carrying FTS indexes cannot be written incrementally, and the next analyze dies with `COPY failed for File: ... its extension is not loaded`. To re-enable later: unset `GITNEXUS_LBUG_EXTENSION_INSTALL`, confirm analyze/doctor reports FTS usable, then repair.
- **Analyze policy is pinned** to `GITNEXUS_LBUG_EXTENSION_INSTALL=never` (user env var) so runs are offline, deterministic and cannot create FTS indexes.
- **A failed analyze self-heals.** It sets `incrementalInProgress`; the next run detects that and forces a full rebuild (~20s) that restores a known-good index. Just re-run it.
- **`CLAUDE.md` is deleted and gitignored.** Analyze regenerates it for Claude Code, which this repo does not use; it may reappear on disk after a changed-index run. Expected, not a regression.
