/**
 * Default timeouts shared across the workspace runtime, the daemon, and
 * the CLI. Values live here (instead of in their nearest call site) when
 * more than one package needs the same wait budget; that way "5 seconds"
 * can never quietly diverge between the RPC layer and the user-facing
 * `--wait` flag.
 */

/**
 * Default per-call RPC timeout. Used by:
 *
 * - `attachSync` outbound peer RPCs (`call(..., { timeout })`)
 * - `daemonClient` `/run` waits and the CLI `--wait` flag default
 * - `buildRemoteWorkspace` proxy when no per-call override is supplied
 *
 * Five seconds is long enough to absorb a slow round-trip on a saturated
 * connection but short enough that a hung peer surfaces fast.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 5_000;
