/**
 * Length-prefix framing for byte-oriented unix-socket transports.
 *
 * Wire format: `u32 LE length` followed by `length` bytes of payload. The
 * unix socket gives a SOCK_STREAM byte stream; Yjs sync frames need clean
 * message boundaries. This is the smallest universal answer.
 *
 * Shared by `attachIpcSyncServer` (daemon side) and `attachIpcSyncClient`
 * (peer side) so both sides agree on framing without coupling either to
 * the socket library.
 */

/** Bytes consumed by a single frame's length prefix. */
export const FRAME_HEADER_BYTES = 4;

/**
 * Wrap `payload` in a length-prefixed frame. The returned buffer is owned
 * by the caller; callers may pass it directly to a write API.
 */
export function encodeFrame(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
	new DataView(out.buffer, out.byteOffset, FRAME_HEADER_BYTES).setUint32(
		0,
		payload.byteLength,
		true,
	);
	out.set(payload, FRAME_HEADER_BYTES);
	return out;
}

/**
 * Streaming frame reader. Push raw byte chunks via `push`; complete frames
 * are emitted to `onFrame`. Partial frames buffer until enough bytes arrive.
 */
export function createFrameReader(onFrame: (frame: Uint8Array) => void): {
	push: (chunk: Uint8Array) => void;
	reset: () => void;
} {
	let buffer = new Uint8Array(0);

	function push(chunk: Uint8Array) {
		const next = new Uint8Array(buffer.byteLength + chunk.byteLength);
		next.set(buffer, 0);
		next.set(chunk, buffer.byteLength);
		buffer = next;

		while (buffer.byteLength >= FRAME_HEADER_BYTES) {
			const length = new DataView(
				buffer.buffer,
				buffer.byteOffset,
				FRAME_HEADER_BYTES,
			).getUint32(0, true);
			const total = FRAME_HEADER_BYTES + length;
			if (buffer.byteLength < total) break;
			const frame = buffer.slice(FRAME_HEADER_BYTES, total);
			buffer = buffer.slice(total);
			onFrame(frame);
		}
	}

	function reset() {
		buffer = new Uint8Array(0);
	}

	return { push, reset };
}
