/**
 * The thin CLIENT (ADR-0024/0025): bind a conversation to an agent, then chat by
 * WRITING turns into its transcript child doc and OBSERVING the answer stream in.
 *
 * - Default `AGENT=demo-agent` binds to the running worker, so it answers.
 * - `AGENT=other bun run client` binds to an agent nobody runs, so it is ignored
 *   (S4: the binding decides who answers, not the topology).
 * - Type `/cancel` mid-stream to stop a reply durably (S3).
 *
 * Run: `bun run src/client.ts`  (after the relay and worker are up).
 */

import * as readline from 'node:readline';
import { attachChatTranscript } from '@epicenter/workspace/ai';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { ensureConversation, transcriptGuid } from './conversations';
import { connectPeer } from './transport';

const WORKSPACE = process.env.ROOM ?? 'epicenter-demo';
const PORT = process.env.PORT ?? 8787;
const AGENT = process.env.AGENT ?? 'demo-agent';
const CONV = process.env.CONV ?? 'demo';
const wsUrl = (guid: string) => `ws://localhost:${PORT}/${guid}`;

// Root doc (conversations table) and the transcript child doc for this conversation.
const rootDoc = new Y.Doc({ gc: true });
connectPeer({ url: wsUrl(WORKSPACE), doc: rootDoc });

const transcriptDoc = new Y.Doc({ gc: true });
const transcript = attachChatTranscript(transcriptDoc);
connectPeer({
	url: wsUrl(transcriptGuid(WORKSPACE, CONV)),
	doc: transcriptDoc,
});

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: '> ',
});

// Append-only renderer: new user turns, then stream the latest assistant message.
let seenUsers = 0;
let activeAssistant: string | null = null;
let rendered = 0;
const finished = new Set<string>();

transcript.observe(() => {
	const messages = transcript.read();

	const users = messages.filter((message) => message.role === 'user');
	if (users.length > seenUsers) {
		for (const user of users.slice(seenUsers)) {
			process.stdout.write(`\nyou: ${user.text}\n`);
		}
		seenUsers = users.length;
	}

	const assistant = messages.filter((m) => m.role === 'assistant').at(-1);
	if (!assistant) return;
	if (assistant.id !== activeAssistant) {
		activeAssistant = assistant.id;
		rendered = 0;
		process.stdout.write('assistant: ');
	}
	if (assistant.text.length > rendered) {
		process.stdout.write(assistant.text.slice(rendered));
		rendered = assistant.text.length;
	}
	if (assistant.finish && !finished.has(assistant.id)) {
		finished.add(assistant.id);
		const { finish } = assistant;
		// One terminal note, kept to a single REPL line. `failed` collapses any
		// newlines in the provider message so it can't push the prompt mid-text;
		// the message is already length-capped where the worker writes it.
		const note =
			finish.kind === 'cancelled'
				? ' [cancelled]'
				: finish.kind === 'failed'
					? ` [failed: ${finish.code}] ${finish.message.replace(/\s+/g, ' ')}`
					: '';
		process.stdout.write(`${note}\n`);
		rl.prompt();
	}
});

rl.on('line', (line) => {
	const content = line.trim();
	if (!content) {
		rl.prompt();
		return;
	}
	if (content === '/cancel') {
		// Durable cancel: a client-owned field the worker reads back mid-answer.
		const at = transcript.requestCancel(Date.now());
		if (at === undefined) {
			process.stdout.write('(nothing to cancel)\n');
			rl.prompt();
		}
		return;
	}
	// Writing the turn IS the request. No HTTP call anywhere.
	transcript.appendUser({
		id: nanoid(),
		content,
		createdAt: Date.now(),
		generationId: nanoid(),
	});
});

// Bind the conversation once the root sync has had a beat to settle.
setTimeout(() => {
	ensureConversation(rootDoc, { id: CONV, agent: AGENT });
	console.log(
		`conversation "${CONV}" bound to agent "${AGENT}" — type a message; /cancel to stop a reply; Ctrl-C to quit`,
	);
	rl.prompt();
}, 300);
