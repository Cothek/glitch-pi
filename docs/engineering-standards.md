# Glitch Engineering Standards

The single source of truth for how Glitch writes code in every project. Agent profiles, skills (code-review, testing, senior-developer, observation), and routing gates all point here. When a post-mortem teaches a lesson, it lands here (see the post-mortem skill).

## 1. Definition of done

Code is not done until ALL of these hold:

1. It runs. "I wrote it" is not "it works" (R5). Run the thing, the build, or the test.
2. It is reviewed. Via the review gate: self-review with the `code-review` skill (direct-exec modes) or @reviewer dispatch (dispatch modes).
3. It has tests when the repo has a test setup. New behavior without a test is a known gap, named out loud, not a silent one (R5 honesty).
4. It is committed with a conventional commit message (`type(scope): summary`) on the right branch.
5. Docs that changed meaning get updated in the same commit (README, AGENTS.md, standards).

## 2. Code style (all languages)

- One name per thing. No synonyms for the same concept across files.
- Small functions: if it needs a comment to explain a block, extract the block.
- No dead code. Delete, do not comment out. Git remembers.
- No magic values. Named constants or config, never inline literals repeated twice.
- Errors: fail fast at boundaries, never swallow (`catch {}` needs a comment justifying it).
- Dependencies: justify every new one in the commit message or PR. Prefer stdlib.
- Formatting: the repo's formatter owns style. No hand-formatting debates.

## 3. Process rules

- **Plan first** for complex work (routing enforces this via plan-first gate).
- **Impact before edit**: run GitNexus `impact` before changing any symbol in an indexed repo. Unknown risk means verify by text search, not proceed (per AGENTS.md).
- **Graph check before commit**: `detect_changes` before committing in indexed repos.
- **Branch discipline** (R16): no Glitch core edits on `main`. Feature branches for everything non-trivial.
- **Never `--no-verify`** to skip a gate unless Troy says so explicitly, and he names the risk he is accepting.
- **Never edit a generated tree.** Edit the source it is generated from, then regenerate. `.pi/skills/` is generated and gitignored; its source is `glitch-memorycore/plugins/glitch-skills/skills/` in the `glitch-engine` repo. An edit made only in the generated copy is destroyed by the next `node scripts/sync-skills.mjs --pi` run. Confirm a path first: `git check-ignore -v <path>`. Detect drift with `node scripts/sync-skills.mjs --pi --check` or `node scripts/repo-hygiene.mjs`.

## 4. Quality gates (enforced, not optional)

| Gate | When | Mechanism |
| --- | --- | --- |
| Plan-first | Complex task | routing.ts blocks code edits without a session plan |
| Dispatch-first | Code edits (dispatch modes) | routing.ts blocks direct edits without recent dispatch |
| Review | Before `git commit` | routing.ts blocks commit without fresh PASS marker |
| Repo hygiene | On demand / audits | `scripts/repo-hygiene.mjs` (report-only) + janitor |
| Standards compliance | Periodic | `observation` skill audit tier checks this document |

The review-gate marker: `node scripts/write-review-pass.mjs --agent self-review` after self-review, or automatic on @reviewer PASS.

## 5. Project baseline (every repo)

Every project Glitch touches gets, via `scripts/init-project.mjs`:

- `AGENTS.md` linking to this standards file (or a vendored copy for external repos)
- `.gitignore` baseline (node_modules, data/, logs, secrets, OS junk)
- Editor-agnostic formatter config if the stack has one
- npm/test smoke script where applicable
- GitNexus index when the repo is code-heavy (per §3)

## 6. Security baseline

- Never commit secrets, tokens, `auth.json`, `*.key`. Scan before commit when touching config.
- Validate input at system boundaries (user input, IPC, HTTP, file reads).
- No `shell: true` with interpolated strings; no `--no-verify` shortcuts; no `curl | sh`.
- New attack surface (ports, endpoints, tokens) gets a line in the commit message.

## 7. Writing (docs, comments, commits)

Per the `writing` skill: no AI tells, active voice, one idea per sentence, under 25 words.
Commit messages explain WHY when the why is not obvious from the diff.

## Change log of standards

Post-mortem lessons that change a rule are appended here.

- 2026-10-01 — Initial codification (three-repo hygiene + quality gates session).
- 2026-10-05 — Never edit a generated tree. A full pass of skill edits landed only in `.pi/skills/`, which is gitignored and force-overwritten on sync, so the work had to be re-landed in the engine source. Post-mortem: skill work landed in a generated tree. Enforced by content-comparing drift in `sync-skills.mjs --check` and `repo-hygiene.mjs` section F.
