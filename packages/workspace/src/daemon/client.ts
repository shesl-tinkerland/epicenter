/**
 * Hand-rolled typed client for the `epicenter up` daemon. Three surfaces:
 *
 * - {@link pingDaemon}: cheap liveness probe; never throws, never returns
 *   Result. Boolean is the right shape for a fast-path predicate.
 * - {@link daemonClient}: factory returning a typed handle with one method
 *   per route. Each method returns `Promise<Result<T, DomainErr | DaemonError>>`,
 *   merging transport and domain failures into one tagged union the
 *   renderer narrows by `error.name`.
 * - {@link getDaemon}: dispatch decision for `run` / `list` / `peers`.
 *   Returns a typed client on success, or `MissingConfig` /
 *   `Required` when the workspace isn't configured / has no live daemon.
 *
 * The wire protocol is dead simple: POST a JSON body to a path on the unix
 * socket, get back a `Result<T, DomainErr>` JSON envelope from the handler.
 * No `hc` machinery: every route is one line that names its input/output
 * types directly. Body shapes still validate at the daemon boundary via
 * arktype (`app.ts` + `@hono/standard-validator`), so a stale CLI still
 * gets a typed 400 instead of a confusing downstream cast failure.
 */

import { join } from 'node:path';

import type { ActionManifest } from '../shared/actions.js';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

import type { ResolveError } from './resolve-entry.js';
import type { ListInput, PeerSnapshot, RunInput } from './app.js';
import { socketPathFor } from './paths.js';
import type { RunError } from './run-errors.js';

/**
 * Filename of the workspace config the daemon expects. Hard-coded here so
 * `getDaemon` can surface a clean `MissingConfig` error without pulling
 * the CLI's `load-config` module into the workspace package.
 */
const CONFIG_FILENAME = 'epicenter.config.ts';

/**
 * Resolved `--dir` + `--workspace` for a single command invocation. The CLI
 * builds this from yargs argv and passes it to `getDaemon`; consumers
 * outside the CLI (vault scripts) build it inline.
 */
export type ResolvedTarget = {
	absDir: string;
	userWorkspace: string | undefined;
};

/**
 * Tagged-error variants returned by daemon client surfaces. Domain errors
 * (UsageError, PeerMiss, etc.) live alongside these in a merged union so
 * call sites narrow once on `result.error.name`. No class hierarchy, no
 * throwing across the seam.
 *
 * - `Required`: no server is running for this directory; user must `serve`.
 * - `Timeout`: the per-call AbortSignal fired before the daemon answered.
 * - `Unreachable`: socket missing, ECONNREFUSED, transport closed.
 * - `HandlerCrashed`: the daemon answered with a non-2xx status. Reserved
 *   for unexpected exceptions; typed domain errors flow through the body
 *   `Result` instead.
 */
export const DaemonError = defineErrors({
	MissingConfig: ({ absDir }: { absDir: string }) => ({
		message: `No ${CONFIG_FILENAME} found in ${absDir}`,
		absDir,
	}),
	Required: ({ absDir, id }: { absDir: string; id?: string }) => ({
		message:
			id !== undefined
				? `no daemon running for ${absDir} (workspace ${id}); start one with \`epicenter serve\` first`
				: `no server running for ${absDir}; start one with \`epicenter serve\` first`,
		absDir,
		id,
	}),
	Timeout: ({
		socketPath,
		timeoutMs,
	}: {
		socketPath: string;
		timeoutMs: number;
	}) => ({
		message: `timed out after ${timeoutMs}ms waiting for ${socketPath}`,
		socketPath,
		timeoutMs,
	}),
	Unreachable: ({
		socketPath,
		cause,
	}: {
		socketPath: string;
		cause: unknown;
	}) => ({
		message: `daemon connection failed at ${socketPath}: ${extractErrorMessage(cause)}`,
		socketPath,
		cause,
	}),
	HandlerCrashed: ({
		socketPath,
		cause,
	}: {
		socketPath: string;
		cause: unknown;
	}) => ({
		message: `daemon handler error at ${socketPath}: ${extractErrorMessage(cause)}`,
		socketPath,
		cause,
	}),
});
export type DaemonError = InferErrors<typeof DaemonError>;

