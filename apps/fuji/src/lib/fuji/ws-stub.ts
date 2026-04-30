/**
 * `globalThis.WebSocket` stub for factory tests.
 *
 * `attachSync` opens a real WebSocket against the production cloud URL on
 * construction. Tests swap `globalThis.WebSocket` for this no-op before
 * building a factory and restore it afterward. The stub never opens, never
 * errors, never delivers messages: the supervisor parks on the connect
 * path until `ydoc.destroy()`, which is what we want.
 */

class NoopWebSocket {
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

let savedWebSocket: typeof globalThis.WebSocket | undefined;

export function stubWebSocket(): void {
	savedWebSocket = globalThis.WebSocket;
	(globalThis as { WebSocket: unknown }).WebSocket = NoopWebSocket;
}

export function restoreWebSocket(): void {
	if (savedWebSocket !== undefined) {
		(globalThis as { WebSocket: unknown }).WebSocket = savedWebSocket;
		savedWebSocket = undefined;
	}
}
