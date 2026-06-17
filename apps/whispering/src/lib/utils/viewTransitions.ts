/**
 * Centralized view transition names for consistent cross-page animations.
 *
 * View transitions connect UI elements across pages. When two elements on different
 * pages share the same `view-transition-name`, the browser animates between them
 * during navigation.
 *
 * @example
 * ```svelte
 * <!-- Home page -->
 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
 *
 * <!-- Recordings page -->
 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
 * ```
 *
 * When navigating between pages, the audio element morphs smoothly.
 */
export const viewTransition = {
	/**
	 * Transition names for a specific recording's UI elements.
	 *
	 * @example
	 * ```svelte
	 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
	 * <div style="view-transition-name: {viewTransition.recording(id).transcript}" />
	 * ```
	 */
	recording(id: string) {
		return {
			/** The audio player element */
			audio: `recording-${id}-audio`,
			/** The transcript text display */
			transcript: `recording-${id}-transcript`,
		} as const;
	},

	/**
	 * Global UI elements that persist across pages.
	 * These have fixed names since they're singletons.
	 */
	global: {
		/** The microphone/recording button */
		microphone: 'microphone-icon',
		/** The cancel recording button */
		cancel: 'cancel-icon',
		/** The page header */
		header: 'header',
		/** The navigation container */
		nav: 'nav',
	},
} as const;
