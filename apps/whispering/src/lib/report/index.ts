import { toast as sonner } from '@epicenter/ui/sonner';
import { nanoid } from 'nanoid/non-secure';
import {
	type LogEvent,
	consoleSink as wellcraftedConsoleSink,
} from 'wellcrafted/logger';
import { moreDetailsDialog } from '$lib/components/MoreDetailsDialog.svelte';
import { resolveDisplay } from './display';
import { osNotifySink } from './os-notify';
import type {
	Level,
	LoadingHandle,
	Notice,
	NoticeAction,
	Problem,
	ReportEvent,
} from './types';

export type { LoadingHandle, Notice, NoticeAction, Problem } from './types';

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
	loading(notice: Notice): LoadingHandle {
		const id = nanoid();
		emit('loading', notice, id);
		return {
			resolve: (r) => emit('success', r, id),
			reject: (r) => emit('error', r, id),
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
		wellcraftedConsoleSink({
			ts: Date.now(),
			level: 'info',
			source: SOURCE,
			message,
			data,
		} satisfies LogEvent);
	},
} as const;

// ── Internals ─────────────────────────────────────────────────────────────

function emit(level: Level, notice: Notice, id?: string): void {
	const event: ReportEvent = {
		ts: Date.now(),
		level,
		source: SOURCE,
		data: id !== undefined ? { ...notice, id } : notice,
	};
	consoleSink(event);
	toastSink(event);
	osNotifySink(event);
}

function consoleSink(event: ReportEvent): void {
	if (event.level === 'loading') return;
	const { data } = event;
	wellcraftedConsoleSink({
		ts: event.ts,
		level: event.level === 'error' ? 'error' : 'info',
		source: event.source,
		message: data.title ?? data.cause?.message ?? '',
		data,
	} satisfies LogEvent);
}

function toastSink(event: ReportEvent): void {
	const { data } = event;
	const { title, description } = resolveDisplay(data);

	sonner[event.level](title, {
		id: data.id,
		description,
		descriptionClass: 'line-clamp-6',
		duration: TOAST_DURATION[event.level],
		action: resolveAction(data, event.level),
	});
}

function resolveAction(
	data: Notice & { id?: string },
	level: Level,
): NoticeAction | undefined {
	if (data.action) return data.action;
	if (level !== 'error' || !data.cause) return undefined;
	return {
		label: 'More details',
		onClick: () =>
			moreDetailsDialog.open({
				title: 'More details',
				description: 'The following is the raw error message.',
				content: data.cause,
			}),
	};
}
