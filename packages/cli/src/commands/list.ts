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

import {
	type ActionManifest,
	getDaemon,
	type ResolveError,
} from '@epicenter/workspace';
import pc from 'picocolors';
import Type, { type TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { Argv, CommandModule } from 'yargs';

import {
	dirOption,
	resolveTarget,
	workspaceOption,
} from '../util/common-options';
import { fail, formatYargsOptions, output } from '../util/format-output';

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
		const path =
			typeof args.path === 'string' && args.path.length > 0
				? args.path
				: undefined;
		const format = args.format as Format;
		const target = resolveTarget(args);

		const { data: daemon, error: daemonErr } = await getDaemon(target);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}
		const result = await daemon.list({ workspace: target.userWorkspace });
		if (result.error) {
			fail(result.error.message);
			return;
		}

		if (path === undefined) {
			renderAll(result.data, format);
			return;
		}
		renderAtPath(result.data, path, format);
	},
};

function renderAll(entries: ActionManifest, format: Format): void {
	if (format) {
		const rows = Object.entries(entries).map(([p, meta]) =>
			toActionDescriptor(meta, p),
		);
		output(rows, { format });
		return;
	}
	if (Object.keys(entries).length === 0) {
		console.log('(no actions exposed)');
		return;
	}
	printTree(entries, '');
}

function renderAtPath(
	entries: ActionManifest,
	path: string,
	format: Format,
): void {
	const exact = entries[path];
	if (exact !== undefined) {
		if (format) {
			output(toActionDescriptor(exact, path), { format });
			return;
		}
		printActionDetail(path, exact);
		return;
	}

	const subset = filterChildren(entries, path);
	if (Object.keys(subset).length === 0) {
		fail(`"${path}" is not defined.`);
		return;
	}

	if (format) {
		const rows = Object.entries(subset).map(([p, meta]) =>
			toActionDescriptor(meta, p),
		);
		output(rows, { format });
		return;
	}
	printTree(subset, path);
}

/**
 * Children of `path` in the manifest. The exact match at `path` is handled
 * separately by the caller; this returns proper descendants only.
 */
export function filterChildren(
	entries: ActionManifest,
	path: string,
): ActionManifest {
	const pfx = path + '.';
	const out: ActionManifest = {};
	for (const [p, meta] of Object.entries(entries)) {
		if (p.startsWith(pfx)) out[p] = meta;
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
			? `${child.name}  ${pc.cyan(`(${child.action.type})`)}${
					child.action.description ? pc.dim(`  ${child.action.description}`) : ''
				}`
			: pc.bold(child.name);
		console.log(`${pc.dim(prefix + branch)}${label}`);
		if (child.children.size > 0) {
			printChildren(child, prefix + (isLast ? '    ' : '│   '));
		}
	});
}

function printActionDetail(
	path: string,
	action: ActionManifest[string],
): void {
	console.log(`${pc.bold(path)}  ${pc.cyan(`(${action.type})`)}`);
	if (action.description) {
		console.log('');
		console.log(`  ${action.description}`);
	}
	if (action.input) {
		console.log('');
		console.log(pc.dim('  Input fields (pass as JSON):'));
		for (const line of describeInput(action.input)) console.log(`    ${line}`);
	}
}

function describeInput(schema: TSchema): string[] {
	if (!Type.IsObject(schema)) return [pc.dim('(non-object input schema)')];
	const required = new Set(schema.required ?? []);
	const lines: string[] = [];
	for (const [key, field] of Object.entries(schema.properties)) {
		const f = field as TSchema & { type?: string; description?: string };
		const typeLabel = f.type ?? 'value';
		const reqLabel = required.has(key) ? pc.yellow('required') : pc.dim('optional');
		const desc = f.description ? pc.dim(`  ${f.description}`) : '';
		lines.push(`${key}: ${pc.cyan(typeLabel)}  (${reqLabel})${desc}`);
	}
	return lines;
}
