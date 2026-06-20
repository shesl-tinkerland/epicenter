import type {
	ChatConversationHandle,
	ChatRenderState,
	ChatStream,
} from '@epicenter/workspace/ai';

/** The reactive conversation binding {@link bindConversation} returns. */
export type BoundConversation = Disposable & {
	/** The derived liveness/status a chat UI binds to, recomputed reactively. */
	readonly render: ChatRenderState;
	/** Send one user turn (no-op on empty input). */
	send(content: string): void;
	/** Stop the in-flight answer with the durable cancel. */
	stop(): void;
	/** Retry the latest turn by re-minting its generation. */
	retry(): void;
};

/**
 * Bind a conversation handle (`tables.<t>.docs.<field>.open(rowId)`) to Svelte
 * reactivity. The handle owns the answerer, the durable writes, and the
 * `status(now)` projection; this shim adds only the runes the handle cannot:
 * a clock and a rune-tracked re-read, so `render` recomputes when the doc changes
 * or the liveness clock ticks.
 *
 * The caller owns the answerer *policy*: pass `answer` (a {@link ChatStream}) for
 * a conversation the browser answers in-process, or omit it for one answered
 * elsewhere (a resident daemon over sync), so the two never double-answer one
 * turn. Inference rides whatever `answer` resolves to.
 *
 * Pass `now` to share one clock across many bound conversations (the answerer
 * runs for every open conversation, but only the viewed one renders, so a timer
 * per handle is waste); omit it and the binding owns a 1s ticker.
 *
 * Disposable: `[Symbol.dispose]()` stops the clock, the answerer, and disposes
 * the handle. Call it on teardown (component unmount, conversation switch).
 *
 * @example
 * ```svelte
 * const convo = bindConversation(
 *   workspace.tables.conversations.docs.messages.open(conversationId),
 *   { answer: runtime === 'daemon' ? undefined : epicenterStream({ ... }) },
 * );
 * // {#each convo.render.visibleMessages as m} … convo.send(t) / convo.stop()
 * ```
 */
export function bindConversation(
	handle: ChatConversationHandle & Disposable,
	{ answer, now }: { answer?: ChatStream; now?: () => number } = {},
): BoundConversation {
	// Own a 1s ticker only when the caller does not inject a shared clock, so
	// liveness decays past the grace window even when no doc events arrive.
	let ownNow = $state(Date.now());
	const ticker = now
		? undefined
		: setInterval(() => {
				ownNow = Date.now();
			}, 1000);
	const readNow = now ?? (() => ownNow);

	// A doc change bumps this rune so the `render` projection re-reads (it is read
	// via `void version` inside `render`). The handle's own observer refreshes its
	// `lastChangeAt` first (registered at open time, so it fires before this one),
	// so `status` reads a current clock.
	let version = $state(0);
	const unobserve = handle.observe(() => {
		version += 1;
	});

	const stopAnswerer = answer ? handle.answer(answer) : undefined;

	const render = $derived.by(() => {
		// Touch `version` so a transaction (not just a clock tick) recomputes the
		// projection; `status` re-reads the transcript and the handle's clock.
		void version;
		return handle.status(readNow());
	});

	return {
		get render() {
			return render;
		},
		send(content: string) {
			handle.send(content);
		},
		stop() {
			handle.stop();
		},
		retry() {
			handle.retry();
		},
		[Symbol.dispose]() {
			if (ticker) clearInterval(ticker);
			unobserve();
			stopAnswerer?.();
			handle[Symbol.dispose]();
		},
	};
}
