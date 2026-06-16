/**
 * Live-node dispatch over the relay.
 *
 * `runInboundDispatch()` is the recipient-side handler. The supervisor
 * routes text frames here; we look up `action` in the local registry,
 * invoke it, and emit the `dispatch_response` back over the same socket.
 *
 * Liveness is consumed via the server-owned presence channel (see
 * `presence-protocol.ts` and `Collaboration.peers`). This module no
 * longer carries a liveness reader: the relay's `connections` map is the
 * source of truth, and clients learn its contents from the relay's
 * `presence` full-list text frame.
 *
 * Identity and routing in one sentence: the relay maps `nodeId` to
 * "most-recently-connected open socket"; multi-tab same-node is
 * handled by positional newest-wins lookup at delivery time.
 *
 * @module
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type ActionRegistry, invokeAction } from '../shared/actions.js';
import {
	checkDispatchErrorWire,
	checkDispatchInboundFrame,
	type DispatchErrorWire,
	type DispatchResponseFrame,
} from './dispatch-protocol.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Per-call options. Required: `to`, `action`. Optional: `input` (omit
 * for no-argument actions; `JSON.stringify` drops `undefined` keys, so
 * the recipient sees no `input` field on the wire), and `signal` for
 * the dispatch deadline. With no signal, the dispatch settles at the
 * caller-side response ceiling (~90s) if the relay never answers.
 */
export type DispatchRequest = {
	to: string;
	action: string;
	input?: unknown;
	signal?: AbortSignal;
};

/**
 * Fields of one wire-error variant, minus the `name` discriminant.
 *
 * The bridge between the wire contract and the local `defineErrors`
 * factory: `DispatchError`'s wire-crossing constructors take this instead
 * of re-declaring `{ action; cause }` by hand, so a field added to
 * `DispatchErrorWire` flows into the factory param automatically.
 */
type WireErrorFields<N extends DispatchErrorWire['name']> = Omit<
	Extract<DispatchErrorWire, { name: N }>,
	'name'
>;

/**
 * Caller-side dispatch error union. Five variants:
 *
 *   - `RecipientOffline`: relay confirmed no live socket for `to` (or
 *     the recipient's socket closed mid-handler).
 *   - `ActionNotFound`: recipient has no handler for `action`.
 *   - `ActionFailed`: recipient handler threw or returned `Err`. `cause`
 *     is a serialized string (JSON cannot round-trip Error instances).
 *   - `Cancelled`: the caller's `AbortSignal` aborted before the
 *     dispatch result arrived.
 *   - `NetworkFailed`: the socket dispatch did not complete because the
 *     connection was unavailable, dropped, or returned a malformed result.
 *
 * `RecipientOffline`, `ActionNotFound`, `ActionFailed` arrive in
 * `dispatch_result` frames. `Cancelled` and `NetworkFailed` are produced
 * locally by the caller-side collaboration primitive.
 *
 * The three wire-crossing variants derive their constructor params from
 * `DispatchErrorWire` via {@link WireErrorFields}: the wire contract in
 * `dispatch-protocol.ts` is the single source for their field shapes.
 * `Cancelled` and `NetworkFailed` never cross the wire, so they have no
 * wire source and are hand-typed.
 */
export const DispatchError = defineErrors({
	RecipientOffline: (wire: WireErrorFields<'RecipientOffline'>) => ({
		message: `Recipient "${wire.to}" is offline`,
		...wire,
	}),
	ActionNotFound: (wire: WireErrorFields<'ActionNotFound'>) => ({
		message: `Target has no handler for "${wire.action}"`,
		...wire,
	}),
	ActionFailed: (wire: WireErrorFields<'ActionFailed'>) => ({
		message: `Action "${wire.action}" failed`,
		...wire,
	}),
	Cancelled: ({ reason }: { reason: unknown }) => ({
		message: 'Dispatch was cancelled',
		reason,
	}),
	NetworkFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Dispatch did not complete over the relay socket',
		cause,
	}),
});
export type DispatchError = InferErrors<typeof DispatchError>;

// ════════════════════════════════════════════════════════════════════════════
// CALLER-SIDE DISPATCH
// ════════════════════════════════════════════════════════════════════════════

/**
 * Interpret a relay `dispatch_result.result` payload.
 *
 * The relay forwards recipient replies opaquely and can also produce its
 * own `RecipientOffline` result. This function owns the untrusted boundary:
 * it accepts only wellcrafted `Result` objects and known wire errors.
 */
export function interpretDispatchResult(
	body: unknown,
): Result<unknown, DispatchError> {
	// The dispatch body is a wellcrafted `Result`: `{ data, error }` with
	// one side null. Both the recipient (`Ok`/`Err`) and the relay
	// (`RecipientOffline` via `Err`) produce this shape; anything else is a
	// protocol fault.
	if (
		!body ||
		typeof body !== 'object' ||
		!('data' in body) ||
		!('error' in body)
	) {
		return DispatchError.NetworkFailed({
			cause: { reason: 'dispatch result was not a Result envelope', body },
		});
	}

	// Discriminate on the error side only: a successful action may return
	// `null`, so `data` cannot distinguish success from failure. `body` is
	// already narrowed to `{ data: unknown; error: unknown }` by the guard
	// above, so this destructure needs no cast.
	const { data, error } = body;
	if (error === null) return Ok(data);

	// Validate the untrusted error against the TypeBox-compiled wire schema.
	// On match, hand the narrowed variant straight to its local factory: each
	// factory reads only its own fields and ignores the extra `name`.
	if (!checkDispatchErrorWire.Check(error)) {
		return DispatchError.NetworkFailed({
			cause: { reason: 'unrecognized dispatch error wire variant', error },
		});
	}
	switch (error.name) {
		case 'RecipientOffline':
			return DispatchError.RecipientOffline(error);
		case 'ActionNotFound':
			return DispatchError.ActionNotFound(error);
		case 'ActionFailed':
			return DispatchError.ActionFailed(error);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// RECIPIENT-SIDE INBOUND DISPATCH HANDLER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Decode and run an inbound `dispatch_inbound` text frame. Returns the
 * serialized `dispatch_response` to send back over the same socket, or
 * `null` if the frame is malformed or not a `dispatch_inbound` (e.g.
 * the server pushed something we don't recognize; we ignore it rather
 * than tear down the socket from this side).
 */
export async function runInboundDispatch({
	rawFrame,
	actions,
}: {
	rawFrame: string;
	actions: ActionRegistry;
}): Promise<string | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawFrame);
	} catch {
		return null;
	}

	if (!checkDispatchInboundFrame.Check(parsed)) return null;

	const { id, action, input } = parsed;

	const handler = actions[action];
	if (!handler) {
		return JSON.stringify({
			type: 'dispatch_response',
			id,
			result: Err({ name: 'ActionNotFound', action }),
		} satisfies DispatchResponseFrame);
	}

	const result = await invokeAction(handler, input);
	if (result.error !== null) {
		return JSON.stringify({
			type: 'dispatch_response',
			id,
			result: Err({
				name: 'ActionFailed',
				action,
				cause: extractCauseString(result.error),
			}),
		} satisfies DispatchResponseFrame);
	}

	return JSON.stringify({
		type: 'dispatch_response',
		id,
		result: Ok(result.data),
	} satisfies DispatchResponseFrame);
}

/**
 * Serialize an arbitrary thrown value into a safe string for the
 * `dispatch_response.result.error.cause` wire field. JSON cannot
 * round-trip `Error` instances, DOMException chains, or circular
 * references, so we collapse to a string the recipient can show or
 * log without surprises.
 */
function extractCauseString(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
}
