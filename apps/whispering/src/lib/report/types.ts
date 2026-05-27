import type { AnyTaggedError } from 'wellcrafted/error';

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

export type LoadingHandle = {
	resolve: (r: Notice) => void;
	reject: (r: Problem) => void;
};

export type Level = 'error' | 'success' | 'info' | 'loading';

export type ReportEvent = {
	ts: number;
	level: Level;
	source: string;
	data: Notice & { id?: string };
};

export type OsNotifySink = (event: ReportEvent) => void;
