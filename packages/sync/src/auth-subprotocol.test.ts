/**
 * WebSocket Auth Subprotocol Tests
 *
 * Verifies the shared bearer subprotocol helpers used by auth clients and API
 * middleware.
 *
 * Key behaviors:
 * - Bearer prefix comes from the shared constants package
 * - Bearer tokens are extracted from comma-separated subprotocol headers
 */

import { BEARER_SUBPROTOCOL_PREFIX as SHARED_PREFIX } from '@epicenter/constants/auth';
import { expect, test } from 'bun:test';
import {
	BEARER_SUBPROTOCOL_PREFIX,
	extractBearerToken,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from './auth-subprotocol.js';

test('bearer prefix re-exports the shared auth constant', () => {
	expect(BEARER_SUBPROTOCOL_PREFIX).toBe(SHARED_PREFIX);
});

test('extractBearerToken reads the bearer subprotocol entry', () => {
	const headers = new Headers({
		'sec-websocket-protocol': `${MAIN_SUBPROTOCOL}, ${BEARER_SUBPROTOCOL_PREFIX}token-1`,
	});

	expect(parseSubprotocols(headers.get('sec-websocket-protocol'))).toEqual([
		MAIN_SUBPROTOCOL,
		`${BEARER_SUBPROTOCOL_PREFIX}token-1`,
	]);
	expect(extractBearerToken(headers)).toBe('token-1');
});
