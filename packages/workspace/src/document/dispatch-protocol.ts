/**
 * Dispatch wire protocol: the text frames and result shape exchanged
 * between the relay (`packages/server/src/room/core.ts`) and dispatch
 * clients (`dispatch.ts`, `open-collaboration.ts`).
 *
 * Frame flow (all four are text frames on the one authenticated WebSocket;
 * `id` is minted by the caller and echoed unchanged by the relay):
 *
 *   caller    -> relay     : `dispatch_request`  (DispatchRequestFrame)
 *   relay     -> recipient : `dispatch_inbound`  (DispatchInboundFrame)
 *   recipient -> relay     : `dispatch_response` (DispatchResponseFrame)
 *   relay     -> caller    : `dispatch_result`   (DispatchResultFrame)
 *
 * Errors carry only their discriminant fields. The human-readable message
 * is not on the wire: the caller rebuilds each error through its local
 * `defineErrors` factory, which owns the message text.
 *
 * Schemas are TypeBox: they ARE valid JSON Schema at runtime, double as the
 * source of truth for the TypeScript types via `Static`, and feed
 * `typebox/compile`'s `Compile()` to produce checked-once validators reused
 * at every boundary. There is no hand-written duck-typing.
 */

import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { Result } from 'wellcrafted/result';

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Wire shape for a wellcrafted `Result<T, E>`: exactly one of `data` / `error`
 * is non-null. The two-arm union, validated structurally, is what the receiver
 * actually sees on the wire.
 */
function ResultSchema<T extends TSchema, E extends TSchema>(t: T, e: E) {
	return Type.Union([
		Type.Object({ data: t, error: Type.Null() }),
		Type.Object({ data: Type.Null(), error: e }),
	]);
}

// ════════════════════════════════════════════════════════════════════════════
// FRAME SCHEMAS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Caller -> relay: route this call to node `to`, correlated by `id`.
 *
 * `input` is optional on the wire because `JSON.stringify` drops `undefined`,
 * so no-input actions arrive without the field. The schema matches that
 * reality.
 */
export const DispatchRequestFrameSchema = Type.Object({
	type: Type.Literal('dispatch_request'),
	id: Type.String(),
	to: Type.String(),
	action: Type.String(),
	input: Type.Optional(Type.Unknown()),
});
export type DispatchRequestFrame = Static<typeof DispatchRequestFrameSchema>;

/** Relay -> recipient: run `action` with `input`; reply correlated by `id`. */
export const DispatchInboundFrameSchema = Type.Object({
	type: Type.Literal('dispatch_inbound'),
	id: Type.String(),
	action: Type.String(),
	input: Type.Optional(Type.Unknown()),
});
export type DispatchInboundFrame = Static<typeof DispatchInboundFrameSchema>;

/**
 * Errors a recipient itself produces. `RecipientOffline` is deliberately
 * absent: only the relay can know a recipient is unreachable.
 */
export const ActionResponseErrorSchema = Type.Union([
	Type.Object({
		name: Type.Literal('ActionNotFound'),
		action: Type.String(),
	}),
	Type.Object({
		name: Type.Literal('ActionFailed'),
		action: Type.String(),
		cause: Type.String(),
	}),
]);
export type ActionResponseError = Static<typeof ActionResponseErrorSchema>;

/** Recipient -> relay: the action outcome, correlated by `id`. */
export const DispatchResponseFrameSchema = Type.Object({
	type: Type.Literal('dispatch_response'),
	id: Type.String(),
	result: ResultSchema(Type.Unknown(), ActionResponseErrorSchema),
});
export type DispatchResponseFrame = {
	type: 'dispatch_response';
	id: string;
	result: Result<unknown, ActionResponseError>;
};

/**
 * Relay -> caller: the dispatch outcome, correlated by `id`.
 *
 * `result` is typed `Result<unknown, unknown>`: the relay forwards the
 * recipient's reply opaquely and never inspects the error side (it only
 * produces `RecipientOffline` itself). The caller validates the error
 * against {@link DispatchErrorWireSchema} via `checkDispatchErrorWire`.
 */
export const DispatchResultFrameSchema = Type.Object({
	type: Type.Literal('dispatch_result'),
	id: Type.String(),
	result: ResultSchema(Type.Unknown(), Type.Unknown()),
});
export type DispatchResultFrame = {
	type: 'dispatch_result';
	id: string;
	result: Result<unknown, unknown>;
};

/** Every error the dispatch wire can carry: recipient errors plus the relay's own. */
export const DispatchErrorWireSchema = Type.Union([
	Type.Object({ name: Type.Literal('RecipientOffline'), to: Type.String() }),
	Type.Object({ name: Type.Literal('ActionNotFound'), action: Type.String() }),
	Type.Object({
		name: Type.Literal('ActionFailed'),
		action: Type.String(),
		cause: Type.String(),
	}),
]);
export type DispatchErrorWire = Static<typeof DispatchErrorWireSchema>;

// ════════════════════════════════════════════════════════════════════════════
// COMPILED VALIDATORS
// ════════════════════════════════════════════════════════════════════════════

/** Caller-side: narrow an untrusted text frame to `DispatchResultFrame`. */
export const checkDispatchResultFrame = Compile(DispatchResultFrameSchema);

/** Recipient-side: narrow an untrusted text frame to `DispatchInboundFrame`. */
export const checkDispatchInboundFrame = Compile(DispatchInboundFrameSchema);

/** Relay-side: narrow caller-supplied dispatch requests. */
export const checkDispatchRequestFrame = Compile(DispatchRequestFrameSchema);

/** Relay-side: narrow recipient-supplied dispatch responses. */
export const checkDispatchResponseFrame = Compile(DispatchResponseFrameSchema);

/** Caller-side: narrow an untrusted error payload to `DispatchErrorWire`. */
export const checkDispatchErrorWire = Compile(DispatchErrorWireSchema);
