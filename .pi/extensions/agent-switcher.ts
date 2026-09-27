/**
 * agent-switcher.ts — Pi extension: mid-session primary agent switching
 *
 * Switches the primary agent persona (glitch | glitch-free | glitch-omni | glitch-lightweight)
 * INSIDE the active session, no restart required. Replaces the restart-only
 * scripts/switch-agent.mjs staging flow as the primary switching path (the
 * script stays as offline fallback).
 *
 * HOW IT WORKS
 *   before_agent_start mutates systemPromptOptions.customPrompt (= preamble
 *   section, the exact slot .pi/SYSTEM.md feeds) every turn. Pi diffs sections
 *   and patches the conversation mid-stream. Profiles are RE-READ FROM DISK on
 *   every turn (loadProfiles in the before_agent_start handler), so an edit to
 *   .pi/agent-profiles/<mode>.md lands on the next turn — no restart and no
 *   /agent round-trip needed. A failed read keeps the session_start snapshot.
 *   Model / thinking / tool loadout
 *   are applied mid-session via pi.setModel() / setThinkingLevel() /
 *   setActiveTools(), which pi records in session history and restores on
 *   resume. The switch ALSO stages .pi/SYSTEM.md + writes user/agent-mode.json
 *   so a restart lands in the same mode (routing.ts gate contract intact).
 *
 * PROFILES
 *   .pi/agent-profiles/<mode>.md, optional YAML frontmatter:
 *     ---
 *     description: one line for the picker
 *     model: provider/model-id          # optional, applied on switch
 *     thinking: high                    # optional, applied on switch
 *     tools: read, bash, edit, write    # optional, replaces tool loadout
 *     memoryContext: false              # optional, strips user-agent-dir
 *                                       #   context files (memory payload)
 *                                       #   from the prompt — for small-
 *                                       #   context local models
 *     ---
 *   Body = full system prompt for that mode (same content switch-agent.mjs
 *   stages into .pi/SYSTEM.md).
 *
 * USAGE
 *   /agent              picker (works in TUI and web UI / RPC)
 *   /agent glitch-omni  direct switch
 *   Ctrl+Shift+A        cycle glitch → glitch-free → glitch-lightweight → glitch-omni → …
 *
 * NOTES
 *   - Web UI (RPC) compatible: only ctx.ui.select/notify/setStatus dialogs are
 *     used — no custom TUI components.
 *   - user/agent-mode.json is repo-global (same semantics as switch-agent.mjs):
 *     routing.ts gates follow the file immediately (per-call read).
 *   - Model/thinking/tool pins apply on explicit /agent switches; session
 *     resume restores them via pi's own session history (mode name restored
 *     from this extension's session entries).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileConfig {
	description?: string;
	/** "provider/model-id" — applied via pi.setModel() on switch */
	model?: string;
	/** thinking level applied via pi.setThinkingLevel() on switch */
	thinking?: string;
	/** comma-separated tool names — replaces the active tool loadout */
	tools?: string[];
	/** false → strip user-agent-dir context files (memory payload) from prompt */
	memoryContext?: boolean;
}

interface Profile {
	id: string;
	file: string;
	text: string;
	config: ProfileConfig;
}

// ---------------------------------------------------------------------------
// Repo root (walk up from cwd to nearest .git/.pi — sessions may start in
// data/node; same pattern as routing.ts)
// ---------------------------------------------------------------------------

function resolveRepoRoot(startDir: string): string {
	let dir = startDir;
	while (true) {
		if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".pi"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return startDir;
		dir = parent;
	}
}

