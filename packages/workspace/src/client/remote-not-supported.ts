/**
 * `RemoteNotSupported` is thrown by the remote workspace proxy
 * (`buildRemoteWorkspace`) for table operations and document handles that
 * cannot cross the unix-socket boundary: predicate-based `filter`, live
 * `observe` subscriptions, and `documents.X.Y.open` document handles.
 *
 * These operations require a live Y.Doc reference; the wire only ships
 * point-in-time JSON. Use the in-process workspace builder when you need
 * them.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const RemoteNotSupported = defineErrors({
	RemoteNotSupported: ({
		method,
		reason,
	}: {
		method: string;
		reason: string;
	}) => ({
		message: `${method} is not supported over the daemon's unix socket transport: ${reason}`,
		method,
		reason,
	}),
});

export type RemoteNotSupported = InferErrors<typeof RemoteNotSupported>;
