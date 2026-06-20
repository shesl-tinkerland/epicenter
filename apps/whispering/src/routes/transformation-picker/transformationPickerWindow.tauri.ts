import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Ok, tryAsync } from 'wellcrafted/result';
import { defineWindowEvent, defineWindowSignal } from '$lib/window-events';

const WINDOW_LABEL = 'transformation-picker';

/**
 * Channels for handing the captured selection from the main window (where the
 * shortcut fires and the copy is simulated) to the picker window (a separate
 * webview, so a module variable can't cross the boundary; Tauri events can).
 *
 * - `pickerInput` carries the captured text TO the picker window.
 * - `pickerReady` is the picker window asking for the input on first mount,
 *   before the main window knows it exists. The main window answers with
 *   `pickerInput`. Re-opens skip this: the page is already mounted, so the
 *   proactive `pickerInput` from `openWithSelection` reaches it directly.
 */
export const pickerInput = defineWindowEvent<{ input: string }>(
	'transformation-picker:input',
);
export const pickerReady = defineWindowSignal('transformation-picker:ready');

/** The most recent captured selection, replayed when the window asks for it. */
let pendingInput = '';

let responderRegistered = false;

/**
 * Answer the picker window's first-mount request with the pending selection.
 * Registered lazily from `openWithSelection`, which only the main window calls,
 * so the responder never runs inside the picker webview itself (this module is
 * imported there too, for the event-name constants and `hide`). Registering it
 * at module load would make the picker window answer its own request with an
 * empty `pendingInput` and clobber the real selection.
 */
function registerInputResponder(): void {
	if (responderRegistered) return;
	responderRegistered = true;
	void pickerReady.listen(() => {
		void pickerInput.emit({ input: pendingInput });
	});
}

/**
 * Open the transformation picker on a freshly captured selection. Creates the
 * window on first call (the page requests the input on mount), then shows and
 * re-delivers on subsequent calls. The window is hidden, not disposed, so
 * re-opening is instant.
 */
export async function openWithSelection(input: string): Promise<void> {
	registerInputResponder();
	pendingInput = input;

	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existingWindow) {
		await existingWindow.show();
		// setFocus often fails on macOS; ignore.
		await existingWindow.setFocus().catch(() => {});
		await pickerInput.emit({ input });
		return;
	}

	const windowInstance = new WebviewWindow(WINDOW_LABEL, {
		url: '/transformation-picker',
		title: 'Transformations',
		width: 700,
		height: 600,
		center: true,
		alwaysOnTop: true,
		decorations: true,
		resizable: true,
		focus: true,
		visible: true,
	});

	windowInstance.once('tauri://error', (error) => {
		console.error('Failed to create transformation picker window:', error);
	});
}

/**
 * Hides the transformation picker window (doesn't dispose it for fast
 * re-opening).
 */
export async function hide(): Promise<void> {
	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existingWindow) {
		await tryAsync({
			try: () => existingWindow.hide(),
			catch: (error) => {
				console.error('Error hiding transformation picker window:', error);
				return Ok(undefined);
			},
		});
	}
}
