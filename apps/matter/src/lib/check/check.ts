import type { Field } from '@epicenter/field';
import type { Cell } from '../core/conformance';
import { type FolderEntry, type FolderRead, readFolder } from '../core/folder';
import {
	buildFatalCheckReport,
	type CheckReport,
	type CheckResult,
	type ExpectedValue,
} from './report';

type ModelInput =
	| { kind: 'loaded'; text: string }
	| { kind: 'missing' }
	| { kind: 'unreadable'; reason: string };

export type CheckInput =
	| { kind: 'folder-unreadable'; folder: string; reason: string }
	| {
			kind: 'folder';
			folder: string;
			entries: readonly FolderEntry[];
			model: ModelInput;
	  };

function describeExpected(field: Field): ExpectedValue {
	switch (field.kind) {
		case 'select':
			return { kind: 'select', values: [...field.schema.enum] };
		case 'multiSelect':
			return { kind: 'multiSelect', values: [...field.schema.items.enum] };
		case 'string':
		case 'url':
		case 'date':
		case 'instant':
		case 'datetime':
		case 'integer':
		case 'number':
		case 'boolean':
		case 'tags':
		case 'json':
			return { kind: field.kind };
		default:
			return field satisfies never;
	}
}

function quotedList(values: readonly string[]): string {
	return values.map((value) => `"${value}"`).join(', ');
}

function unrecognizedFieldText(fields: readonly string[]): string {
	if (fields.length === 1) {
		const [field] = fields;
		if (field !== undefined) {
			return `field "${field}" is not a recognized Matter field`;
		}
	}

	return `fields ${quotedList(fields)} are not recognized Matter fields`;
}

function unmatchedOptionalText(fields: readonly string[]): string {
	if (fields.length === 1) {
		const [field] = fields;
		if (field !== undefined) {
			return `optional entry "${field}" does not name a typed field`;
		}
	}

	return `optional entries ${quotedList(fields)} do not name typed fields`;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function unrecognizedModelReport(
	folder: string,
	unmodeled: readonly string[],
	unmatchedOptional: readonly string[],
): CheckResult {
	const fields = unique([...unmodeled, ...unmatchedOptional]);
	const parts = [
		unmodeled.length > 0 ? unrecognizedFieldText(unmodeled) : undefined,
		unmatchedOptional.length > 0
			? unmatchedOptionalText(unmatchedOptional)
			: undefined,
	].filter((part): part is string => part !== undefined);

	return buildFatalCheckReport(
		folder,
		'MODEL_UNRECOGNIZED_FIELD',
		parts.join('; '),
		fields,
	);
}

function increment(
	count: CheckReport['byField'][number],
	state: Cell['state'],
): void {
	switch (state) {
		case 'OK':
			count.ok += 1;
			return;
		case 'MISSING_OPTIONAL':
			count.empty += 1;
			return;
		case 'MISSING_REQUIRED':
			count.needsValue += 1;
			return;
		case 'INVALID':
			count.invalid += 1;
			return;
		default:
			state satisfies never;
	}
}

function reportFromRead(folder: string, read: FolderRead): CheckResult {
	if (read.view.mode === 'unmodeled') {
		if (read.view.modelError) {
			return buildFatalCheckReport(
				folder,
				'MODEL_INVALID',
				read.view.modelError.message,
			);
		}
		return buildFatalCheckReport(
			folder,
			'MODEL_INVALID',
			'matter.json did not produce a modeled view',
		);
	}

	if (
		read.view.model.unmodeled.length > 0 ||
		read.view.model.unmatchedOptional.length > 0
	) {
		return unrecognizedModelReport(
			folder,
			read.view.model.unmodeled,
			read.view.model.unmatchedOptional,
		);
	}

	const byField = read.view.model.fields.map((field) => ({
		field: field.name,
		ok: 0,
		empty: 0,
		needsValue: 0,
		invalid: 0,
	}));
	const countByField = new Map(byField.map((count) => [count.field, count]));
	const findings: CheckReport['findings'] = [];

	for (const conformance of read.view.conformance) {
		for (const cell of conformance.cells) {
			const count = countByField.get(cell.field.name);
			if (count) increment(count, cell.state);

			if (cell.state === 'MISSING_REQUIRED') {
				findings.push({
					file: conformance.row.fileName,
					field: cell.field.name,
					state: 'NEEDS_VALUE',
				});
			} else if (cell.state === 'INVALID') {
				findings.push({
					file: conformance.row.fileName,
					field: cell.field.name,
					state: 'INVALID',
					actual: cell.raw,
					expected: describeExpected(cell.field),
				});
			}
		}
	}

	const unreadable = read.unreadable.map((file) => ({
		file: file.fileName,
		error: file.error.message,
	}));
	const extras = read.view.conformance
		.filter((conformance) => conformance.extras.length > 0)
		.map((conformance) => ({
			file: conformance.row.fileName,
			keys: conformance.extras.map((extra) => extra.key),
		}));
	const ready = read.view.conformance.filter(
		(conformance) => conformance.rowValid,
	).length;
	const needsAttention = read.view.conformance.length - ready;

	return {
		version: 1,
		status: 'checked',
		folder,
		model: {
			fields: read.view.model.fields.map((field) => ({
				name: field.name,
				kind: field.kind,
				required: field.required,
			})),
		},
		summary: {
			files: read.rows.length + read.unreadable.length,
			ready,
			needsAttention,
			unreadable: read.unreadable.length,
		},
		findings,
		byField,
		unreadable,
		extras,
	};
}

export function check(input: CheckInput): CheckResult {
	if (input.kind === 'folder-unreadable') {
		return buildFatalCheckReport(
			input.folder,
			'FOLDER_UNREADABLE',
			`folder could not be read: ${input.reason}`,
		);
	}

	switch (input.model.kind) {
		case 'missing':
			return buildFatalCheckReport(
				input.folder,
				'MODEL_MISSING',
				'matter.json is missing',
			);
		case 'unreadable':
			return buildFatalCheckReport(
				input.folder,
				'MODEL_INVALID',
				`matter.json could not be read: ${input.model.reason}`,
			);
		case 'loaded':
			return reportFromRead(
				input.folder,
				readFolder(input.entries, input.model.text),
			);
		default:
			return input.model satisfies never;
	}
}
