/**
 * Task-list hints at the compaction boundary.
 *
 * General task reminders belong to the task extension (e.g. @tintinweb/pi-tasks, which nudges on its
 * own cadence). self-compact only covers the two moments that extension cannot see:
 * - before compacting: bring task statuses up to date and name open task IDs in the note;
 * - right after the handoff: look at the task list before resuming the NEXT ACTION.
 *
 * Hints are added only when the task tools are active, so self-compact behaves exactly as before
 * without a task extension. They are short and transient (never persisted).
 */

/** Tools that must both be active for the hints to make sense. */
export const TASK_LIST_TOOL = "TaskList";
export const TASK_UPDATE_TOOL = "TaskUpdate";

export function taskToolsActive(activeTools: readonly string[]): boolean {
	return activeTools.includes(TASK_LIST_TOOL) && activeTools.includes(TASK_UPDATE_TOOL);
}

/** Appended to every "write your note and compact" request (warning, forced, compact-now). */
export const TASK_PRE_COMPACT_HINT = `Task list: first bring it up to date with \`${TASK_UPDATE_TOOL}\` (mark finished tasks completed, the current one in_progress) and \`TaskCreate\` for any untracked remaining step, then list the open task IDs in the note and reference the task ID in NEXT ACTION (e.g. "NEXT ACTION (#3): …").`;

/** Under the hard cutoff only self_compact runs, so the task tools cannot be called: note only. */
export const TASK_FORCED_HINT = `Task list: other tools are blocked, so do not update tasks now; list the open task IDs and their real status in the note and reference the task ID in NEXT ACTION. Update the task list first thing after the handoff.`;

/** Transient message after the handoff note, before the first resumed call. */
export const TASK_RESUME_HINT = `[self-compact · resume] Before the NEXT ACTION, call \`${TASK_LIST_TOOL}\` once: fix statuses the note says are done or in progress, create tasks for untracked remaining steps, then continue with the NEXT ACTION.`;

export type HintKind = "pre-compact" | "forced";

/** `text` plus the hint for `kind`, or `text` unchanged when task tools are not active. */
export function withTaskHint(text: string, kind: HintKind, activeTools: readonly string[]): string {
	if (!taskToolsActive(activeTools)) return text;
	return `${text}\n\n${kind === "forced" ? TASK_FORCED_HINT : TASK_PRE_COMPACT_HINT}`;
}

type MessageLike = { role?: string; customType?: string };

/**
 * True when the request about to be sent is the first one after a handoff: a handoff message (the
 * verbatim note, or the resume nudge after a crash) follows the newest assistant message. Other
 * extensions may append their own transient messages after it (e.g. a task reminder), so the
 * handoff does not have to be the very last message.
 */
export function awaitingResume(messages: readonly MessageLike[], handoffType: string): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return false;
		if (message.role === "custom" && message.customType === handoffType) return true;
	}
	return false;
}
