# Glitch System Architecture

> The driving document for Glitch. It governs two things at once: how Glitch acts, and how the codebase is laid out.
> Every structural change ships with a change here. If the code and this file disagree, the code is wrong until proven otherwise.

**Authority order.** When documents conflict, the higher entry wins.

1. This file (structure and behavior rules)
2. `docs/engineering-standards.md` (how to write, what "done" means)
3. `.pi/SYSTEM.md` (the prompt contract the model reads)
4. `AGENTS.md` (repo-specific notes and hygiene)
5. Everything under `docs/` (feature notes, audits, plans)

---

## 1. Mission

Glitch is a personal AI companion that remembers, so it grows with one person instead of resetting every session.

Two outputs, both required:

- **For the user**: a partner that knows their history, their goals, and what they already decided.
- **For the code**: a system that stays legible at 3am, six months later, without its author in the room.

A change that improves one and weakens the other is not finished.

---

## 2. Scope

**Glitch is:**

- A local-first agent runtime with enforced behavior gates.
- A memory system with a clear write path and a compaction protocol.
- A portable environment that boots from one clone on Windows, macOS, or Linux.
- A set of specialized sub-agent roles dispatched under a real dispatch-first rule.

**Glitch is not:**

- A general-purpose chatbot. It is not trying to be one.
- A hosted service. There is no cloud dependency for core function.
- A place for user memory. That belongs in `user/`, always.
- A dumping ground. A file that fits no repo purpose is a dead-file candidate by definition.

---

## 3. The five layers

Every part of Glitch belongs to exactly one layer. If a component cannot be placed, it does not belong yet.

```
  ┌─ 5. KNOWLEDGE ──────────────────────────────────────┐
  │  docs/  ·  .pi/SYSTEM.md  ·  library/  ·  ARCHITECTURE.md
  │  What Glitch was told and why.
  └───────────────────────┬──────────────────────────────┘
                          │ reads
  ┌─ 4. MEMORY ───────────▼──────────────────────────────┐
  │  user/*.md  ·  sessions/<id>/  ·  glitch-memorycore/
  │  What Glitch remembers about the user and itself.
  └───────────────────────┬──────────────────────────────┘
                          │ drives
  ┌─ 3. CAPABILITY ───────▼──────────────────────────────┐
  │  .pi/skills/ (68)  ·  .pi/agents/ (16 roles)  ·  plugins/
  │  What Glitch can do, and which role does it.
  └───────────────────────┬──────────────────────────────┘
                          │ constrained by
  ┌─ 2. RUNTIME ──────────▼──────────────────────────────┐
  │  Pi CLI  ·  .pi/extensions/  ·  .pi/settings.json
  │  routing.ts gates every tool call. dispatcher.ts owns spawn.
  └───────────────────────┬──────────────────────────────┘
                          │ started by
  ┌─ 1. ENTRY ────────────▼──────────────────────────────┐
  │  launch-glitch.bat / .sh  ·  scripts/launch-pi.mjs
  │  scripts/launch-unified.mjs  ·  scripts/lib/tunnel.mjs
  │  How a session comes into existence.
  └──────────────────────────────────────────────────────┘
```

**Layer 1 owns process lifecycle.** It starts the runtime, resolves config, and starts the tunnel. It never contains agent logic.

**Layer 2 owns behavior enforcement.** Gates are code, not prose. The model can ignore a prompt rule, so rules that matter live in `routing.ts`.

**Layer 3 owns capability.** A skill is knowledge on demand. A role is a model pin plus a brief. Neither may contain policy that belongs in layer 2.

**Layer 4 owns memory.** Writes go through a defined path with a heartbeat timestamp. Nothing else in the system writes to `user/`.

**Layer 5 owns decisions on record.** If it is not written down here or in `docs/`, it was not decided.

---

## 4. The three-repo rule

The workspace spans three git repositories with one purpose each. A file that does not fit its repo is misplaced by definition.

