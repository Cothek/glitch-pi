---
name: graphify
description: "Use for any question about a codebase architecture, file relationships, or project structure — especially when graphify-out/graph.json or GRAPH_REPORT.md exists. Triggers: 'how does X work', 'what calls Y', 'architecture', 'graphify', knowledge graph questions."
---

# Graphify Skill

## Purpose
Persistent knowledge graph for the project (`graphify-out/`). Prefer focused graph queries over grepping large trees when the graph exists.

## When the graph exists
Check for:
- `E:\Glitch AI\glitch-ai\graphify-out\graph.json`
- `E:\Glitch AI\glitch-ai\GRAPH_REPORT.md` (broad architecture narrative)

(On glitch-pi, same relative paths under that repo root if graphify has been run there.)

## How to query

| Need | Do |
|------|-----|
| Focused question ("what calls X?") | `graphify query "<question>"` — scoped subgraph, usually much smaller than GRAPH_REPORT.md |
| Broad architecture / map of the system | Read `GRAPH_REPORT.md` only |
| Graph missing | Fall back to normal read/grep/glob; offer to build the graph if the user wants it |

## Reminder (plugin parity)
OpenCode's `.opencode/plugins/graphify.js` injects a one-time bash hint when `graphify-out/graph.json` exists:
> Run `graphify query "<question>"` instead of grepping raw files.

On Pi, follow that discipline manually when the graph file is present.

## Related
- Plugin source (OpenCode): `.opencode/plugins/graphify.js`
- Graphify skill (global, if present): may also live under `~/.config/opencode/skills/graphify/`
