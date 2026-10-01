/**
 * dispatch-plan.mjs — how the dispatcher decides the model(s) and thinking level for a
 * sub-agent.
 *
 * WHY THIS MODULE EXISTS: these rules decide what actually runs, and they used to be
 * inline in `.pi/extensions/dispatcher.ts` where nothing could test them. They live here
 * as a dependency-free .mjs the extension imports and `node --test` can import too.
 *
 * THE RULES, in order:
 *
 *   1. A pin matching `^opencode(-go)?/` is dead weight. Those providers do not exist on
 *      pi, so the id is dropped from the chain (and reported), never silently run.
 *
 *   2. Otherwise the pin is the primary. `modelFallback:` frontmatter (comma-separated or
 *      bracketed) appends an ordered chain beneath it: free-sufficient first, then paid
 *      best-value, then a free-and-weaker last resort. This is the tiered strategy the
 *      owner described, and it is what the OpenCode "-paid" twin files were emulating
 *      with a second agent file per role. Both ordering and deduplication are
 *      deterministic.
 *
 *   3. If nothing usable is declared at all, the parent session's model is the whole
 *      chain (pre-chains behaviour).
 *
 * THINKING: `thinkingLevel:` belongs to the agent, not to a hop, so it does not change as
 * the chain falls down. Declared always wins; otherwise the parent's level is forwarded
 * only when the agent inherits the parent model (a pinned model owns its own default).
 */

/** Providers that exist in the OpenCode config but not on pi. */
export const DROPPED_MODEL_RE = /^opencode(-go)?\//;

/** Trim + drop-dead-provider guard shared by the pin and every fallback. */
function usableId(value, dropped) {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id) return undefined;
	if (DROPPED_MODEL_RE.test(id)) {
		dropped.push(id);
		return undefined;
	}
	return id;
}

/** Accept both `modelFallback: a, b` and `modelFallback: [a, b]`, like parseToolList. */
function fallbackList(agentFallbacks) {
	if (Array.isArray(agentFallbacks)) return agentFallbacks;
	if (typeof agentFallbacks !== "string") return [];
	return agentFallbacks.replace(/^\[|\]$/g, "").split(",");
}

/**
 * @param {object} input
 * @param {string|undefined|null} input.agentModel      frontmatter `model:`
 * @param {string[]|string|undefined|null} input.agentFallbacks frontmatter `modelFallback:`
 * @param {string|undefined|null} input.agentThinking   frontmatter `thinkingLevel:`
 * @param {string|undefined|null} input.parentModel     the dispatching session's model
 * @param {string|undefined|null} input.parentThinking  the dispatching session's level
 * @returns {{
 *   chain: string[],          // models in dispatch order; entry 0 is the pin
 *   model: string|undefined,  // the primary (chain[0])
 *   thinking: string|undefined,
 *   inherits: boolean,        // true when the first hop IS the parent because nothing usable was declared
 *   dropped: string[],        // ids skipped because their provider does not exist
 * }}
 */
export function planDispatch({ agentModel, agentFallbacks, agentThinking, parentModel, parentThinking } = {}) {
	const dropped = [];
	const pin = usableId(agentModel, dropped);

	const fallbacks = [];
	for (const entry of fallbackList(agentFallbacks)) {
		const id = usableId(entry, dropped);
		if (id && id !== pin && !fallbacks.includes(id)) fallbacks.push(id);
	}

	const chain = [];
	if (pin) chain.push(pin);
	chain.push(...fallbacks);

	// "inherits" means: the agent had no usable model of its own, so the first hop is
	// literally the parent's model. Only then does it make sense to forward the parent's
	// thinking level (a declared fallback is still a declared model and keeps its default).
	const inherits = !pin && !fallbacks.length;
	if (inherits) {
		const parent = typeof parentModel === "string" ? parentModel.trim() : "";
		if (parent) chain.push(parent);
	}

	const declared = typeof agentThinking === "string" ? agentThinking.trim() : "";
	const thinking = declared || (inherits && typeof parentThinking === "string" && parentThinking ? parentThinking : undefined);

	return {
		chain,
		model: chain[0],
		thinking: thinking || undefined,
		inherits,
		dropped,
	};
}