// ---------------------------------------------------------------------------
// Frontmatter parser (simple key: value lines between --- markers; no deps)
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { config: ProfileConfig; body: string } {
	const config: ProfileConfig = {};
	let body = raw;
	if (!raw.startsWith("---")) return { config, body };

	const end = raw.indexOf("\n---", 3);
	if (end === -1) return { config, body };

	const header = raw.slice(3, end).trim();
	body = raw.slice(raw.indexOf("\n", end + 1) + 1);

	for (const line of header.split("\n")) {
		const m = line.match(/^([a-zA-Z]+)\s*:\s*(.*)$/);
		if (!m) continue;
		const [, key, value] = m;
		const v = value.trim();
		if (!v) continue;
		if (key === "description") config.description = v;
		else if (key === "model") config.model = v;
		else if (key === "thinking") config.thinking = v;
		else if (key === "tools") config.tools = v.split(",").map((t) => t.trim()).filter(Boolean);
		else if (key === "memoryContext") config.memoryContext = v.toLowerCase() === "false";
	}
	return { config, body };
}

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

function loadProfiles(repoRoot: string): Profile[] {
	const dir = join(repoRoot, ".pi", "agent-profiles");
	if (!existsSync(dir)) return [];
	const out: Profile[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		const file = join(dir, entry);
		try {
			const raw = readFileSync(file, "utf-8");
			const { config, body } = parseFrontmatter(raw);
			out.push({ id: entry.replace(/\.md$/, ""), file, text: body.trim(), config });
		} catch {
			// unreadable profile → skip it, /agent will show what loaded
		}
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}

// ---------------------------------------------------------------------------
// agent-mode.json (routing.ts gate contract — BOM-tolerant read)
// ---------------------------------------------------------------------------

function readModeFile(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		let text = readFileSync(path, "utf-8");
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		const raw = JSON.parse(text);
		return typeof raw?.mode === "string" && raw.mode ? raw.mode : null;
	} catch {
		return null;
	}
}

