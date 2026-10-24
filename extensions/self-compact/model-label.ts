/**
 * Footer model label. The replacement footer hides Pi's built-in one, which shows where a virtual
 * model (e.g. `ontoken/auto`) routed the latest request. This rebuilds that information from the
 * session branch so the footer reads `auto → work · glm-5.3-flash · low` instead of just `auto`.
 */

/** Custom entry type Pi uses to persist virtual-model router state on the branch. */
export const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";
/** API id of virtual catalog entries. */
export const VIRTUAL_MODEL_API = "pi-virtual";

export interface LabelModel {
	provider: string;
	id: string;
	api?: string;
	reasoning?: boolean;
}

export interface RouteInfo {
	/** Router role / slot name (router-specific, optional). */
	role?: string;
	modelId?: string;
	thinking?: string;
}

type Entry = {
	type?: string;
	customType?: string;
	data?: unknown;
	provider?: string;
	modelId?: string;
	message?: { role?: string; model?: string; provider?: string; api?: string; stopReason?: string; thinkingLevel?: string };
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * Latest route of the active virtual model on the branch. Scans backwards and stops at the
 * selection boundary (a `model_change`), so state from a previous model is never shown.
 * Router state wins (it is written when the request is routed, before the response); the latest
 * successful response is the fallback for routers that keep no state.
 */
export function latestRoute(branch: readonly Entry[], model: LabelModel): RouteInfo | undefined {
	let response: RouteInfo | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "model_change") break;
		if (entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY) {
			const data = entry.data as { provider?: string; modelId?: string; state?: Record<string, unknown> } | undefined;
			if (data?.provider !== model.provider || data?.modelId !== model.id) continue;
			const state = data.state;
			if (!state) continue;
			return {
				role: str(state.slot) ?? str(state.role),
				modelId: str(state.modelId) ?? response?.modelId,
				thinking: str(state.thinking) ?? str(state.thinkingLevel) ?? response?.thinking,
			};
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (!response && message?.role === "assistant" && message.api !== VIRTUAL_MODEL_API && message.stopReason !== "error" && message.stopReason !== "aborted") {
			response = { modelId: str(message.model), thinking: str(message.thinkingLevel) };
		}
	}
	return response;
}

/**
 * Footer label.
 * - Virtual model: `auto → role · model · thinking` (parts that are unknown are omitted).
 * - Physical model: `model · thinking` when it supports reasoning, else just the id.
 */
export function modelLabel(model: LabelModel | undefined, thinkingLevel: string | undefined, branch: readonly Entry[]): string {
	if (!model) return "no-model";
	if (model.api !== VIRTUAL_MODEL_API) {
		return model.reasoning && thinkingLevel ? `${model.id} · ${thinkingLevel === "off" ? "thinking off" : thinkingLevel}` : model.id;
	}
	const route = latestRoute(branch, model);
	if (!route) return model.id;
	const parts = [route.role, route.modelId, route.thinking].filter((p): p is string => Boolean(p));
	return parts.length > 0 ? `${model.id} → ${parts.join(" · ")}` : model.id;
}
