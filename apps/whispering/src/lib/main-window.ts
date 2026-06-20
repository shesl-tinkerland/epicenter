import { defineWindowEvent } from '$lib/window-events';

/**
 * An auxiliary window (the recording overlay pill, the transformation picker's
 * "Manage transformations") asking the main window to come to the front,
 * optionally routing it to `path`. The listener lives in the main window
 * (`attachMainWindowReveal`). Revealing and routing are one gesture so a request
 * can never navigate a window the user can't see.
 */
export const revealMainWindow = defineWindowEvent<{ path?: string }>(
	'main-window:reveal',
);