function writeModeFile(path: string, mode: string, previous: string | null): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const data = {
		mode,
		...(previous ? { previous_mode: previous } : {}),
		switched_at: new Date().toISOString(),
		via: "pi-extension:/agent",
		note: "routing.ts reads this for gate behavior; switch via /agent (mid-session) or scripts/switch-agent.mjs (offline).",
	};
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function agentSwitcherExtension(pi: ExtensionAPI) {
	let repoRoot = "";
	let profiles: Profile[] = [];
	let activeModeId: string | null = null;
	let announcedMode: string | null = null;

	// ---- helpers -----------------------------------------------------------

	function profileById(id: string): Profile | undefined {
		return profiles.find((p) => p.id === id);
	}

	function setStatus(ctx: ExtensionContext) {
		if (activeModeId) ctx.ui.setStatus("agent", `agent:${activeModeId}`);
		else ctx.ui.setStatus("agent", undefined);
	}

	/** Apply model / thinking / tools pinned by a profile (explicit switches only). */
	async function applyRuntimePins(profile: Profile, ctx: ExtensionContext): Promise<void> {
		const c = profile.config;
		if (c.model) {
			const slash = c.model.indexOf("/");
			const provider = slash === -1 ? undefined : c.model.slice(0, slash);
			const modelId = slash === -1 ? c.model : c.model.slice(slash + 1);
			const model = provider && modelId
				? ctx.modelRegistry.find(provider, modelId)
				: undefined;
			if (model) {
				const ok = await pi.setModel(model);
				if (!ok) ctx.ui.notify(`agent: no API key for ${c.model}`, "warning");
			} else {
				ctx.ui.notify(`agent: model "${c.model}" not found in registry (skipped)`, "warning");
			}
		}
		if (c.thinking) {
			pi.setThinkingLevel(c.thinking as never);
		}
		if (c.tools && c.tools.length > 0) {
			const known = new Set(pi.getAllTools().map((t) => t.name));
			const valid = c.tools.filter((t) => known.has(t));
			const invalid = c.tools.filter((t) => !known.has(t));
			if (invalid.length > 0) ctx.ui.notify(`agent: unknown tools skipped: ${invalid.join(", ")}`, "warning");
			if (valid.length > 0) pi.setActiveTools(valid);
		}
	}

	/** Persist + announce + apply a mode switch. */
	async function switchTo(modeId: string, ctx: ExtensionContext): Promise<void> {
		const profile = profileById(modeId);
		if (!profile) {
			const available = profiles.map((p) => p.id).join(", ") || "(none found in .pi/agent-profiles)";
			ctx.ui.notify(`agent: unknown mode "${modeId}". Available: ${available}`, "error");
			return;
		}

		const previous = activeModeId;
		activeModeId = modeId;

		// Runtime pins (model / thinking / tools)
		await applyRuntimePins(profile, ctx);

		// Repo-global mode marker (routing.ts gate contract)
		writeModeFile(join(repoRoot, "user", "agent-mode.json"), modeId, previous);

		// Stage .pi/SYSTEM.md (body only — frontmatter is config, not prompt)
		// so a restart lands in the same mode
		try {
			writeFileSync(join(repoRoot, ".pi", "SYSTEM.md"), profile.text, "utf-8");
		} catch {
			// non-fatal: in-session prompt switching still works
		}

		// Session persistence (mode survives resume even before first turn)
		pi.appendEntry("agent-mode-state", { mode: modeId });

		// In-context announcement so the model adopts the persona immediately
		if (announcedMode !== modeId) {
			announcedMode = modeId;
			pi.sendMessage(
				{
					customType: "agent-switch",
					content:
						`Agent mode switched: ${modeId}` +
						(profile.config.description ? ` — ${profile.config.description}` : "") +
						`. The full operating profile for this mode is now active in your system prompt. ` +
						`Adopt this persona and its execution rules immediately; continue the current work ` +
						`without repeating steps already completed.`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		}

		setStatus(ctx);
		ctx.ui.notify(`Agent switched to ${modeId}`, "info");
	}

	// ---- /agent command -----------------------------------------------------

	pi.registerCommand("agent", {
		description: "Switch primary agent mode mid-session (glitch | glitch-free | glitch-omni | glitch-lightweight)",
		getArgumentCompletions: (prefix: string) => {
			const items = profiles.map((p) => ({
				value: p.id,
				label: p.id,
				description: p.config.description ?? "",
			}));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const requested = args?.trim();
			if (requested) {
				await switchTo(requested, ctx);
				return;
			}

			if (profiles.length === 0) {
				ctx.ui.notify("agent: no profiles in .pi/agent-profiles/", "warning");
				return;
			}

			// Picker — ctx.ui.select works in TUI and RPC (web UI)
			const options = profiles.map((p) => {
				const active = p.id === activeModeId ? "* " : "  ";
				const desc = p.config.description ? ` — ${p.config.description}` : "";
				return `${active}${p.id}${desc}`;
			});
			const choice = await ctx.ui.select("Switch agent mode (enter to select, esc to cancel):", options);
			if (choice === undefined) return;
			const modeId = choice.replace(/^\*\s*/, "").split(" — ")[0].trim();
			if (modeId) await switchTo(modeId, ctx);
		},
	});

	// ---- Ctrl+Shift+A cycle ---------------------------------------------------

	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Cycle agent mode (glitch → glitch-free → glitch-lightweight → glitch-omni)",
		handler: async (ctx) => {
			const order = profiles;
			if (order.length === 0) {
				ctx.ui.notify("agent: no profiles in .pi/agent-profiles/", "warning");
				return;
			}
			const currentIdx = order.findIndex((p) => p.id === activeModeId);
			const next = order[(currentIdx + 1) % order.length] ?? order[0];
			await switchTo(next.id, ctx);
		},
	});

	// ---- System prompt swap (every turn) --------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		// Re-read the profiles so edits to .pi/agent-profiles/<mode>.md take effect
		// on the NEXT TURN instead of waiting for a session restart. The profile set
		// is 3 small files and the prompt builder diffs the section, so a no-op turn
		// costs almost nothing. A failed read keeps the session_start snapshot.
		try {
			const fresh = loadProfiles(repoRoot);
			if (fresh.length > 0) profiles = fresh;
		} catch {
			/* unreadable profile dir — keep the session_start snapshot */
		}

		// Reconcile with the shared marker first: the pi-web-ui plugin switches by
		// writing user/agent-mode.json (it has no reliable way to reach a specific
		// conversation), so pick that up here and adopt the profile for this turn.
		try {
			const marker = readModeFile(join(repoRoot, "user", "agent-mode.json"));
			if (marker && marker !== activeModeId && profileById(marker)) {
				activeModeId = marker;
				announcedMode = marker; // the UI already notified; keep the transcript clean
				try {
					ctx.ui.setStatus("agent", `agent:${marker}`);
				} catch {
					/* status is cosmetic */
				}
				pi.appendEntry("agent-mode-state", { mode: marker });
			}
		} catch {
			/* marker unreadable — keep the current mode */
		}

		const profile = activeModeId ? profileById(activeModeId) : undefined;
		if (!profile) return;

		// Replace the preamble (the SYSTEM.md slot) with the active profile
		event.systemPromptOptions.customPrompt = profile.text;

		// Small-context modes: strip memory context files (user-agent-dir
		// AGENTS.md imports — user/main-memory.md, current-session.md, …)
		if (profile.config.memoryContext === false) {
			const agentDir = getAgentDir().replace(/\\/g, "/").toLowerCase();
			event.systemPromptOptions.contextFiles = event.systemPromptOptions.contextFiles.filter(
				(file) => !file.path.replace(/\\/g, "/").toLowerCase().startsWith(agentDir),
			);
		}
	});

	// ---- Model-callable switch tool (works in every UI, incl. web UI) ----------
	// Registered after profile discovery so the enum lists real modes. Lets the
	// user just ask in chat: "switch to glitch omni".
	function registerSwitchTool() {
		if (profiles.length === 0) return;
		pi.registerTool({
			name: "switch_agent",
			label: "Switch Agent",
			description:
				"Switch the primary agent mode for this session (mid-session, no restart). " +
				"Use when the user asks to change agent, persona, or mode. " +
				"The new mode's full profile takes over from the next turn.",
			promptSnippet: "Switch the primary agent mode (glitch / glitch-free / glitch-omni / glitch-lightweight)",
			parameters: Type.Object({
				mode: StringEnum(profiles.map((p) => p.id), {
					description: "Target agent mode id",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const mode = String((params as { mode?: string }).mode ?? "").trim();
				const profile = profileById(mode);
				if (!profile) {
					throw new Error(`Unknown mode "${mode}". Available: ${profiles.map((p) => p.id).join(", ")}`);
				}
				await switchTo(mode, ctx);
				return {
					content: [
						{
							type: "text",
							text:
								`Agent mode switched to ${mode}` +
								(profile.config.description ? ` (${profile.config.description})` : "") +
								". The new mode is active from the next turn; continue the current work without repeating completed steps.",
						},
					],
					details: { mode },
				};
			},
		});
	}

	// ---- Session lifecycle -----------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		repoRoot = resolveRepoRoot(ctx.cwd);
		profiles = loadProfiles(repoRoot);

		// Restore from session entries first (mode switched mid-session before)
		let restored: string | null = null;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "agent-mode-state") {
				const mode = (entry.data as { mode?: string } | undefined)?.mode;
				if (typeof mode === "string") restored = mode;
			}
		}

		// Fresh session → repo-global marker decides (consistent with restart flow)
		const fromFile = readModeFile(join(repoRoot, "user", "agent-mode.json"));

		const mode = restored && profileById(restored)
			? restored
			: fromFile && profileById(fromFile)
				? fromFile
				: null;
		if (mode) {
			activeModeId = mode;
			announcedMode = mode; // don't announce on restore — prompt patch is enough
		}
		setStatus(ctx);
		registerSwitchTool();
	});
}
