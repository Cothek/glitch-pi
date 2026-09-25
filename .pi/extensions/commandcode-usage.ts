/**
 * commandcode-usage.ts — live Command Code plan-usage monitor for Pi.
 *
 * Renders a widget (under the file tree in the web UI, above the editor in
 * the TUI) plus a status-bar chip showing the three plan limits from
 * https://commandcode.ai/settings/usage:
 *   - 5-hour window   (used / cap, resets countdown)
 *   - weekly window   (used / cap, resets countdown)
 *   - monthly credits (used / plan cap, period end)
 *
 * Data comes from the command-code CLI's own alpha API using the same API key
 * Pi already uses for the commandcode provider. Fetch/render logic lives in
 * scripts/lib/commandcode-usage.mjs (CLI-runnable for verification).
 *
 * Behaviour:
 *   - Fetch on session start, then every 2 min (unref'd timer); countdowns
 *     re-render from cache every 30 s without a network call.
 *   - Extra fetch on agent_end — a reply just finished, so spend likely moved.
 *   - `/cc-usage` forces a refresh and toasts the result.
 *   - Sub-agents (GLITCH_SUBAGENT=1) skip entirely — the primary session owns
 *     the poll. Nothing here may ever throw (tunnel-keeper rule).
 *
 * Registered in .pi/settings.json (that list gates project extension loading).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	fetchUsageSnapshot,
	renderStatusText,
	renderWidgetLines,
	type UsageSnapshot,
} from "../../scripts/lib/commandcode-usage.mjs";

const WIDGET_KEY = "commandcode-usage";
const STATUS_KEY = "cc-usage";
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const RENDER_INTERVAL_MS = 30 * 1000;

type AnyCtx = Pick<ExtensionContext, "ui">;

export default function commandcodeUsageExtension(pi: ExtensionAPI) {
	// Sub-agents inherit the primary session's monitor — skip to avoid poll stampedes.
	if (process.env.GLITCH_SUBAGENT === "1") return;

	let ctx: AnyCtx | null = null;
	let snap: UsageSnapshot | null = null;
	let inflight = false;

	/** Push the current snapshot (or clear when there is none) into widget + status. */
	function paint(): void {
		const c = ctx;
		if (!c) return;
		try {
			if (snap) {
				const now = new Date();
				c.ui.setWidget(WIDGET_KEY, renderWidgetLines(snap, now), { placement: "belowEditor" });
				c.ui.setStatus(STATUS_KEY, renderStatusText(snap, now));
			} else {
				c.ui.setWidget(WIDGET_KEY, undefined);
				c.ui.setStatus(STATUS_KEY, undefined);
			}
		} catch {
			// A widget problem must never break a session.
		}
	}

	/** Fetch fresh data; keep the last good snapshot on failure. */
	async function refresh(): Promise<boolean> {
		if (inflight) return snap !== null;
		inflight = true;
		try {
			const fresh = await fetchUsageSnapshot();
			if (fresh) {
				snap = fresh;
				paint();
				return true;
			}
			return false;
		} catch {
			return false;
		} finally {
			inflight = false;
		}
	}

	// ---- lifecycle ---------------------------------------------------------

	pi.on("session_start", (_event, c) => {
		ctx = (c as unknown) as AnyCtx;
		void refresh();
		paint();
	});

	// Keep ctx fresh across reloads / new sessions in the same process.
	pi.on("agent_start", (_event, c) => {
		ctx = (c as unknown) as AnyCtx;
		paint();
	});

	// A reply just finished — spend likely moved. Fire-and-forget.
	pi.on("agent_end", (_event, c) => {
		ctx = (c as unknown) as AnyCtx;
		void refresh();
	});

	// Countdown ticks from cache between fetches (no network).
	const renderTimer = setInterval(paint, RENDER_INTERVAL_MS);
	if (typeof renderTimer.unref === "function") renderTimer.unref();

	const pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
	if (typeof pollTimer.unref === "function") pollTimer.unref();

	// ---- /cc-usage command --------------------------------------------------

	pi.registerCommand("cc-usage", {
		description: "Refresh the Command Code usage widget (5h / weekly / monthly limits)",
		handler: async (_args, c) => {
			ctx = (c as unknown) as AnyCtx;
			const ok = await refresh();
			paint();
			c.ui.notify(
				ok
					? "Command Code usage refreshed"
					: "Command Code usage unavailable — check API key / network",
				ok ? "info" : "warning",
			);
		},
	});
}
