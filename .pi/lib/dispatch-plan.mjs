/**
 * dispatch-plan.mjs — how the dispatcher decides the model and thinking level for a
 * sub-agent.
 *
 * WHY THIS IS ITS OWN MODULE: these rules are the ones that decide what actually runs,
 * and they used to be inline in `.pi/extensions/dispatcher.ts` where nothing could test
 * them. Pulling them out makes the precedence explicit and unit-testable without the pi
 * runtime: a dependency-free .mjs the extension imports and `node --test` can import too.
 *
 * THE RULES, and why they are what they are:
 *   1. A pin matching `^opencode(-go)?/` is IGNORED. Those providers do not exist on pi,
 *      so such a pin is a dead pin - the agent silently runs on the parent model. (The
 *      agent-models panel exists to make that visible; this is the code it mirrors.)
 *   2. No usable pin -> inherit the parent model.
 *   3. Thinking level: an agent's own `thinkingLevel` ALWAYS wins. Otherwise the parent's
 *      level is forwarded only when the agent inherits the model, because a pinned model
 *      has its own sensible default and inheriting the parent's effort there would be a
 *      surprising override.
 */

/** Providers that exist in the OpenCode config but not on pi. */
export const DROPPED_MODEL_RE = /^opencode(-go)?\//;

/**
 * @param {object} input
 * @param {string|undefined|null} input.agentModel   frontmatter `model:`
 * @param {string|undefined|null} input.agentThinking frontmatter `thinkingLevel:`
 * @param {string|undefined|null} input.parentModel  the dispatching session's model
 * @param {string|undefined|null} input.parentThinking the dispatching session's level
 * @returns {{model: string|undefined, thinking: string|undefined, inherits: boolean, droppedPin: boolean}}
 */
export function planDispatch({ agentModel, agentThinking, parentModel, parentThinking } = {}) {
	const pinned = typeof agentModel === "string" ? agentModel.trim() : "";
	const usable = pinned && !DROPPED_MODEL_RE.test(pinned) ? pinned : undefined;
	const inherits = !usable;
	const model = usable ?? (typeof parentModel === "string" && parentModel ? parentModel : undefined);
	const declared = typeof agentThinking === "string" ? agentThinking.trim() : "";
	const thinking = declared || (inherits && typeof parentThinking === "string" && parentThinking ? parentThinking : undefined);
	return {
		model,
		thinking: thinking || undefined,
		inherits,
		droppedPin: Boolean(pinned) && !usable,
	};
}
