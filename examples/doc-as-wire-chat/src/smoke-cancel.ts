/**
 * Durable-cancel check (S3): write a turn, wait until the answer starts
 * streaming, write `cancelRequestedAt`, and assert the actor stops mid-stream and
 * writes a `cancelled` finish. Run with the echo stream (no GEMINI_API_KEY) so
 * the answer is slow enough to catch mid-flight.
 *
 * Run: `bun run src/smoke-cancel.ts`  (after the relay and actor are up).
 */

import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { openConversation } from './chat-peer';
import { connectPeer } from './transport';

const WORKSPACE = process.env.ROOM ?? 'epicenter-demo';
const PORT = process.env.PORT ?? 8787;
const AGENT = process.env.AGENT ?? 'demo-actor';

const rootDoc = new Y.Doc({ gc: true });
connectPeer({ url: `ws://localhost:${PORT}/${WORKSPACE}`, doc: rootDoc });

const { transcript } = openConversation({
	rootDoc,
	workspace: WORKSPACE,
	port: PORT,
	id: `cancel-${nanoid(6)}`,
	agent: AGENT,
});

const generationId = nanoid();
let requested = false;
const { promise, resolve } = Promise.withResolvers<string>();

transcript.observe(() => {
	const answer = transcript
		.read()
		.find((m) => m.role === 'assistant' && m.id === generationId);
	if (!answer) return;
	// Once a few characters have streamed, request cancel exactly once.
	if (!requested && answer.text.length > 5 && !answer.finish) {
		requested = true;
		transcript.requestCancel(Date.now());
	}
	if (answer.finish) resolve(answer.finish.kind);
});

setTimeout(() => {
	transcript.appendUser({
		id: nanoid(),
		content: 'stream something long so i can cancel it',
		createdAt: Date.now(),
		generationId,
	});
}, 400);

const kind = await Promise.race([
	promise,
	new Promise<string>((_, reject) =>
		setTimeout(
			() => reject(new Error('timeout: no finish within 12s')),
			12_000,
		),
	),
]);

if (kind !== 'cancelled') {
	console.error(
		`SMOKE-CANCEL FAIL · expected finish "cancelled", got "${kind}"`,
	);
	process.exit(1);
}
console.log(
	'SMOKE-CANCEL OK · actor stopped mid-stream and wrote finish: cancelled',
);
process.exit(0);