/** Default per-call timeout (ms). */
const DEFAULT_CALL_TIMEOUT_MS = 5000;

/** Default ping timeout (ms). Tight on purpose: ping is a fast-path probe. */
const DEFAULT_PING_TIMEOUT_MS = 250;

/**
 * Cheap liveness probe. POSTs `/ping` and resolves `true` iff the daemon
 * answers with 200 within `timeoutMs`. Never throws.
 */
export async function pingDaemon(
	socketPath: string,
	timeoutMs: number = DEFAULT_PING_TIMEOUT_MS,
): Promise<boolean> {
	try {
		const res = await fetch('http://daemon/ping', {
			unix: socketPath,
			method: 'POST',
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * One round-trip to the daemon. The body of a successful 2xx response is
 * a `Result<TOk, TErr>` envelope produced by the handler; transport
 * failures and unexpected non-2xx responses fold into `DaemonError`.
 *
 * Hostname is a placeholder; routing is done by the unix socket path.
 * Routes without a validator (ping, peers) get an empty `{}`
 * body, which Hono's body-parsing tolerates and validators ignore.
 */
async function call<TOk, TErr>(
	socketPath: string,
	timeoutMs: number,
	path: string,
	body: unknown = {},
): Promise<Result<TOk, TErr | DaemonError>> {
	const fetched = await tryAsync({
		try: () =>
			fetch(`http://daemon${path}`, {
				unix: socketPath,
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			}),
		catch: (cause) =>
			cause instanceof Error && cause.name === 'TimeoutError'
				? DaemonError.Timeout({ socketPath, timeoutMs })
				: DaemonError.Unreachable({ socketPath, cause }),
	});
	if (fetched.error !== null) return fetched;
	const res = fetched.data;
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		return DaemonError.HandlerCrashed({
			socketPath,
			cause: text || `HTTP ${res.status}`,
		});
	}
	return (await res.json()) as Result<TOk, TErr>;
}

/**
 * Build a typed handle for a daemon listening on `socketPath`. Each method
 * is a one-liner over {@link call}; the input/output types are named
 * directly here rather than inferred through `hc`. Adding a route is: add
 * a method whose `<TOk, TErr>` matches the handler's body `Result`.
 */
export function daemonClient(
	socketPath: string,
	timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
) {
	return {
		peers: () => call<PeerSnapshot[], never>(socketPath, timeoutMs, '/peers'),
		list: (input: ListInput) =>
			call<ActionManifest, ResolveError>(socketPath, timeoutMs, '/list', input),
		run: (input: RunInput) =>
			call<unknown, RunError | ResolveError>(
				socketPath,
				timeoutMs,
				'/run',
				input,
			),
	};
}

/**
 * Public type of the typed daemon handle. Equivalent to the return of
 * {@link daemonClient}.
 */
export type DaemonClient = ReturnType<typeof daemonClient>;

/**
 * Resolve the daemon client for `target`, or surface why we can't.
 *
 *   - `MissingConfig`: no `epicenter.config.ts` in `absDir`. Surfaced
 *     distinctly from `Required` so unconfigured users don't get pointed
 *     at `epicenter serve` (which would fail and mislead).
 *   - `Required`: config exists but no server is running. Renderer
 *     prints the start-with-`serve` hint.
 *
 * `run`, `list`, and `peers` are mandatory-daemon commands; if they hit
 * neither variant they have a typed client to dispatch against.
 */
export async function getDaemon(
	target: ResolvedTarget,
): Promise<Result<DaemonClient, DaemonError>> {
	const configPath = join(target.absDir, CONFIG_FILENAME);
	if (!(await Bun.file(configPath).exists())) {
		return DaemonError.MissingConfig({ absDir: target.absDir });
	}
	const sock = socketPathFor(target.absDir);
	if (!(await pingDaemon(sock))) {
		return DaemonError.Required({ absDir: target.absDir });
	}
	return Ok(daemonClient(sock));
}
