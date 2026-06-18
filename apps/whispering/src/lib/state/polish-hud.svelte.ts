/**
 * Reactive state for the "Polishing..." HUD shown while the Polish pass runs.
 *
 * The pipeline calls `begin()` right before an AI Polish call and `end()` after
 * it settles; the value of `active` drives the floating recording overlay (on
 * desktop) into its polishing state. The module also owns the `AbortController`
 * so the overlay's "ship raw" control (and any future esc binding) can cancel
 * the in-flight completion through `shipRaw()` without threading the controller
 * through component props. See ADR 0021.
 *
 * Lives outside the pipeline because two different owners read and write it: the
 * pipeline (imperative, begins/ends the pass) and the overlay action handler
 * (reactive, cancels it). A module-level rune is the shared, reactive seam.
 */
let active = $state(false);
let controller: AbortController | null = null;

export const polishHud = {
	/** Whether a Polish pass is currently in flight. Reactive. */
	get active(): boolean {
		return active;
	},

	/**
	 * Mark the Polish pass as running and return a fresh `AbortSignal` to hand to
	 * `runPolish`. Call only when an AI call is actually about to happen
	 * (`polishWillRun`), so the HUD never flickers in speed mode.
	 */
	begin(): AbortSignal {
		controller = new AbortController();
		active = true;
		return controller.signal;
	},

	/**
	 * Cancel the in-flight pass and ship the raw transcript. Aborting makes the
	 * provider request reject; `runPolish` treats a user abort as a clean success
	 * and returns the raw input.
	 */
	shipRaw(): void {
		controller?.abort();
	},

	/** Mark the pass finished (success, failure, or abort) and drop the controller. */
	end(): void {
		active = false;
		controller = null;
	},
};
