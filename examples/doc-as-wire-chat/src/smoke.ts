/**
 * End-to-end check: bind a conversation to the actor's agent, write a turn, wait
 * for the streamed `finish` to sync back. Proves observe -> stream -> finish over
 * the real observe loop and a real WebSocket. Exits 0 on success.
 *
 * Run: `bun run src/smoke.ts`  (after the relay and actor are up).
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
	id: `smoke-${nanoid(6)}`,
	agent: AGENT,
});

const generationId = nanoid();
const { promise, resolve } = Promise.withResolvers<string>();
transcript.observe(() => {
	const answer = transcript
		.read()
		.find((m) => m.role === 'assistant' && m.id === generationId);
	if (answer?.finish?.kind === 'completed') resolve(answer.text);
});

setTimeout(() => {
	transcript.appendUser({
		id: nanoid(),
		content: 'hello over a synced doc',
		createdAt: Date.now(),
		generationId,
	});
}, 400);

const answer = await Promise.race([
	promise,
	new Promise<string>((_, reject) =>
		setTimeout(
			() => reject(new Error('timeout: no completed finish within 12s')),
			12_000,
		),
	),
]);

console.log('SMOKE OK · streamed answer:', JSON.stringify(answer));
process.exit(0);
