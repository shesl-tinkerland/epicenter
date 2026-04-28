/**
 * Daemon-side dispatch for the `/run` route. The Hono handler in `app.ts`
 * resolves the workspace entry and forwards to `executeRun` here.
 *
 * `epicenter run` is a shell shortcut for one workspace primitive:
 *
 *   ctx.peerTarget === undefined   ->  invokeAction(...)
 *   ctx.peerTarget === <deviceId>  ->  sync.rpc(clientID, path, input)
 *
 * Power-user automation (loops, fan-out across peers, conditional dispatch)
 * lives in vault-style TypeScript scripts that load the workspace library
 * directly. The CLI deliberately does not grow flags that shadow scripting.
 *
 * `executeRun` returns a domain `RunResponse` that the route serializes
 * verbatim. Unexpected exceptions bubble out to the route's blanket
 * try/catch and surface as `HandlerCrashed` on the client side.
 */

import {
	type Action,
	invokeAction,
	resolveActionPath,
	walkActions,
} from '@epicenter/workspace';
import { Ok } from 'wellcrafted/result';

import { RunError, type RunResponse } from '../commands/run.js';
import type { WorkspaceEntry } from '../load-config.js';
import { explainEmpty, waitForPeer } from '../util/peer-wait.js';
import type { RunInput } from './app.js';

export async function executeRun(
	entry: WorkspaceEntry,
	ctx: RunInput,
): Promise<RunResponse> {
	const { workspace } = entry;
	if (workspace.whenReady) await workspace.whenReady;

	const action = resolveActionPath(workspace.actions ?? {}, ctx.actionPath);
	if (!action) {
		const entries = [...walkActions(workspace.actions ?? {})];
		const descendants = entriesUnder(entries, ctx.actionPath);
		if (descendants.length > 0) {
			return RunError.UsageError({
				message: `"${ctx.actionPath}" is not a runnable action.`,
				suggestions: descendants.map(([p, a]) => `  ${p}  (${a.type})`),
			});
		}
		return RunError.UsageError({
			message: `"${ctx.actionPath}" is not defined.`,
			suggestions: nearestSiblingLines(entries, ctx.actionPath),
		});
	}

	if (ctx.peerTarget !== undefined) {
		return invokeRemote(entry, ctx);
	}

	const result = await invokeAction(action, ctx.input, ctx.actionPath);
	if (result.error !== null) {
		return RunError.RuntimeError({ cause: result.error });
	}
	return Ok(result.data);
}

async function invokeRemote(
	entry: WorkspaceEntry,
	ctx: RunInput,
): Promise<RunResponse> {
	const { workspace } = entry;
	const sync = workspace.sync;

	if (!sync?.rpc) {
		return RunError.UsageError({
			message: `Workspace "${entry.name}" has no sync attachment; --peer requires sync.`,
		});
	}

	const deadline = Date.now() + ctx.waitMs;
	const { hit, sawPeers } = await waitForPeer(
		workspace,
		ctx.peerTarget!,
		deadline,
	);
	if (!hit) {
		return RunError.PeerMiss({
			peerTarget: ctx.peerTarget!,
			sawPeers,
			workspace: ctx.workspace,
			waitMs: ctx.waitMs,
			emptyReason: explainEmpty(workspace),
		});
	}

	const { clientID: targetClientId, state: peerState } = hit;
	const remaining = Math.max(1, deadline - Date.now());
	const result = await sync.rpc(targetClientId, ctx.actionPath, ctx.input, {
		timeout: remaining,
	});

	if (result.error !== null) {
		return RunError.RpcError({
			cause: result.error,
			targetClientId,
			peerState,
		});
	}
	return Ok(result.data);
}

function entriesUnder(
	entries: Array<[string, Action]>,
	prefix: string,
): Array<[string, Action]> {
	if (!prefix) return entries;
	const pfx = prefix + '.';
	return entries.filter(([p]) => p === prefix || p.startsWith(pfx));
}

function nearestSiblingLines(
	entries: Array<[string, Action]>,
	missedPath: string,
): string[] {
	const parts = missedPath.split('.');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('.');
		const alts = entriesUnder(entries, prefix);
		if (alts.length === 0) continue;
		return alts.map(([p, a]) => `  ${p}  (${a.type})`);
	}
	return [];
}
