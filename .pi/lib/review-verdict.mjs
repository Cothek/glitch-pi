/**
 * review-verdict.mjs — Review Gate verdict parsing and async dispatch
 * classification for .pi/extensions/routing.ts.
 *
 * WHY THIS MODULE EXISTS: the Review Gate read verdicts straight off the
 * dispatch tool-call result, but an ASYNC delegation (delegate_task /
 * subagent spawn) returns only an ack — the real verdict arrives later via
 * `subagent(action: "wait_all" | "get_result")`. The ack holds no verdict
 * token, so isPassVerdict(ack) was false and every genuine async reviewer
 * PASS was recorded as FAIL, pinning the commit gate shut. These pure
 * functions separate the three things a reviewer tool result can be
 * (a dispatch ack, a synchronous verdict, a collected run result) so
 * routing.ts can defer acks and judge the collected section instead.
 *
 * Collected wait_all results truncate run ids to 8 chars ("sa-ed5e1") and
 * separate runs with lines starting "- " — extractRunSection isolates one
 * run's text so a FAIL run cannot bleed its tokens into a PASS run.
 *
 * Dependency-free on purpose: the extension imports it, `node --test`
 * imports it (.pi/lib/review-verdict.test.mjs), same pattern as
 * plan-paths.mjs.
 */

/**
 * Pull the run id out of a dispatch ack. Real acks lead with
 * "Delegated: sa-ed5e1e55". Returns "" when there is no id.
 */
export function extractRunId(text) {
	const m = String(text ?? "").match(/^(?:Delegated|Dispatched|Spawned):\s*(\S+)/m);
	return m ? m[1] : "";
}

/**
 * True for a dispatch ack — the tool result that only confirms a delegation.
 * Explicitly NOT true for a collected result: a wait_all result starts with
 * "All N subagent(s) collected:" and contains the actual verdict, so it must
 * never be treated as an ack.
 */
export function isDispatchAck(text) {
	const s = String(text ?? "");
	if (/subagent\(s\)\s+collected:/i.test(s)) return false;
	return /^(?:Delegated|Dispatched|Spawned):\s*\S+/m.test(s);
}

/**
 * Isolate ONE run's section from a collected wait_all result. `runIdPrefix`
 * is the truncated 8-char id as it appears on the "- sa-ed5e1（…）:" header
 * line. The section runs from that header to the NEXT line starting with
 * "- " (or end of text). Returns "" when the run is not present — the
 * caller decides whether falling back to the whole text is safe (only when
 * exactly one run matched).
 */
export function extractRunSection(text, runIdPrefix) {
	const s = String(text ?? "");
	const prefix = String(runIdPrefix ?? "");
	if (!s || !prefix) return "";
	const lines = s.split(/\r?\n/);
	const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headerRe = new RegExp(`^-\\s+${esc}\\b`);
	const start = lines.findIndex((l) => headerRe.test(l));
	if (start === -1) return "";
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^-\s+\S/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

/**
 * Classify a reviewer dispatch tool-call result.
 *
 * @returns {{kind:"ack", runId:string}|{kind:"sync-verdict"}|{kind:"unknown"}}
 *   ack          — the result only confirms an async dispatch (delegate_task /
 *                  subagent spawn); the verdict will arrive at collection.
 *   sync-verdict — the result itself carries a verdict (legacy task() path
 *                  or a collected section handed back synchronously).
 *   unknown      — neither; the caller stays conservative (FAIL path).
 */
export function classifyReviewDispatch(text) {
	const s = String(text ?? "");
	if (isDispatchAck(s)) return { kind: "ack", runId: extractRunId(s) };
	if (/verdict\s*:|review\s*:|FIX THEN SHIP|FIX AND RESHIP|\b(?:PASS|PASSED|FAIL|FAILED|FAILURE|REJECT|REJECTED|BLOCK|BLOCKED|APPROVED|PROCEED|SHIP)\b/i.test(s)) {
		return { kind: "sync-verdict" };
	}
	return { kind: "unknown" };
}

/**
 * Verdict scan for reviewer output. Moved VERBATIM from routing.ts (the
 * leading-region logic with the qualified-pass guard and the reship-order
 * override); behaviour cases live in the test suite and in
 * data/scratch/routing-behavior-check.mjs.
 */
export function isPassVerdict(text) {
	if (!text) return false;
	// Scan a LEADING REGION, not just line 1. Real reviewers open with prose
	// ("here is my verdict:") and state the verdict on a later line, while their
	// evidence legitimately contains the words FAIL/REJECT. Reading line 1 alone
	// fell through to the body scan, scored a real PASS as a FAIL, and so blocked
	// every commit after that review.
	const lead = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5).join("\n");
	const leadBare = lead.replace(/[*_`#>]/g, "");
	// A qualified pass is not a pass. Scope this to the words IMMEDIATELY after the
	// verdict token (the rest of its own line), not the whole region: a stray "but"
	// in the evidence on a later line must not turn a PASS into a FAIL, which would
	// re-create the deadlock.
	const qualified = (idx, len) =>
		/\b(?:with|but|however|if|once|after|provided|assuming|unless)\b/i.test(leadBare.slice(idx + len).split("\n")[0]);

	// 1. An explicit label wins outright. This protects the common
	//    "this would FAIL without the fix. Verdict: PASS" shape.
	const labelled = leadBare.match(/verdict\s*:\s*(PASS|PASSED|APPROVED|PROCEED|SHIP|FAIL|FAILED|FAILURE|REJECT|REJECTED|BLOCK|BLOCKED)\b/i);
	if (labelled) {
		const v = labelled[1].toUpperCase();
		if (/^(FAIL|FAILED|FAILURE|REJECT|REJECTED|BLOCK|BLOCKED)$/.test(v)) return false;
		return !qualified(labelled.index ?? 0, labelled[0].length);
	}
	if (/verdict\s*:\s*✅/.test(leadBare)) return true;

	// A reship order in the region is an explicit fail signal. It must never be
	// read as a standalone "SHIP" pass token by the scan below.
	if (/FIX THEN SHIP|FIX AND RESHIP|\bDO NOT SHIP\b/i.test(leadBare)) return false;

	// 2. Otherwise the EARLIEST standalone verdict token in the region decides.
	const first = leadBare.match(/\b(PASS|PASSED|APPROVED|PROCEED|SHIP|FAIL|FAILED|FAILURE|REJECT|REJECTED|BLOCK|BLOCKED)\b/i);
	if (first) {
		const v = first[1].toUpperCase();
		if (/^(FAIL|FAILED|FAILURE|REJECT|REJECTED|BLOCK|BLOCKED)$/.test(v)) return false;
		return !qualified(first.index ?? 0, first[0].length);
	}

	// 3. No verdict token anywhere in the leading region — fall back to the body
	//    scan, where fail signals trump.
	const fail = /FIX THEN SHIP|FIX AND RESHIP|REJECTED|\bFAIL(?:ED|URE)?\b|\bREJECT\b|\bDENIED\b|\bDO NOT SHIP\b|\bPASS\b\s+(?:with|but)\b/i.test(text);
	if (fail) return false;
	return /\bPASSED\b|\bPASS\b|\bPROCEED\b|verdict\s*:\s*✅|\bSHIP\b|\bAPPROVED\b/i.test(text);
}