| Repo | Path | Owns | Never holds |
|---|---|---|---|
| **glitch-pi** | `E:/Glitch AI/glitch-pi` | Layers 1, 2, 3, 5. Scripts, routing, extensions, config, docs. | User memory, logs, scratch, screenshots |
| **user** | `glitch-pi/user/` (own repo, linked to `%USERPROFILE%/.pi/agent/user`) | Layer 4. Memory files, diary, decisions, session state. | Engine code, binaries, caches |
| **memory core** | `glitch-pi/glitch-memorycore/` (submodule) | Search, skills registry, plugin engine. | User data, runtime state |

**File-category rule.** Every new file gets one category at creation:

| Category | Lives in | Committed | Purge policy |
|---|---|---|---|
| `engine` | Anywhere in a source tree | Yes | Never |
| `user-memory` | `user/` | Yes, to the user repo | Never |
| `scratch` | `data/scratch/` | No | Disposable, purged by `scripts/janitor.mjs` |
| `log` | `data/logs/` | No | Disposable, purged by `scripts/janitor.mjs` |

Nothing ambiguous may accumulate in `data/scratch/` or `data/logs/`.

---

## 5. How Glitch acts

This section is the behavioral contract. The enforcement points are listed with each rule.

### 5.1 Dispatch-first

Glitch is a dispatcher, not an implementer. Code work goes to a real host subagent.

- **Rule**: `delegate_task` with a structured brief, or `subagent` spawn with a template. Read-only work stays with the dispatcher.
- **Enforced by**: the Dispatch-First gate, on `edit`/`write` and again on destructive shell. Anchors in section 6, rows 4 and 6.
- **Bypass**: none. `glitch-omni` and `glitch-lightweight` are exempt because they are direct-execution modes by definition.

### 5.2 Plan-first

Code files are edited only against a written plan.

- **Plan path**: `data/plans/sessions/<session-id>/current-plan.md`, resolved from the module location, never from `ctx.cwd` (`.pi/lib/plan-paths.mjs`).
- **Template**: Goal, Approach, Files to change, Risks, Verification.
- **Enforced by**: the Plan-First gate. Bypass phrase is the literal `quick task` in the prompt.
- **Exempt**: `user/*.md`, `config/*.json`.

### 5.3 Intellectual honesty

Claims about code or system state require evidence in the same reply.

- **Rule**: distinguish "I wrote it" from "I verified it works". Acknowledge uncertainty out loud.
- **Enforced by**: prompt only (`SYSTEM.md` R5). It is a norm, not a gate. A violation is a failure to log, not a blocked tool call.

### 5.4 Review before commit

- **Dispatch modes**: a fresh PASS from a reviewer subagent is required after any code task.
- **Direct-execution modes**: a self-review PASS marker under 30 minutes old is required when code files are staged.
- **Marker written by**: `node scripts/write-review-pass.mjs --agent self-review --verdict PASS`.
- **Review-fail outranks PASS.** A failure signal is never overwritten by an older pass. Anchor: section 6, row 10.
- **Bypass**: `git commit --no-verify`, and only when Troy names the risk he accepts.

### 5.5 Scope discipline

- One name per thing. No synonyms for the same concept across files.
- Small functions. If a block needs a comment to explain it, extract the block.
- No dead code. Delete it. Git remembers.
- No magic values. Name them once.

---

## 6. Invariants

These are load-bearing. Breaking one breaks something that is already working.

**Evidence is an anchor, not a line number.** Line numbers drift on every edit, so each invariant names a unique string you can grep. Verify any of them yourself:

```bash
grep -Fn "<anchor>" <file>
```

Every anchor below was confirmed to match exactly one line when this section was written.

