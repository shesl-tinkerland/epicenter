import { describe, expect, it } from 'bun:test';

import {
	FRAME_HEADER_BYTES,
	createFrameReader,
	encodeFrame,
} from './framing.js';

describe('ipc-framing', () => {
	it('round trips a single frame', () => {
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		const framed = encodeFrame(payload);
		expect(framed.byteLength).toBe(FRAME_HEADER_BYTES + payload.byteLength);

		const out: Uint8Array[] = [];
		const reader = createFrameReader((frame) => out.push(frame));
		reader.push(framed);
		expect(out).toHaveLength(1);
		expect(Array.from(out[0]!)).toEqual([1, 2, 3, 4, 5]);
	});

	it('emits empty frames for zero-length payload', () => {
		const out: Uint8Array[] = [];
		const reader = createFrameReader((frame) => out.push(frame));
		reader.push(encodeFrame(new Uint8Array(0)));
		expect(out).toHaveLength(1);
		expect(out[0]!.byteLength).toBe(0);
	});

	it('reassembles a frame split across many pushes', () => {
		const payload = new Uint8Array(1024);
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
		const framed = encodeFrame(payload);

		const out: Uint8Array[] = [];
		const reader = createFrameReader((frame) => out.push(frame));
		const chunkSize = 17;
		for (let off = 0; off < framed.byteLength; off += chunkSize) {
			reader.push(framed.slice(off, Math.min(off + chunkSize, framed.byteLength)));
		}

		expect(out).toHaveLength(1);
		expect(Array.from(out[0]!)).toEqual(Array.from(payload));
	});

	it('emits multiple frames coalesced in one chunk', () => {
		const a = encodeFrame(new Uint8Array([10, 20]));
		const b = encodeFrame(new Uint8Array([30, 40, 50]));
		const c = encodeFrame(new Uint8Array([60]));
		const concat = new Uint8Array(a.byteLength + b.byteLength + c.byteLength);
		concat.set(a, 0);
		concat.set(b, a.byteLength);
		concat.set(c, a.byteLength + b.byteLength);

		const out: Uint8Array[] = [];
		const reader = createFrameReader((frame) => out.push(frame));
		reader.push(concat);

		expect(out.map((f) => Array.from(f))).toEqual([
			[10, 20],
			[30, 40, 50],
			[60],
		]);
	});

	it('does not emit a partial frame when the header arrives without payload', () => {
		const payload = new Uint8Array([7, 7, 7, 7]);
		const framed = encodeFrame(payload);

		const out: Uint8Array[] = [];
		const reader = createFrameReader((frame) => out.push(frame));
		reader.push(framed.slice(0, FRAME_HEADER_BYTES));
		expect(out).toHaveLength(0);
		reader.push(framed.slice(FRAME_HEADER_BYTES));
		expect(out).toHaveLength(1);
	});
});
