# Glitch Free — free-pool conventions

The router (glitch-free mode) owns these files. Troy may hand-edit queue.md at any time. All other updates go through `scripts/free-pool.mjs` so the tables stay parseable.

## Files

| File | Holds | Who edits |
| --- | --- | --- |
| `registry.md` | Projects table (project, convId, cwd, model, scope, state, lastTouch) + Cooldowns table (model, until UTC, reason) | router via `free-pool.mjs register` / `cooldown` |
| `queue.md` | Queue table (id, project, instruction, model, state) | router via script, or Troy by hand |
| `README.md` | This document: formats, mapping table, cap, live-test answers | router |

## Update rules

1. Registry and queue are updated on every spawn, steer, and finish, before the router replies. Projects go through `free-pool.mjs register` (upsert by project name); cooldowns through `free-pool.mjs cooldown`.
2. Queue ids are sequential: Q1, Q2, ... The script assigns them.
3. Queue states: queued → running → done | failed.
4. Project states: active | idle | done | blocked.
5. Cooldowns expire automatically at their `until` timestamp. The `pool` command only lists active ones.
6. If a row is hand-edited with missing cells, the parser pads with empty strings instead of failing.

## Concurrency cap

**4** concurrent agent turns. Edit this number to change it.

## Task-to-model mapping (pool: NVIDIA panel enabled set)

All choices below are free nvidia/* models from the enabled pool (currently 14, all tier A). Troy changes the pool in the NVIDIA Models panel; this table is guidance, not a second source of truth.

| Task type | First choice | Also good | Why |
| --- | --- | --- | --- |
| Router (the glitch-free session itself) | nvidia/moonshotai/kimi-k3 | moonshotai/kimi-k2.6 | 1M context, reasoning |
| Heavy coding, big refactors | nvidia/nemotron-3-ultra-550b-a55b | nvidia/llama-3.1-nemotron-ultra-253b-v1, z-ai/glm-5.3 | strongest reasoners |
| Fast coding, tight iteration | nvidia/nemotron-3.5-lightning-30b-a3b | deepseek-ai/deepseek-v4.1-flash, z-ai/glm-5.3-flash | quick turns, big context |
| Research, planning, deep reasoning | moonshotai/kimi-k3 | nvidia/nemotron-3-nano-omni-30b-a3b-reasoning | reasoning models |
| Chores, small fixes, drafts | openai/gpt-oss-20b | nvidia/nemotron-3-super-120b-a12b, mistralai/mistral-nemotron | small and fast |
| Long-context work (huge files, long docs) | z-ai/glm-5.3 | deepseek-ai/deepseek-v4.1-flash, moonshotai/kimi-k3 | 1M context |

Vision: no vision-capable model is enabled in the pool right now. Vision work routes to the vision / vision-alt roles with their own pins.

## Live-test answers (verified 2026-09-27, build round)

- **Does subagent_steer resume a FINISHED persistent agent?** YES. conv-f702ec01 (persist: true, nvidia/openai/gpt-oss-20b) finished its task; a steer with a new instruction resumed the same conversation and it replied RESUMED. Routing to finished projects means steer first, no re-spawn needed.
- **Does the profile model pin re-apply every turn or only on switch?** Answered from agent-switcher.ts code: `applyRuntimePins` runs ONLY inside `switchTo` (the `/agent` command and `switch_agent` tool path). `before_agent_start` re-reads profile files every turn but only swaps the prompt and reconciles the mode marker; it never re-pins model/thinking/tools. So the glitch-free pin (kimi-k3) applies at the switch moment and NEVER fights the composer model picker afterward. Note: a marker-based switch (the web plugin path) swaps the prompt but does NOT apply runtime pins at all.
- **3 agents on 3 distinct models plus 1 queued item:** PASSED. proj-t2 (nvidia/z-ai/glm-5.3-flash) and proj-t3 (nvidia/mistralai/mistral-nemotron) ran concurrently; proj-t4 queued then drained via nvidia/meta/muse-glimmer-30b. No 429s. The status table showed all four correctly.
- **Disable an in-use model via the engine:** PASSED. `nvidia-models.mjs --disable openai/gpt-oss-20b` → `free-pool.mjs pool` flagged proj-t1 as MODEL DISABLED. `--enable` cleared the flag.
- **Model id formats:** registry and queue store pi-qualified ids (nvidia/<nim-id>). data/nvidia-models-state.json uses bare NIM ids. free-pool.mjs normalizes with nimId() for every comparison.
- **Tracking note:** registry.md and queue.md are runtime state under data/ (gitignored, recreated on demand by free-pool.mjs). This README is force-added to git as the durable spec.
- **Worker prompt lesson:** tiny free models derail on ambiguous prompts (proj-t1's first turn invented a service project instead of replying READY). Router prompts to workers must be ultra-explicit: exact expected output, no tools, no files.
