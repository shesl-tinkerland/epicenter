import { type UnlistenFn } from '@tauri-apps/api/event';
import { tauri } from '#platform/tauri';
import { commands, events, type LocalModelState } from '$lib/tauri/commands';

const INITIAL_STATE: LocalModelState = {
	engine: null,
	modelName: null,
	status: { kind: 'idle' },
};

/**
 * Reactive mirror of the Rust `ModelCache`'s public state, kept in sync via
 * the `events.modelStateEvent` topic. Single instance per app;
 * mount once via `attach()` in the root layout.
 *
 * Race note: `attach()` registers the listener BEFORE snapshotting so the
 * worst case is one stale render when an event fires between listen and
 * snapshot (the next event will correct it). Sequence numbers would let us
 * dedupe perfectly but are overkill: every event carries a full state, so a
 * single missed event self-heals on the next transition.
 *
 * Shape mirrors `recordings.svelte.ts` / `vad-recorder.svelte.ts`: factory
 * function with a `$state` closure variable and a return object that exposes
 * a reactive getter plus operations.
 */
function createLocalModel() {
	let state = $state<LocalModelState>(INITIAL_STATE);

	return {
		/** Reactive view of the resident model and its lifecycle status. */
		get state(): LocalModelState {
			return state;
		},

		/** True while the model manager cannot start another local operation. */
		get isBusy(): boolean {
			return (
				state.status.kind === 'loading' || state.status.kind === 'inferring'
			);
		},

		/**
		 * Subscribe to the model-state event and seed the initial
		 * snapshot. Returns the unlisten function for the caller's lifecycle
		 * (typically the root layout's `onDestroy`).
		 *
		 * No-op outside Tauri; returns a no-op unlisten so callers don't need
		 * to branch on `tauri`.
		 */
		async attach(): Promise<UnlistenFn> {
			if (!tauri) return () => {};
			const unlisten = await events.modelStateEvent.listen((event) => {
				state = event.payload.state;
			});
			state = await commands.getTranscriptionState();
			return unlisten;
		},
	};
}

export const localModel = createLocalModel();
