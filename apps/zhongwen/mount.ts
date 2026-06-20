/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers,
 * so the daemon hosts the root Y.Doc on disk and bridges cloud sync, then runs
 * one child-doc worker: an always-on observe loop (ADR-0024/0025) over the
 * `conversations.messages` transcripts. Registering the field is all the app
 * declares; the table, the guid, and the layout come from the schema. The
 * factory is the behavior seam, and it hands each hosted transcript to
 * `attachChatWorker`, the backend-agnostic append loop in
 * `@epicenter/workspace/ai`.
 *
 * The worker is parameterized by a `ChatStream`
 * (`startStream(messages, signal) => AsyncIterable<StreamChunk>`), the one
 * contract every inference backend speaks. The daemon resolves which backend
 * serves a turn as a priority chain over the backends it can satisfy
 * ({@link resolveDaemonStream}, ADR-0038), not a hardcoded constant:
 *
 * ```txt
 * byok(key)                if a local provider key is present (answer free)
 * ?? metered(session)      else if opted in to the user's metered account
 * ?? null                  else (host sync, do not answer)
 * ```
 *
 * A `null` resolution means no real backend on this host: the daemon hosts the
 * conversation's sync but writes nothing into it (there is no placeholder
 * reply), leaving the turn for a configured answerer. The worker itself observes
 * -> answers -> streams -> finishes and honors the client's durable cancel, all
 * over hosted sync with no HTTP and no duplicate stream.
 *
 * Designation (R, ADR-0025) is the observe loop's concern, not this factory's:
 * the loop builds a worker only for conversations bound to this daemon's agent
 * (`row.agent === selfAgentId`), so the factory supplies behavior alone. The
 * `agentId` option names which catalog agent this daemon answers as (a
 * `ZHONGWEN_AGENTS` id like `zhongwen-home`); omit it and the daemon hosts
 * nothing, leaving every conversation to its bound agent. The browser answers
 * in-process only the conversations it claims (an `'ephemeral'`-owner agent), so
 * a single turn is never answered twice.
 */

import {
	chatStreamFromAdapter,
	createAdapterForModel,
	HOUSE_KEY_ENV_VAR,
} from '@epicenter/ai-adapters';
import { MODELS_BY_ID } from '@epicenter/constants/ai-providers';
import type { AgentId, MountWorkerContext } from '@epicenter/workspace';
import { attachChatWorker, type ChatStream } from '@epicenter/workspace/ai';
import { nodeMountRuntime } from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { epicenterMeteredEngine } from './epicenter-engine.js';
import {
	type Engine,
	resolveEngine,
	ZHONGWEN_MODEL,
	ZHONGWEN_SYSTEM_PROMPT,
	zhongwenWorkspace,
} from './zhongwen.js';

const log = createLogger('zhongwen/mount');

export type ZhongwenMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
	/**
	 * The catalog agent this daemon answers as (ADR-0025): a `ZHONGWEN_AGENTS` id
	 * such as `zhongwen-home`. The observe loop then hosts exactly the
	 * conversations bound to it. Omit it and the daemon hosts nothing.
	 */
	agentId?: AgentId;
};

export function zhongwen({ baseURL, agentId }: ZhongwenMountOptions = {}) {
	// Resolve the backend once per mount, the first time a body opens: the
	// session and base URL are identical for every hosted body, and the priority
	// chain reads only the host's env and that session. `null` = no real backend
	// on this host; the worker then hosts the transcript's sync but does not
	// answer (it writes nothing, leaving the turn for a configured answerer).
	let backend: { startStream: ChatStream | null } | undefined;
	return zhongwenWorkspace.mount({
		baseURL,
		agentId,
		runtime: nodeMountRuntime(),
		workers: {
			conversations: {
				messages: (ctx) => {
					backend ??= { startStream: resolveDaemonStream(ctx, agentId) };
					return backend.startStream
						? attachChatWorker({
								ydoc: ctx.ydoc,
								startStream: backend.startStream,
							})
						: {};
				},
			},
		},
	});
}

/**
 * The daemon's inference backend for this mount: the first engine its host can
 * power, ADR-0038's priority chain ({@link resolveEngine}) over the engines
 * below. This resolves only the *engine* (where tokens come from); *designation*
 * (which conversations are this daemon's) is the observe loop's job, which hosts
 * only the conversations bound to this daemon's agent (`row.agent === agentId`,
 * ADR-0025), so by here the turn is already its own.
 *
 *  - **byok**: a local provider key (`OPENAI_API_KEY` / `GEMINI_API_KEY`, the
 *    catalog picks which) answers free, with no cloud round-trip. The only path
 *    for an offline or self-hosted daemon, so it stays first.
 *  - **metered**: answer on the user's metered Epicenter account over the same
 *    `/api/ai/chat` SSE path the browser uses ({@link epicenterMeteredEngine}, the
 *    shared builder), authenticated with the `AuthedFetch` the daemon already
 *    syncs with. Opt-in only ({@link isMeteredEnabled}): spending credits is a
 *    deliberate choice, symmetric with BYOK needing a key, so a keyless signed-in
 *    daemon never silently bills the user.
 *
 * `null` (neither engine satisfiable) means host the conversation's sync but
 * answer nothing: the daemon writes no placeholder into a real, synced
 * conversation, and the turn stays unanswered for a configured answerer (a keyed
 * daemon, or an open browser tab on the metered account).
 *
 * Switching the provider is a catalog + env-key change, no code edit. The
 * `session` and `baseURL` are the mount environment the worker factory receives
 * (ADR-0038's keystone): the credential the metered arm needs only exists once
 * the mount is open, never at `zhongwen({...})` construction.
 */
function resolveDaemonStream(
	{
		session,
		baseURL,
	}: Pick<MountWorkerContext<string, unknown>, 'session' | 'baseURL'>,
	agentId: AgentId | undefined,
): ChatStream | null {
	// The catalog gives the provider, and the provider -> house-key env var
	// mapping is single-homed in `@epicenter/ai-adapters` (exhaustive, so a new
	// provider is a compile error there, not a silent wrong key here).
	const { provider } = MODELS_BY_ID[ZHONGWEN_MODEL];
	const envVar = HOUSE_KEY_ENV_VAR[provider];

	// The metered engine builds the same way for every peer; only the opt-in gate
	// is the daemon's (a keyless signed-in daemon must not silently spend credits).
	const metered = epicenterMeteredEngine(session.fetch, baseURL);
	const engines: readonly Engine[] = [
		() => {
			const apiKey = process.env[envVar];
			return apiKey
				? chatStreamFromAdapter(createAdapterForModel(ZHONGWEN_MODEL, apiKey), [
						ZHONGWEN_SYSTEM_PROMPT,
					])
				: null;
		},
		() => (isMeteredEnabled() ? metered() : null),
	];

	const stream = resolveEngine(engines);
	if (agentId && !stream) {
		log.warn(
			new Error(
				`The Zhongwen daemon has no inference backend: ${envVar} is unset and ZHONGWEN_USE_METERED is off. It hosts conversation sync but does not answer. Set ${envVar} for local inference, or ZHONGWEN_USE_METERED=1 to answer on your metered Epicenter account.`,
			),
		);
	}
	return stream;
}

/**
 * Whether the daemon is opted in to answering on the user's metered Epicenter
 * account. Off by default: a signed-in daemon must not silently spend credits,
 * so the metered backend is reached only when `ZHONGWEN_USE_METERED` is set to
 * `1` or `true`.
 */
function isMeteredEnabled(): boolean {
	const value = process.env.ZHONGWEN_USE_METERED;
	return value === '1' || value === 'true';
}
