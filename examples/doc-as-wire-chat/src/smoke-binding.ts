/**
 * Agent-binding check (S4): a conversation bound to an agent nobody runs is
 * ignored; one bound to the actor's agent is answered. Proves the row's `agent`
 * decides who answers, by construction (the observe loop hosts only its own
 * conversations), not the topology.
 *
 * Run: `bun run src/smoke-binding.ts`  (after the relay and an actor answering
 * as `demo-actor` are up).
 */

import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { openConversation } from './chat-peer';
import { connectPeer } from './transport';

const WORKSPACE = process.env.ROOM ?? 'epicenter-demo';
const PORT = process.env.PORT ?? 8787;
const SELF_AGENT = process.env.AGENT ?? 'demo-actor';

const rootDoc = new Y.Doc({ gc: true });
connectPeer({ url: `ws://localhost:${PORT}/${WORKSPACE}`, doc: rootDoc });

/** Append a turn to a freshly-bound conversation; resolve true if it gets a finish within `ms`. */
function askAndWaitForAnswer(agent: string, ms: number): Promise<boolean> {
	const { transcript } = openConversation({
		rootDoc,
		workspace: WORKSPACE,
		port: PORT,
		id: `bind-${agent}-${nanoid(6)}`,
		agent,
	});
	const generationId = nanoid();
	const { promise, resolve } = Promise.withResolvers<boolean>();
	transcript.observe(() => {
		const answer = transcript
			.read()
			.find((m) => m.role === 'assistant' && m.id === generationId);
		if (answer?.finish) resolve(true);
	});
	setTimeout(() => {
		transcript.appendUser({
			id: nanoid(),
			content: 'anyone home?',
			createdAt: Date.now(),
			generationId,
		});
	}, 400);
	return Promise.race([
		promise,
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);
}

// A conversation bound to an agent nobody runs must NOT be answered.
const ignored = await askAndWaitForAnswer('nobody-runs-this-agent', 3_000);
if (ignored) {
	console.error(
		'SMOKE-BINDING FAIL · a conversation bound to another agent was answered',
	);
	process.exit(1);
}
console.log(
	`✓ conversation bound to "nobody-runs-this-agent" was ignored (no answer in 3s)`,
);

// A conversation bound to the actor's agent MUST be answered.
const answered = await askAndWaitForAnswer(SELF_AGENT, 12_000);
if (!answered) {
	console.error(
		`SMOKE-BINDING FAIL · a conversation bound to "${SELF_AGENT}" was not answered`,
	);
	process.exit(1);
}
console.log(`✓ conversation bound to "${SELF_AGENT}" was answered`);

console.log("SMOKE-BINDING OK · the row's agent decides who answers");
process.exit(0);
