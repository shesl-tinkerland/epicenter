import type { Kind } from '@epicenter/field';

export type ExpectedValue =
	| { kind: Exclude<Kind, 'select' | 'multiSelect'> }
	| { kind: 'select'; values: unknown[] }
	| { kind: 'multiSelect'; values: unknown[] };

export type CheckReport = {
	version: 1;
	status: 'checked';
	folder: string;
	model: {
		fields: Array<{ name: string; kind: Kind; required: boolean }>;
	};
	summary: {
		files: number;
		ready: number;
		needsAttention: number;
		unreadable: number;
	};
	findings: Array<
		| {
				file: string;
				field: string;
				state: 'NEEDS_VALUE';
		  }
		| {
				file: string;
				field: string;
				state: 'INVALID';
				actual: unknown;
				expected: ExpectedValue;
		  }
	>;
	byField: Array<{
		field: string;
		ok: number;
		empty: number;
		needsValue: number;
		invalid: number;
	}>;
	unreadable: Array<{
		file: string;
		error: string;
	}>;
	extras: Array<{
		file: string;
		keys: string[];
	}>;
};

export type FatalCheckReport = {
	version: 1;
	status: 'fatal';
	folder: string;
	fatal: {
		code:
			| 'FOLDER_UNREADABLE'
			| 'MODEL_MISSING'
			| 'MODEL_INVALID'
			| 'MODEL_UNRECOGNIZED_FIELD';
		message: string;
		fields?: string[];
	};
};

export type CheckResult = CheckReport | FatalCheckReport;

export function buildFatalCheckReport(
	folder: string,
	code: FatalCheckReport['fatal']['code'],
	message: string,
	fields?: string[],
): FatalCheckReport {
	return {
		version: 1,
		status: 'fatal',
		folder,
		fatal: fields ? { code, message, fields } : { code, message },
	};
}
