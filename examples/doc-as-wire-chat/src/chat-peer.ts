/**
 * Open one conversation as a peer: ensure its row exists in the root doc, then
 * connect its transcript child doc at the derived address. Shared by the client
 * and the smoke checks so they bind and open a conversation the same way.
 */

import { attachChatTranscript } from '@epicenter/workspace/ai';
import * as Y from 'yjs';
import { ensureConversation, transcriptGuid } from './conversations';
import { connectPeer } from './transport';

export function openConversation({
	rootDoc,
	workspace,
	port,
	id,
	agent,
}: {
	rootDoc: Y.Doc;
	workspace: string;
	port: string | number;
	id: string;
	agent: string;
}) {
	ensureConversation(rootDoc, { id, agent });
	const transcriptDoc = new Y.Doc({ gc: true });
	const transcript = attachChatTranscript(transcriptDoc);
	connectPeer({
		url: `ws://localhost:${port}/${transcriptGuid(workspace, id)}`,
		doc: transcriptDoc,
	});
	return { transcript, transcriptDoc };
}