| # | Invariant | File | Anchor |
|---|---|---|---|
| 1 | **One root, resolved from module location.** Never from `ctx.cwd`. A two-root split once inverted every gate. | `.pi/lib/root.mjs` | `export function glitchRoot` |
| 2 | **Sub-agent sessions are never gated.** The handler returns early. | `.pi/extensions/routing.ts` | `isSubAgentSession({ ctx` |
| 3 | **Probing fails closed on a null context.** Never treat an unreadable context as "not a sub-agent". | `.pi/lib/subagent-session.mjs` | `GLITCH_SUBAGENT === "1"` |
| 4 | **Direct-execution modes never dispatch.** A hard block, not prose, because the model ignores prose. | `.pi/extensions/routing.ts` | `if (isDirectExecPrimaryMode())` |
| 5 | **A session writes only its own plan file.** Foreign plan paths are blocked for `edit`, `write`, and mutating shell. | `.pi/extensions/routing.ts` | `classifyPlanPath(filePath, currentSessionID) === "foreign"` |
| 6 | **Dispatch evidence is stamped at `tool_call`.** Only `tool_call` can see the action, so only `tool_call` can tell a spawn from a list. | `.pi/extensions/routing.ts` | `const dispatchName = extractAgentName` |
| 7 | **A sub-agent process is flagged `GLITCH_SUBAGENT=1`.** Set by the dispatcher, read by the gate. | `.pi/extensions/dispatcher.ts` | `GLITCH_SUBAGENT` |
| 8 | **A gate failure never crashes the tool loop.** Every gate body is wrapped and returns `undefined` on throw. | `.pi/extensions/routing.ts` | `tool_call failed` |
| 9 | **A broken probe never blocks.** A failed `git diff --cached` returns an empty list, not a block. | `.pi/extensions/routing.ts` | `return []; // not a git repo` |
| 10 | **A fail signal outranks a PASS.** "FIX THEN SHIP" contains "SHIP", so the match runs before any pass check. | `.pi/extensions/routing.ts` | `Fail signals trump everything` |
| 11 | **Gate state is in-memory.** A restart clears `pendingReview`. Never treat gate state as persisted truth. | `.pi/extensions/routing.ts` | `let pendingReview = false;` |
| 12 | **Launch selections are machine-local.** They live in `data/`, never the `user/` repo. `user/` is migration-read only. | `scripts/launch-unified.mjs` | `LegacyPrefFile = join(ROOT_DIR` |
| 13 | **`--reuse-saved` persists nothing.** It neither stores the choice nor applies updates. | `scripts/launch-unified.mjs` | `const REUSE_SAVED =` |
| 14 | **A tunnel failure never blocks local launch.** | `scripts/launch-pi.mjs` | `local Pi still launches` |
| 15 | **The Pi binary resolves from the launcher's own root.** This repo launches its own Pi. | `scripts/launch-pi.mjs` | `process.env.GLITCH_PI_ROOT` |
| 16 | **A colon in a username is rejected.** HTTP Basic auth splits the header on the first colon, so `a:b` would authenticate as `a`. | `scripts/set-credentials.mjs` | `if (name.includes` |
| 17 | **Never `git commit --no-verify`** unless Troy names the risk he is accepting. | `.pi/extensions/routing.ts` | `normalizedCmd.includes("--no-verify")` |

---

## 7. Extension points

Use the table to find the correct place to add a thing. Adding to the wrong layer is the most common structural mistake.

| To add | Put it in | Register it in | Not here |
|---|---|---|---|
| A new agent role | `.pi/agents/<role>.md` | auto-discovered | `.pi/settings.json` |
| A new skill | `.pi/skills/<name>/SKILL.md` | `.pi/skills/` index | `SYSTEM.md` |
| A new runtime behavior | `.pi/extensions/<name>.ts` | **`.pi/settings.json` `extensions`** | Prompt prose alone |
| A new tool or MCP server | `.pi/settings.json` `packages` | `.pi/settings.json` | `scripts/` |
| A new agent mode | `.pi/agent-profiles/<mode>.md` | mode switcher | `.pi/agents/` |
| A new script | `scripts/<verb>.mjs` | nothing | `scripts/lib/` unless shared |
| Shared script logic | `scripts/lib/<name>.mjs` | imported | `scripts/` root |
| A new memory file type | `user/` | `AGENTS.md` import list | `glitch-pi/` root |
| A new project | `E:/Glitch AI/code/<name>/` | `scripts/init-project.mjs` | Anywhere else |

**The registration step is the one people skip.** An extension not listed in `.pi/settings.json` does not load. All 11 on disk are registered. To check, compare `ls .pi/extensions/*.ts` against the `extensions` array in `.pi/settings.json`. The twelfth file, `stuck-detector-logic.mts`, is an imported module, not an extension, and is correctly unregistered.

