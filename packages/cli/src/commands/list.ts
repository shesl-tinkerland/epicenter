/**
 * `epicenter list [dot.path]`: render the actions exposed by this workspace.
 *
 * Conceptually this is a one-line shell shortcut for
 * `describeActions(workspace.actions)` against the daemon's live workspace.
 * Nothing more. The CLI is the shell-friendly surface for one-shot queries;
 * orchestration (fan-out across peers, conditional dispatch, loops) belongs
 * in vault-style TypeScript scripts that load the workspace library
 * directly via `loadConfig` and call `describePeer` / `sync.rpc` themselves.
 *
 * Per-peer schema introspection used to live here as `list --peer <id>` /
 * `list --all`. It moved to `epicenter peers <deviceId>`, which is the
 * natural home: the peers verb already owns the awareness/RPC dimension.
 *
 * `epicenter list` requires a running daemon for the resolved `--dir`.
 * Without `up`, the handler errors with a hint pointing at `epicenter up`.
 */

import { type ActionManifest } from '@epicenter/workspace';
import Type, { type TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { Argv, CommandModule } from 'yargs';

import { type DaemonError, getDaemon } from '../daemon/client';
import {
	dirOption,
	resolveTarget,
	workspaceOption,
} from '../util/common-options';
import {
	formatYargsOptions,
	output,
	outputError,
} from '../util/format-output';
import type { ResolveError } from '../util/resolve-entry';

type Format = 'json' | 'jsonl' | undefined;

export type ListResult = Result<ActionManifest, ResolveError>;

export const listCommand: CommandModule = {
	command: 'list [path]',
	describe: 'Tree view of exposed queries and mutations on this device',
	builder: (yargs: Argv) =>
		yargs
			.positional('path', {
				type: 'string',
				describe: 'Optional dot-path to narrow the view',
			})
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.options(formatYargsOptions())
			.example('$0 list', 'Tree of every exposed action (human view)')
			.example('$0 list sync.peers', 'Drill into one subtree')
			.example(
				'$0 list --format json | jq -r \'.[] | select(.type=="mutation") | .path\'',
				'Every mutation path, via jq',
			)
			.example(
				'$0 list --format jsonl | fzf | jq -r .path | xargs $0 run',
				'Interactive action picker piped into `run`',
			),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const path = typeof args.path === 'string' ? args.path : '';
		const format = args.format as Format;
		const target = resolveTarget(args);

		const { data: daemon, error: daemonErr } = await getDaemon(target);
		if (daemonErr) {
			outputError(daemonErr.message);
			process.exitCode = 1;
			return;
		}
		const result = await daemon.list({ workspace: target.userWorkspace });
		renderResult(result, path, format);
	},
};

function renderResult(
	result: Result<ActionManifest, ResolveError | DaemonError>,
	path: string,
	format: Format,
): void {
	if (result.error !== null) {
		switch (result.error.name) {
			case 'UnknownWorkspace':
			case 'AmbiguousWorkspace':
			case 'MissingConfig':
			case 'Required':
			case 'Timeout':
			case 'Unreachable':
			case 'HandlerCrashed':
				outputError(`error: ${result.error.message}`);
				process.exitCode = 1;
				return;
		}
		return;
	}
	if (format) {
		renderJson(result.data, path, format);
		return;
	}
	renderText(result.data, path);
}

function renderJson(
	entries: ActionManifest,
	path: string,
	format: Exclude<Format, undefined>,
): void {
	if (path && entries[path]) {
		output(toActionDescriptor(entries[path]!, path), { format });
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
		console.log('(no actions exposed)');
		return;
	}

	const leaf = path ? entries[path] : undefined;
	if (leaf && matches === 1) {
		printActionDetail(path, leaf);
		return;
	}
	printTree(subset, path);
}

function fail(message: string): void {
	outputError(`error: ${message}`);
	process.exitCode = 1;
}

export function filterByPath(entries: ActionManifest, path: string): ActionManifest {
	if (!path) return entries;
	const pfx = path + '.';
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

function toActionDescriptor(action: ActionManifest[string], path: string): ActionDescriptor {
	const desc: ActionDescriptor = { path, type: action.type };
	if (action.description) desc.description = action.description;
	if (action.input) desc.input = action.input;
	return desc;
}

type TreeNode = {
	name: string;
	children: Map<string, TreeNode>;
	action?: ActionManifest[string];
};

function printTree(entries: ActionManifest, prefix: string): void {
	const pfx = prefix ? prefix + '.' : '';
	const root: TreeNode = { name: '', children: new Map() };
	for (const [path, action] of Object.entries(entries)) {
		const rest = prefix ? path.slice(pfx.length) : path;
		if (!rest) continue;
		const parts = rest.split('.');
		let node = root;
		for (let i = 0; i < parts.length; i++) {
			const seg = parts[i]!;
			let child = node.children.get(seg);
			if (!child) {
				child = { name: seg, children: new Map() };
				node.children.set(seg, child);
			}
			node = child;
			if (i === parts.length - 1) node.action = action;
		}
	}
	printChildren(root, '');
}

function printChildren(node: TreeNode, prefix: string): void {
	const children = [...node.children.values()];
	children.forEach((child, idx) => {
		const isLast = idx === children.length - 1;
		const branch = isLast ? '└── ' : '├── ';
		const label = child.action
			? `${child.name}  (${child.action.type})${
					child.action.description ? `  ${child.action.description}` : ''
				}`
			: child.name;
		console.log(`${prefix}${branch}${label}`);
		if (child.children.size > 0) {
			printChildren(child, prefix + (isLast ? '    ' : '│   '));
		}
	});
}

function printActionDetail(
	path: string,
	action: ActionManifest[string],
): void {
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
		const f = field as TSchema & { type?: string; description?: string };
		const typeLabel = f.type ?? 'value';
		const req = required.has(key) ? 'required' : 'optional';
		const desc = f.description ? `  ${f.description}` : '';
		lines.push(`${key}: ${typeLabel}  (${req})${desc}`);
	}
	return lines;
}
