/**
 * No-op WebSocket for `attachSync` tests.
 *
 * Pass this as `webSocketImpl` to `attachSync` (or to a per-app factory
 * that threads it through) to keep the supervisor parked on connect
 * without dialing real servers. The stub never opens, never errors,
 * never delivers messages; `ydoc.destroy()` triggers a clean teardown
 * via `close()`.
 *
 * Structurally compatible with the WHATWG WebSocket interface that
 * `attachSync` consumes (constructor signature, `readyState`, `onopen`/
 * `onclose`/`onerror`/`onmessage`, `send`, `close`).
 *
 * Intended for tests only. Production code uses `globalThis.WebSocket`
 * (the runtime's native or polyfilled implementation).
 */

export class NoopWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = NoopWebSocket.CONNECTING;
	binaryType: 'arraybuffer' | 'blob' = 'blob';
	onopen: (() => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;

	constructor(
		public readonly url: string,
		_protocols?: string | string[],
	) {}

	send() {}
	close() {
		if (this.readyState === NoopWebSocket.CLOSED) return;
		this.readyState = NoopWebSocket.CLOSED;
		this.onclose?.({ code: 1005, reason: '' });
	}
	addEventListener() {}
	removeEventListener() {}
}
