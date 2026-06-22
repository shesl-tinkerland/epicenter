/**
 * The {@link ToolCatalog} the client agent loop runs against in an app
 * (ADR-0047): tools are dispatched actions, and the live catalog is the union of
 * every peer's presence-broadcast action manifest plus any actions the client
 * owns in-process.
 *
 * A tool call resolves one of two ways: a local action runs in-process through
 * `invokeAction` with no relay, and a remote action dispatches to the peer that
 * advertises it and awaits its `Result`. This is the fast tier (an inline
 * result). The async-job tier (a dispatched action that acks and writes its
 * results into a synced doc over time) lands with its first consumer in Wave 4;
 * it is an additive resolve path, not a change to this catalog's shape.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import type { Result } from 'wellcrafted/result';
import type { DispatchError, DispatchRequest } from '../document/dispatch.js';
import type { Peer } from '../document/presence-protocol.js';
import {
	type Action,
	type ActionMeta,
	type ActionRegistry,
	invokeAction,
} from '../shared/actions.js';
import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

/**
 * The slice of a `Collaboration` the catalog needs: the live peer list and the
 * caller-side dispatch primitive. Narrowed to a structural type so the catalog
 * is testable without a socket.
 */
export type DispatchSurface = {
	peers: { list(): Peer[] };
	dispatch(request: DispatchRequest): Promise<Result<unknown, DispatchError>>;
};

export type DispatchToolCatalogOptions = {
	/** Actions the client owns; resolved in-process, never over the relay. */
	localActions?: ActionRegistry;
	/** The caller's own node id, skipped when scanning presence for tools. */
	selfNodeId?: string;
};

/**
 * Build the live tool catalog from a collaboration surface. `definitions` is
 * re-read on every call so it always reflects current presence; a local action
 * shadows a remote one of the same name.
 */
export function createDispatchToolCatalog(
	surface: DispatchSurface,
	options: DispatchToolCatalogOptions = {},
): ToolCatalog {
	const { localActions = {}, selfNodeId } = options;

	function definitions(): AgentToolDefinition[] {
		const byName = new Map<string, AgentToolDefinition>();
		for (const [name, action] of Object.entries(localActions)) {
			byName.set(name, toToolDefinition(name, action));
		}
		for (const peer of surface.peers.list()) {
			if (peer.nodeId === selfNodeId) continue;
			for (const [name, meta] of Object.entries(peer.actions)) {
				if (!byName.has(name)) byName.set(name, toToolDefinition(name, meta));
			}
		}
		return [...byName.values()];
	}

	async function resolve(
		call: AgentToolCall,
		signal: AbortSignal,
	): Promise<AgentToolOutcome> {
		const local = localActions[call.toolName];
		if (local) {
			const { data, error } = await invokeAction(local, call.input);
			if (error !== null) {
				return { output: extractErrorMessage(error), isError: true };
			}
			return { output: (data ?? null) as JsonValue, isError: false };
		}

		const peer = surface.peers
			.list()
			.find((p) => p.nodeId !== selfNodeId && call.toolName in p.actions);
		if (!peer) {
			return {
				output: `No peer offers the tool "${call.toolName}".`,
				isError: true,
			};
		}

		const { data, error } = await surface.dispatch({
			to: peer.nodeId,
			action: call.toolName,
			input: call.input,
			signal,
		});
		if (error !== null) return { output: error.message, isError: true };
		return { output: (data ?? null) as JsonValue, isError: false };
	}

	return { definitions, resolve };
}

/** Project an action's metadata (local {@link Action} or wire {@link ActionMeta}) to a tool. */
function toToolDefinition(
	name: string,
	meta: Action | ActionMeta,
): AgentToolDefinition {
	return {
		name,
		kind: meta.type,
		...(meta.title !== undefined && { title: meta.title }),
		...(meta.description !== undefined && { description: meta.description }),
		...(meta.input !== undefined && { inputSchema: meta.input as JsonValue }),
	};
}
