/**
 * `matter check <path>`: certify a vault's integrity from the command line.
 *
 * One pipeline, scope inferred from the path (`load/fs`): point it at a table folder and it checks
 * that one table; point it at a vault of table folders and it checks the whole vault, references
 * and all. The path becomes `TableInput[]`, `assess` classifies it once, the `core` selectors
 * (`toViolations`, `summarize`) project that one structure, and `report/` renders it into the human
 * text, the `--json`, and the exit code, so every surface agrees by construction.
 *
 * A single-table check is a one-table vault: its references have no target tables loaded, so every
 * reference is `missing-target`. Those are un-evaluable in isolation, surfaced as a note, not a
 * failure: checking `pages/` must not fail for references only the whole vault can resolve.
 */

import { describeExpected } from '../lib/core/expected';
import { assess } from '../lib/core/integrity';
import {
	type Summary,
	summarize,
	toViolations,
	type Violation,
} from '../lib/core/violations';
import { loadPath } from '../lib/load/fs';
import { exitCodeFor } from '../lib/report/exit-code';
import { formatReport } from '../lib/report/format';

type Args = { json: boolean; path: string } | { json: boolean; error: string };

function parseArgs(argv: string[]): Args {
	let json = false;
	let path: string | undefined;

	for (const arg of argv) {
		if (arg === '--json') {
			json = true;
			continue;
		}
		if (arg.startsWith('-')) {
			return { json, error: `unknown option ${arg}` };
		}
		if (path !== undefined) {
			return { json, error: `expected one path, got ${path} and ${arg}` };
		}
		path = arg;
	}

	return { json, path: path ?? '.' };
}

/**
 * The serializable form of a violation. Every kind is already plain JSON except `invalid-type`,
 * which carries the loaded {@link Field}; that is projected to its name plus the computed expected
 * value, so `describeExpected` runs here at the JSON edge and the function never leaks out.
 */
function serializeViolation(violation: Violation): unknown {
	if (violation.kind !== 'invalid-type') return violation;
	return {
		kind: violation.kind,
		table: violation.table,
		row: violation.row,
		field: violation.field.name,
		raw: violation.raw,
		expected: describeExpected(violation.field),
	};
}

/** The note block for references a single-table check could not evaluate. Empty when there are none. */
function unevaluableNote(unevaluable: readonly Violation[]): string {
	if (unevaluable.length === 0) return '';
	const lines = unevaluable.map((violation) =>
		violation.kind === 'missing-target'
			? `  ${violation.field} -> ${violation.target}`
			: `  ${violation.field}`,
	);
	return [
		'note: references not checked when checking a single table; run on the whole vault to resolve',
		...lines,
	].join('\n');
}

function writeText(
	summary: Summary,
	failures: readonly Violation[],
	unevaluable: readonly Violation[],
): void {
	const note = unevaluableNote(unevaluable);
	const report = formatReport(failures, summary);
	process.stdout.write(`${note ? `${report}\n\n${note}` : report}\n`);
}

function writeJson(
	scope: 'table' | 'vault',
	summary: Summary,
	failures: readonly Violation[],
	unevaluable: readonly Violation[],
): void {
	const payload = {
		scope,
		violations: failures.map(serializeViolation),
		unevaluableReferences: unevaluable.map(serializeViolation),
		summary,
	};
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if ('error' in args) {
		process.stderr.write(`${args.error}\n`);
		return 2;
	}

	const { scope, tables } = await loadPath(args.path);
	const integrity = assess(tables);
	const summary = summarize(integrity);
	const violations = toViolations(integrity);

	// Single-table scope cannot load any target table, so every reference is missing-target and
	// un-evaluable in isolation: hold those out of the failures as notes. (dangling cannot occur
	// in table scope; it needs the target table present.)
	const isTableScope = scope === 'table';
	const unevaluable = isTableScope
		? violations.filter((violation) => violation.kind === 'missing-target')
		: [];
	const failures = isTableScope
		? violations.filter((violation) => violation.kind !== 'missing-target')
		: violations;

	if (args.json) {
		writeJson(scope, summary, failures, unevaluable);
	} else {
		writeText(summary, failures, unevaluable);
	}
	return exitCodeFor(summary, failures);
}

process.exitCode = await main();
