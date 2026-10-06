import { randomUUID } from "node:crypto";
import {
	compact,
	convertToLlm,
	findCutPoint,
	serializeConversation,
	sessionEntryToContextMessages,
	SettingsManager,
	type CompactionEntry,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import type { LoadedPrompt } from "./prompts.ts";

/**
 * Mirrors Pi's prepareCompaction(): true when a compaction of this branch would have at least one message to
 * summarize, false when Pi would fail with "Nothing to compact" (everything fits inside keepRecentTokens, or the
 * last entry is already a compaction).
 */
export function hasCompactionMaterial(entries: SessionEntry[], keepRecentTokens: number): boolean {
	if (entries.length === 0 || entries[entries.length - 1]!.type === "compaction") return false;
	let previous = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.type === "compaction") {
			previous = i;
			break;
		}
	}
	let boundaryStart = 0;
	if (previous >= 0) {
		const firstKept = entries.findIndex((entry) => entry.id === (entries[previous] as CompactionEntry).firstKeptEntryId);
		boundaryStart = firstKept >= 0 ? firstKept : previous + 1;
	}
	const cut = findCutPoint(entries, boundaryStart, entries.length, keepRecentTokens);
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	for (let i = boundaryStart; i < historyEnd; i++) {
		const entry = entries[i]!;
		if (entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0) return true;
	}
	if (cut.isSplitTurn) {
		for (let i = cut.turnStartIndex; i < cut.firstKeptEntryIndex; i++) {
			if (sessionEntryToContextMessages(entries[i]!).length > 0) return true;
		}
	}
	return false;
}

/** Pi's retained recent history for this working directory (global settings merged with the project's). */
export function keepRecentTokens(cwd: string): number {
	return SettingsManager.create(cwd).getCompactionKeepRecentTokens();
}

function historyInput(messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"], previous?: string): string {
	const conversation = serializeConversation(convertToLlm(messages));
	return `<conversation>\n${conversation}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}`;
}

/** Pi 1.x wraps the split-turn prefix differently ("# Conversation" / "# Instructions") than the main history. */
function turnPrefixInput(messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"]): string {
	const conversation = serializeConversation(convertToLlm(messages));
	return `# Conversation\n${conversation}\n\n# Instructions\n`;
}

function summaryInstructions(event: SessionBeforeCompactEvent, prompt: LoadedPrompt): string {
	return [
		"Summarize the supplied historical data. Do not continue the task, simulate tools, or claim actions without tool-result evidence. Keep pending actions pending.",
		prompt.text,
		event.preparation.isSplitTurn ? "This is a split turn. Summarize only the supplied history or turn prefix; the recent suffix remains available." : "",
		event.customInstructions ? `Additional summarization instructions from the operator: ${event.customInstructions}` : "",
	].filter(Boolean).join("\n\n");
}

/**
 * Replace Pi's generic summary instructions with ours inside the summary request.
 *
 * Fail-soft on purpose: the context handed to the transform may contain user
 * messages written by other extensions (e.g. observational-memory) or already
 * partially rewritten, so a strict `startsWith` match can miss blocks that are
 * none of our business. Unknown text blocks are left untouched and counted,
 * instead of aborting the whole compaction while tools are locked.
 */
function replaceInstructions(context: Context, inputs: string[], instructions: string, budgetChars: number) {
	let truncated = false;
	let replaced = 0;
	let unrecognized = 0;
	const messages = context.messages.map(message => {
		if (message.role !== "user") return message;
		const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		return {
			...message,
			content: content.map(block => {
				if (block.type !== "text") return block;
				let input = inputs.find(candidate => candidate.length > 0 && block.text.startsWith(candidate));
				if (input === undefined) {
					// Tolerate wrappers prepended by other extensions/hooks: look for our
					// serialized conversation inside the block and only rewrite from there.
					input = inputs.find(candidate => {
						const marker = "<conversation>\n";
						const at = candidate.indexOf(marker);
						if (at < 0) return false;
						const core = candidate.slice(at);
						return core.length > 64 && block.text.includes(core.slice(0, Math.min(core.length, 4096)));
					});
				}
				if (input === undefined) {
					unrecognized++;
					return block;
				}
				replaced++;
				if (input.length > budgetChars) {
					input = `[earlier conversation truncated to fit summary budget]\n${input.slice(-budgetChars)}`;
					truncated = true;
				}
				return { ...block, text: `${input}${instructions}` };
			}),
		};
	});
	// Fail-soft: never abort compaction over an unmatched request shape. Leaving Pi's
	// original instructions untouched yields a generic summary — vastly better than a
	// locked session with a kept note. The caller reports `replaced` to the user.
	return { messages, truncated, unrecognized, replaced };
}

/** Pi owns split turns, summary updates, file tracking and configured transport retries. */
export async function generateSummary(event: SessionBeforeCompactEvent, ctx: ExtensionContext, system: LoadedPrompt, instructions: LoadedPrompt, onNotice?: (message: string) => void) {
	if (!ctx.model) throw new Error("No model available for compaction.");
	const inputs = [
		historyInput(event.preparation.messagesToSummarize, event.preparation.previousSummary),
		turnPrefixInput(event.preparation.turnPrefixMessages),
		historyInput(event.preparation.turnPrefixMessages), // legacy <conversation> wrapper used by older Pi builds
	].sort((a, b) => b.length - a.length);
	const userInstructions = summaryInstructions(event, instructions);
	let truncatedInput = false;
	const result = await compact(
		event.preparation, ctx.model, undefined, undefined, event.customInstructions, event.signal, ctx.thinkingLevel,
		async (model, context, options) => {
			const maxTokens = Math.min(options?.maxTokens ?? 8192, model.maxTokens || 8192, 8192);
			const budgetChars = Math.max(8000, (model.contextWindow - maxTokens - 2000) * 4 - system.text.length - userInstructions.length);
			const { messages, truncated, unrecognized, replaced } = replaceInstructions(context, inputs, userInstructions, budgetChars);
			truncatedInput ||= truncated;
			if (replaced === 0) onNotice?.("self-compact: summary request shape not recognized; kept Pi's default summary instructions for this request (compaction continues).");
			if (unrecognized > 0) onNotice?.(`self-compact: skipped ${unrecognized} unrecognized user text block${unrecognized === 1 ? "" : "s"} while replacing summary instructions (another extension likely rewrote them); compaction continues.`);
			// Use streamSimple rather than complete: Pi routes virtual models (for example
			// ontoken/auto) on this path before dispatching to their physical model.
			const response = await ctx.modelRegistry.streamSimple(model, { ...context, systemPrompt: system.text, messages }, {
				...options, maxTokens, signal: event.signal, cacheRetention: "none", sessionId: randomUUID(),
				...(model.api === "openai-completions" && model.reasoning ? { reasoningEffort: "low" as const } : {}),
			}).result();
			if (event.signal.aborted || response.stopReason === "aborted") throw new Error("Compaction summary cancelled.");
			if (response.stopReason !== "error" && !response.content.some(block => block.type === "text" && block.text.trim())) throw new Error("Summary response was empty.");
			const stream = createAssistantMessageEventStream();
			stream.end(response);
			return stream;
		},
		undefined, SettingsManager.create(ctx.cwd).getRetrySettings(),
	);
	if (event.signal.aborted) throw new Error("Compaction summary cancelled.");
	return { result, truncatedInput };
}
