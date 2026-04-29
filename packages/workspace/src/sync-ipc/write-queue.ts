/**
 * Backpressure-aware write queue for Bun unix sockets.
 *
 * `socket.write(bytes)` on a Bun unix socket can return less than the input
 * length (often 0 or a partial slice ~7 KB) when the kernel buffer fills.
 * Without queueing, those unwritten bytes are silently dropped, which mangles
 * the framed wire protocol on either side. This module owns the simple state
 * machine: queue pending chunks, attempt a flush after each enqueue, and
 * resume on the socket's `drain` event.
 *
 * Returned shape:
 *   - `enqueue(bytes)`: append and attempt to flush.
 *   - `flush()`: drain the head of the queue while the socket accepts bytes.
 *     Returns `true` when the queue is empty.
 *   - `pending`: byte count still buffered locally.
 *
 * Caller wires:
 *   - the socket-options object's `drain(socket)` handler must call `flush()`.
 *   - on close, `flush()` once more is best-effort; remaining pending bytes
 *     are lost when the kernel half-closes the socket.
 */

type BunWritableSocket = {
	write(data: Uint8Array): number | void;
};

export type WriteQueue = {
	enqueue(bytes: Uint8Array): void;
	flush(): boolean;
	readonly pending: number;
};

export function createWriteQueue(
	getSocket: () => BunWritableSocket | null,
): WriteQueue {
	const queue: Uint8Array[] = [];
	let pending = 0;

	function flush(): boolean {
		const socket = getSocket();
		if (!socket) return false;
		while (queue.length > 0) {
			const head = queue[0]!;
			const ret = socket.write(head);
			const n = typeof ret === 'number' ? ret : head.byteLength;
			if (n >= head.byteLength) {
				queue.shift();
				pending -= head.byteLength;
				continue;
			}
			if (n > 0) {
				queue[0] = head.subarray(n);
				pending -= n;
			}
			return false;
		}
		return true;
	}

	return {
		enqueue(bytes) {
			if (bytes.byteLength === 0) return;
			queue.push(bytes);
			pending += bytes.byteLength;
			flush();
		},
		flush,
		get pending() {
			return pending;
		},
	};
}