---

## 8. Decision rules

When an architecture question has no obvious answer, apply these in order and stop at the first that resolves it.

1. **Layer test.** Which of the five layers owns this? If none, the thing is not understood yet.
2. **Repo test.** Which of the three repos owns this? A file in two repos is a file in the wrong repo.
3. **Enforcement test.** Does this need to be guaranteed or merely advised? Guaranteed means a gate in `routing.ts`. Advised means prompt prose.
4. **Reversibility test.** If this is hard to undo, it needs a decision record in section 9 before the code lands.
5. **Bootstrapping test.** Does this require the system to already be running? If yes, it cannot live inside a session hook. It goes in `scripts/`.
6. **Honesty test.** If the answer is "it depends on the model cooperating", say so and pick a gate instead.

---

## 9. Decision records

Architecture decisions that are hard to reverse get a row. One line each.

| Date | Decision | Why | Reverses |
|---|---|---|---|
| 2026-10-04 | Architecture document established at repo root | Rules were spread across `SYSTEM.md`, standards, and gates with no single authority | Split docs by feature |
| 2026-10-04 | Invariants cite grep anchors, never line numbers | Line numbers rotted on the first commit that touched a gate. An anchor stays true across edits. | `file:line` evidence in invariants |
| 2026-10-04 | Feature notes move to `docs/features/` | `docs/architecture.md` held a feature note while claiming to be the architecture doc | Flat `docs/` layout |

---

## 10. Known gaps

Recorded here so the next reader inherits them instead of rediscovering them. Each is a fact, not a task list.

- **All 11 extensions are registered.** `blast-radius.ts` and `compaction-diary.ts` were unregistered until 2026-10-04. Keep the count at 11 when adding one.
- **A blocked edit can still raise a blast-radius signal.** `blast-radius.ts` runs before `routing.ts` on the same `tool_call`. When `routing.ts` then blocks the edit, the signal stays queued for its 5 minute TTL and is injected anyway. Noise, not a wrong answer. Reorder or consume-on-block if it becomes annoying.
- **The repo-hygiene gate is not automated.** `scripts/repo-hygiene.mjs` has no caller. `docs/engineering-standards.md` section 4 lists it as a gate, which overstates its enforcement.
- **The quality gate is self-reported.** In direct-execution modes the PASS marker is written by the same agent that wrote the code. It is a forcing function, not an independent check.
- **A persisted sub-agent stays gated.** `persist: true` writes a transcript, so the in-memory session signal misses it.
- **Old OpenCode paths linger in routing config.** `CONFIG_FILES` still lists `opencode.json` and `config/opencode-*.json`. This fork has no OpenCode. Anchor: `CONFIG_FILES` in `.pi/extensions/routing.ts`.
- **Gate state does not survive a restart.** Invariant 9 covers this.

---

## 11. Change protocol

**Update this file in the same commit as any change to:**

- The five-layer map, or which repo owns what
- The three-repo table or the file-category rule
- The extension-point table, including a new registration requirement
- The invariant list, in either direction
- A known gap being closed

**Update `docs/engineering-standards.md` when** the definition of done, a quality gate, or a security rule changes.

**Update `.pi/SYSTEM.md` when** the model-facing prompt contract changes. That file is read at runtime, so it is part of the system, not documentation about it.

**Feature notes live in `docs/features/`,** one file per feature. `docs/architecture.md` previously held a feature note and was flagged stale at `docs/startup-feature-audit.md:359`. It now redirects here.

---

## Change log

| Date | Change | Why |
|---|---|---|
| 2026-10-04 | Created | Glitch had no structural authority document. Rules were split across prompt prose, a standards file, and runtime gates. |
| 2026-10-04 | Invariants switched to grep anchors after review found two wrong line references and eight drifting ones | Evidence that cannot be checked is not evidence |
| 2026-10-04 | Registered `blast-radius.ts` and `compaction-diary.ts` | Both existed on disk but never loaded. Section 10 gap closed. |
| 2026-10-04 | `AGENTS.md` three-repo table synced to section 4 | Two copies of one rule had already drifted |
