/**
 * Sync Transport URL Tests
 *
 * Verifies cloud sync URL construction for the rooms WebSocket endpoint.
 *
 * Key behaviors:
 * - Single URL form: `/api/owners/<ownerId>/rooms/<guid>` in both modes.
 * - `guid` is `encodeURIComponent`-encoded.
 * - Trailing slashes on `baseURL` are stripped.
 * - `http` origins become `ws`; `https` origins become `wss`.
 * - `nodeId` is appended as a query parameter.
 */

import { describe, expect, test } from 'bun:test';
import { asOwnerId, SHARED_OWNER_ID } from '@epicenter/identity';
import { asNodeId } from './node-id.js';
import { roomWsUrl } from './transport.js';

describe('roomWsUrl', () => {
	test('personal mode owner id partitions the path under /owners/', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://api.example.com',
				ownerId: asOwnerId('alice'),
				guid: 'epicenter-fuji',
				nodeId: asNodeId('client-1'),
			}),
		).toBe(
			'wss://api.example.com/api/owners/alice/rooms/epicenter-fuji?nodeId=client-1',
		);
	});

	test("shared mode uses the literal 'shared' owner id under the same /owners/ partition", () => {
		expect(
			roomWsUrl({
				baseURL: 'https://shared.example.com',
				ownerId: SHARED_OWNER_ID,
				guid: 'epicenter-fuji',
				nodeId: asNodeId('client-1'),
			}),
		).toBe(
			'wss://shared.example.com/api/owners/shared/rooms/epicenter-fuji?nodeId=client-1',
		);
	});

	test('encodes the guid and strips trailing slashes', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://api.example.com/',
				ownerId: SHARED_OWNER_ID,
				guid: 'a/b?c#d',
				nodeId: asNodeId('client-1'),
			}),
		).toBe(
			'wss://api.example.com/api/owners/shared/rooms/a%2Fb%3Fc%23d?nodeId=client-1',
		);
	});

	test('converts http origins to ws and https origins to wss', () => {
		expect(
			roomWsUrl({
				baseURL: 'http://localhost:8787',
				ownerId: SHARED_OWNER_ID,
				guid: 'epicenter-fuji',
				nodeId: asNodeId('client-1'),
			}),
		).toBe(
			'ws://localhost:8787/api/owners/shared/rooms/epicenter-fuji?nodeId=client-1',
		);
	});
});
