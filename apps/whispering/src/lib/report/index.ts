import { toast as sonner } from '@epicenter/ui/sonner';
import { nanoid } from 'nanoid/non-secure';
import type { AnyTaggedError } from 'wellcrafted/error';
import { consoleSink, type LogEvent } from 'wellcrafted/logger';
import { moreDetailsDialog } from '$lib/components/MoreDetailsDialog.svelte';
import { humanize } from './humanize';
import { osNotify } from './os-notify';

export type NoticeAction = {
	label: string;
	onClick: () => void | Promise<void>;
};

export type Notice = {
	title?: string;
	description?: string;
	action?: NoticeAction;
	cause?: AnyTaggedError;
};

export type Problem = Notice & { cause: AnyTaggedError };

type Level = 'error' | 'success' | 'info' | 'loading';

const SOURCE = 'whispering/report';

const TOAST_DURATION = {
	error: Number.POSITIVE_INFINITY,
	success: 3000,
	info: 4000,
	loading: Number.POSITIVE_INFINITY,
} as const;

// ── Public API ────────────────────────────────────────────────────────────

export const report = {
	error(problem: Problem): void {
		emit('error', problem);
	},
	success(notice: Notice): void {
		emit('success', notice);
	},
	info(notice: Notice): void {
		emit('info', notice);
	},
	loading(notice: Notice) {
		const id = nanoid();
		emit('loading', notice, id);
		return {
			/** Resolve the loading notice as a success notice. */
			resolve: (r: Notice) => emit('success', r, id),
			/** Resolve the loading notice as an error notice. */
			reject: (r: Problem) => emit('error', r, id),
			/** Replace the displayed loading notice content. */
			update: (r: Notice) => emit('loading', r, id),
		};
	},
};

/**
 * Diagnostic-only logger. Use for events that should appear in console for
 * debugging but should NEVER surface to the user as a toast or OS notification
 * (e.g. "Recording started", "Invalid device config, using default").
 */
export const log = {
	info(message: string, data?: unknown): void {
		consoleSink({
			ts: Date.now(),
			level: 'info',
			source: SOURCE,
			message,
			data,
		} satisfies LogEvent);
	},
} as const;

// ── Internals ─────────────────────────────────────────────────────────────

/**
 * Fan a notice out to the console, toast, and OS-notification surfaces.
 *
 * `id` is the sonner toast correlation id: pass it from the loading family so
 * resolve/reject/update can target the same toast. Omit it for one-shot
 * error/success/info reports.
 */
function emit(level: Level, notice: Notice, id?: string): void {
	const title =
		(notice.title ?? humanize(notice.cause?.name ?? '')) || 'Notice';
	const description = notice.description ?? notice.cause?.message;

	if (level !== 'loading') {
		consoleSink({
			ts: Date.now(),
			level: level === 'error' ? 'error' : 'info',
			source: SOURCE,
			message: notice.title ?? notice.cause?.message ?? '',
			data: id !== undefined ? { ...notice, id } : notice,
		} satisfies LogEvent);
	}

	sonner[level](title, {
		id,
		description,
		descriptionClass: 'line-clamp-6',
		duration: TOAST_DURATION[level],
		action: notice.action ?? defaultMoreDetailsAction(level, notice.cause),
	});

	if (level === 'error' && !document.hasFocus()) {
		void osNotify(title, description);
	}
}

function defaultMoreDetailsAction(
	level: Level,
	cause: AnyTaggedError | undefined,
): NoticeAction | undefined {
	if (level !== 'error' || !cause) return undefined;
	return {
		label: 'More details',
		onClick: () =>
			moreDetailsDialog.open({
				title: 'More details',
				description: 'The following is the raw error message.',
				content: cause,
			}),
	};
}
