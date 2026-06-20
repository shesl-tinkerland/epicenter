/**
 * The browser trigger wrapper: an in-process answerer for a conversation a
 * browser tab answers itself (ADR-0033's `in-process` trigger).
 *
 * A conversation is answered by an in-process peer (ADR-0033): an always-on
 * daemon answers ambiently via {@link attachChatWorker}; an open browser tab
 * answers here. The inference backend is a {@link ChatStream} (a local model,
 * the user's BYOK key, or the Epicenter provider that calls the metered
 * `/api/ai/chat` for house-key cloud inference). The answer never travels over
 * HTTP: only the inference call, if any, leaves; the tab writes parts into the
 * same conversation doc through the same writer, and the client always renders
 * the doc.
 *
 * This is deliberately the *same* answerer as the daemon: it builds an
 * {@link attachChatWorker} over the local transcript doc and wires its
 * `onChange` to the doc's own observer, exactly as the daemon mount's child-doc
 * runtime does (`attachChildDocWorker` calls `handle.observe(() =>
 * worker.onChange())`). So the claim is the identical existence-based claim
 * (`findUnansweredTurn`): a browser answerer and a future daemon on the same
 * conversation reconcile the same predicate and never double-answer one turn
 * (the message keyed to the turn's `generationId` is the claim, whoever appends
 * it first). The caller decides when to attach this: the app skips it for a
 * conversation bound to a resident daemon (which answers over sync) and runs it
 * for every conversation the tab itself answers, the cloud agent included.
 *
 * The lifecycle matches the daemon too. On the user's durable cancel
 * (`requestCancel` writes `cancelRequestedAt`) the worker aborts the stream and
 * writes `cancelled`. On teardown (the tab navigates away or the handle is
 * disposed mid-answer) it aborts and writes no finish, leaving an interrupted
 * artifact the user can retry, exactly as an evicted daemon would. That is the
 * correct browser behavior: a closed tab is an interrupted answer, not a
 * cancellation.
 *
 * @module
 */

import type * as Y from 'yjs';
import type { ChatStream } from './chat-answer.js';
import { observeChatDocMessages } from './chat-doc.js';
import { attachChatWorker } from './chat-worker.js';

/**
 * Run an in-process answerer over a local conversation doc and return a stop
 * function. Pass the transcript body `Y.Doc` and the inference backend as a
 * {@link ChatStream} (a local model, the user's BYOK provider, or the Epicenter
 * provider that calls the metered inference endpoint).
 *
 * Wiring mirrors the daemon mount: observe the transcript, fire the worker's
 * `onChange` per transaction, and fire it once now so a turn already pending at
 * attach time (synced from another device, or this tab reopened mid-conversation)
 * is reconciled immediately. The returned stop function unobserves and disposes
 * the worker (aborting any in-flight stream without writing a finish).
 */
export function attachChatBrowserAnswerer({
	doc,
	startStream,
}: {
	doc: Y.Doc;
	startStream: ChatStream;
}): () => void {
	const worker = attachChatWorker({ ydoc: doc, startStream });
	const unobserve = observeChatDocMessages(doc, () => worker.onChange?.());
	// Claim a turn already pending when the answerer attaches.
	worker.onChange?.();
	return () => {
		unobserve();
		worker[Symbol.dispose]?.();
	};
}
