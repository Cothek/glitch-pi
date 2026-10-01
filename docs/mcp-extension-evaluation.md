# MCP Client Extension for Pi — Evaluation

**Date**: 2026-09-26
**Question**: does an existing Pi MCP-client extension exist (so we do not build one),
and which should we use?
**Answer**: yes — three exist. Recommendation: **`pi-mcp-adapter`**.

## Why this came up

`AGENTS.md` documents GitNexus MCP tools (impact / context / detect_changes /
query / rename) as available in this project. Verified: **Pi 0.87.1 has no
built-in MCP support** (0 occurrences of "mcp" in `cli.js` / `cli-runtime.js` /
`index.js`; no MCP command or option in `pi --help`; no MCP page in the official
docs). The `mcpServers` strings found earlier come from a vendored Google GenAI
SDK inside the bundle, not Pi. So MCP needs a community extension.

## Candidates

| Package | Version | Published | Downloads / month | Verdict |
|---|---|---|---|---|
| `pi-mcp-adapter` | 2.37.0 | 2026-09-23 | **1,067,062** | **Pick.** Most adopted, actively released (v2.37 three days ago), context-efficient by design |
| `pi-mcp-extension` | 1.5.0 | 2026-05-03 | 60,472 | Skip — ~5 months stale; multi-transport is its selling point |
| `pi-mcp-client` | 0.9.0 | 2026-09-25 | 1,088 | Credible second — newest, minimal, but ~1000x fewer users |

## Config format (the deciding detail)

**All candidates use the same convention**, which makes the choice reversible:

```json
{
  "mcpServers": {
    "some-server": { "command": "npx", "args": ["-y", "some-mcp-server"] }
  }
}
```

- `~/.pi/agent/mcp.json` — user-global
- `.pi/mcp.json` — project-level override (highest precedence)

`pi-mcp-adapter` additionally layers: host-config imports (Claude / Cursor /
Codex) via `pi-mcp-adapter init`, Agent Plugins `plugin.json` `mcpServers` with
`<plugin>__<server>` prefixes, and Pi-package manifests. It also ships
`/mcp setup`, `/mcp disable|enable <server>`, `/reload`. Its stated purpose is
"use MCP servers without burning your context window" (lazy tool activation).

`pi-mcp-client` adds `/mcp add --scope global <name> <url>`, `/mcp login`,
`/mcp prompt`, `/mcp reload`, and `/mcp import --scope global <path>` to reuse an
existing Claude/Cursor JSON or Codex TOML.

## Requirement check on this machine

| Requirement | Needed by | Actual | Status |
|---|---|---|---|
| Pi >= 0.85.1 | pi-mcp-client | 0.87.1 | OK |
| Node >= 22 | pi-mcp-client | v24.21.0 (bundled) | OK |

## Recommendation

**`pi-mcp-adapter`** — 1M+ monthly downloads, released days ago, imports configs
Troy may already have from other agents, and its lazy tool loading matters in
long sessions. `pi-mcp-client` stays a fallback: same config file, so switching
costs one install and no config rewrite.

Install path (per the official packages doc): `pi install npm:pi-mcp-adapter`,
then `pi list` to confirm. Project-scoped packages need a trust decision first.

## Prerequisite before GitNexus can be wired (verified gap)

GitNexus is **not installed** on this machine — not in the bundled global root
(`data/node/node_modules`) and not in the user npm root. `.gitnexus/` exists
(holds the LBug graph DB + caches), so it was run at some point, but there is no
local package to point an MCP server at. Before declaring a `gitnexus` entry
under `mcpServers` we must:

1. Install the package (`npm i -g gitnexus`, or keep using `npx gitnexus`).
2. Find its MCP entry point — **unverified**: I could not confirm that the
   gitnexus package ships an MCP server without installing it. Check
   `npx gitnexus --help` (or its docs) for an `mcp` / `serve` subcommand.
3. Only then write the `mcpServers` entry.

## Security note

An MCP extension runs third-party code that can execute local commands
(stdio servers launch subprocesses with your permissions) and exposes their
tools to the model. Pi's docs say explicitly: review third-party package source
before installing, and only configure servers you trust. For this repo, prefer a
project-scoped `.pi/mcp.json` entry only for servers we have read.

## Next steps

1. Install and smoke-test `pi-mcp-adapter` (`pi install npm:pi-mcp-adapter`).
2. Install GitNexus and locate its MCP entry point (the open question above).
3. Add the GitNexus server to `mcp.json`, then verify with `/mcp` that the
   tools register and `AGENTS.md` is no longer aspirational.
