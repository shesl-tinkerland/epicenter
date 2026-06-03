import type { OwnerId } from '@epicenter/identity';
import { ROOM_ROUTE } from '@epicenter/sync';
import * as Y from 'yjs';
import type { AuthedFetch } from '../shared/types.js';

/**
 * Bound for a one-shot room HTTP request. A hung relay must not stall the caller
 * forever (the materializer reads a body inline while rendering a `.md`, so an
 * unbounded GET would wedge the whole flush).
 */
const ROOM_HTTP_TIMEOUT_MS = 10_000;

/** Address of a hosted room over HTTP, plus the auth'd fetch to reach it. */
type RoomHttpTarget = {
	fetch: AuthedFetch;
	baseURL: string;
	ownerId: OwnerId;
	guid: string;
};

/**
 * GET the room's current doc into a throwaway `Y.Doc` seeded with that state.
 * Backs `readRoomOverHttp`: the relay serves the full snapshot on GET (a
 * non-upgrade GET of the room route), so this is the one place that fetch and
 * decode lives. Throws on a non-2xx or a timeout; the caller owns destroying the
 * returned doc.
 */
async function getRoomDoc({
	fetch,
	baseURL,
	ownerId,
	guid,
}: RoomHttpTarget): Promise<Y.Doc> {
	const url = ROOM_ROUTE.url(baseURL, ownerId, guid);
	const snapshotResponse = await fetch(url, {
		signal: AbortSignal.timeout(ROOM_HTTP_TIMEOUT_MS),
	});
	if (!snapshotResponse.ok) {
		throw new Error(
			`room snapshot GET failed for "${guid}": ${snapshotResponse.status}`,
		);
	}
	const snapshot = new Uint8Array(await snapshotResponse.arrayBuffer());
	const ydoc = new Y.Doc({ guid, gc: true });
	if (snapshot.byteLength > 0) Y.applyUpdateV2(ydoc, snapshot);
	return ydoc;
}

/**
 * Read a hosted room over one-shot HTTP: GET the current doc, hand a throwaway
 * `Y.Doc` seeded with that state to `read`, return its result, then destroy the
 * doc. The GET is an atomic snapshot, so it avoids the "connected but not yet
 * synced" ambiguity a live `openCollaboration` read carries, with no socket to
 * tear down. Use this for a one-shot read of a relay-only doc; use
 * `openCollaboration` for a live editing session.
 */
export async function readRoomOverHttp<T>({
	fetch,
	baseURL,
	ownerId,
	guid,
	read,
}: RoomHttpTarget & { read: (ydoc: Y.Doc) => T }): Promise<T> {
	const ydoc = await getRoomDoc({ fetch, baseURL, ownerId, guid });
	try {
		return read(ydoc);
	} finally {
		ydoc.destroy();
	}
}
