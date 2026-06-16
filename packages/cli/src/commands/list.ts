/**
 * `epicenter list [mount.action_key]`: render actions exposed by this root.
 *
 * The daemon returns a mount label plus bare action keys. The CLI is the
 * public-addressing edge: it prefixes those keys as `<mount>.<action>` before
 * filtering and rendering.
 *
 * Per-peer schema introspection is a script concern. The CLI lists the local
 * daemon's mounted action surface only.
 *
 * `epicenter list` requires a running daemon for the discovered Epicenter root.
 * Without `daemon up`, the handler errors with a hint pointing at
 * `epicenter daemon up`.
 */

import type { ActionManifest } from '@epicenter/workspace';
import { type DaemonError, getDaemon } from '@epicenter/workspace/node';
import Type, { type TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';

import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';

export const listCommand = cmd({
	command: 'list [path]',
	describe: 'List exposed queries and mutations on this node, by mount',
	builder: (yargs) =>
		yargs
			.positional('path', {
				type: 'string',
				describe: 'Optional mount-prefixed path to narrow the view',
			})
			.option('C', epicenterRootOption)
			.options(formatOptions),
	handler: async (argv) => {
		const path = argv.path ?? '';

		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}
		const result = await daemon.list();
		renderResult(result, path, argv.format);
	},
});

function renderResult(
	result: Result<{ mount: string; actions: ActionManifest }, DaemonError>,
	path: string,
	format: OutputFormat | undefined,
): void {
	if (result.error !== null) {
		switch (result.error.name) {
			case 'Required':
			case 'Timeout':
			case 'Unreachable':
			case 'HandlerCrashed':
				fail(result.error.message);
				return;
			default:
				result.error satisfies never;
				return;
		}
	}
	if (format) {
		renderJson(toPrefixedManifest(result.data), path, format);
		return;
	}
	renderText(toPrefixedManifest(result.data), path);
}

function toPrefixedManifest({
	mount,
	actions,
}: {
	mount: string;
	actions: ActionManifest;
}): ActionManifest {
	const manifest: ActionManifest = {};
	for (const [path, meta] of Object.entries(actions)) {
		manifest[`${mount}.${path}`] = meta;
	}
	return manifest;
}

function renderJson(
	entries: ActionManifest,
	path: string,
	format: OutputFormat,
): void {
	const action = path ? entries[path] : undefined;
	if (action) {
		output(toActionDescriptor(action, path), { format });
		return;
	}

	const subset = filterByPath(entries, path);
	const rows = Object.entries(subset).map(([p, meta]) =>
		toActionDescriptor(meta, p),
	);
	if (path && rows.length === 0) {
		fail(`"${path}" is not defined.`);
		return;
	}
	output(rows, { format });
}

function renderText(entries: ActionManifest, path: string): void {
	const subset = filterByPath(entries, path);
	const matches = Object.keys(subset).length;

	if (path && matches === 0) {
		fail(`"${path}" is not defined.`);
		return;
	}

	if (matches === 0) {
		console.error('(no actions exposed)');
		return;
	}

	const leaf = path ? entries[path] : undefined;
	if (leaf && matches === 1) {
		printActionDetail(path, leaf);
		return;
	}
	printGroupedByMount(subset);
}

function filterByPath(entries: ActionManifest, path: string): ActionManifest {
	if (!path) return entries;
	const pfx = `${path}.`;
	const out: ActionManifest = {};
	for (const [p, meta] of Object.entries(entries)) {
		if (p === path || p.startsWith(pfx)) out[p] = meta;
	}
	return out;
}

type ActionDescriptor = {
	path: string;
	type: string;
	description?: string;
	input?: unknown;
};

function toActionDescriptor(
	action: ActionManifest[string],
	path: string,
): ActionDescriptor {
	const desc: ActionDescriptor = { path, type: action.type };
	if (action.description) desc.description = action.description;
	if (action.input) desc.input = action.input;
	return desc;
}

/**
 * Action paths are exactly `mount.action_key` (mount names reject dots, action
 * keys are snake_case), so the manifest is two levels deep by construction.
 * Render one mount header per group with its actions indented underneath.
 */
function printGroupedByMount(entries: ActionManifest): void {
	const byMount = new Map<string, [string, ActionManifest[string]][]>();
	for (const [path, action] of Object.entries(entries)) {
		const dot = path.indexOf('.');
		const mount = dot === -1 ? path : path.slice(0, dot);
		const key = dot === -1 ? '' : path.slice(dot + 1);
		const group = byMount.get(mount);
		if (group) group.push([key, action]);
		else byMount.set(mount, [[key, action]]);
	}

	let first = true;
	for (const [mount, group] of byMount) {
		if (!first) console.log('');
		first = false;
		console.log(mount);
		for (const [key, action] of group) {
			const desc = action.description ? `  ${action.description}` : '';
			console.log(`  ${key}  (${action.type})${desc}`);
		}
	}
}

function printActionDetail(path: string, action: ActionManifest[string]): void {
	console.log(`${path}  (${action.type})`);
	if (action.description) {
		console.log('');
		console.log(`  ${action.description}`);
	}
	if (action.input) {
		console.log('');
		console.log('  Input fields (pass as JSON):');
		for (const line of describeInput(action.input)) console.log(`    ${line}`);
	}
}

function describeInput(schema: TSchema): string[] {
	if (!Type.IsObject(schema)) return ['(non-object input schema)'];
	const required = new Set(schema.required ?? []);
	const lines: string[] = [];
	for (const [key, field] of Object.entries(schema.properties)) {
		const fieldSchema = field as TSchema & {
			type?: string;
			description?: string;
		};
		const typeLabel = fieldSchema.type ?? 'value';
		const req = required.has(key) ? 'required' : 'optional';
		const desc = fieldSchema.description ? `  ${fieldSchema.description}` : '';
		lines.push(`${key}: ${typeLabel}  (${req})${desc}`);
	}
	return lines;
}
