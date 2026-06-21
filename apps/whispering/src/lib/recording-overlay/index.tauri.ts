import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	currentMonitor,
	LogicalPosition,
	primaryMonitor,
} from '@tauri-apps/api/window';
import { createLogger } from 'wellcrafted/logger';
import {
	type RecordingOverlayStatus,
	recordingOverlayMicLevel,
	recordingOverlayReady,
	recordingOverlayStatus,
} from '$lib/recording-overlay/events';

const log = createLogger('whispering/recording-overlay');

const WINDOW_LABEL = 'recording-overlay';
// Fixed size in logical pixels. The width is the pill's max width (the cap in
// RecordingPill); the transparent window centers the narrower states inside it.
const OVERLAY_WIDTH = 224;
const OVERLAY_HEIGHT = 40;
// Distance from the bottom edge of the monitor, in logical pixels.
const OVERLAY_BOTTOM_MARGIN = 72;

/**
 * Manages the floating recording overlay window from the main window.
 *
 * The overlay window is created lazily on first show and then kept alive and
 * toggled visible/hidden, mirroring the transform-clipboard window. It is
 * transparent, undecorated, always-on-top, non-focusable, and skips the
 * taskbar so it reads as a system HUD rather than an app window.
 *
 * `sync` is the only entry point: pass the status to show, or `null` to hide.
 * Calls are coalesced. Each call overwrites `latestStatus` and runs on a serial
 * queue; every async step re-checks whether the status it captured is still
 * `latestStatus`. The final intent always wins: a burst of rapid state changes
 * (start then immediately cancel) settles on the last status, and a stale show
 * that loses the race to a later hide is collapsed rather than left visible.
 * `latestStatus` is the single source of truth for "what should be showing", so
 * the supersede check reads it directly rather than tracking a parallel counter.
 *
 * Platform note: on macOS the overlay window is created in Rust as a
 * non-activating `NSPanel` (see `src-tauri/src/overlay.rs`), so clicking it
 * never activates the app or raises the main window. This module then finds it
 * by label and drives show/hide/position just like any window. On Windows and
 * Linux the window is created here with `focusable: false` + `alwaysOnTop`,
 * which is sufficient there. `getOrCreateOverlayWindow` handles both: it
 * reuses the pre-created macOS panel and only creates a window when none
 * exists.
 */

let latestStatus: RecordingOverlayStatus | null = null;
let queue: Promise<void> = Promise.resolve();
let readyListenerRegistered: Promise<void> | null = null;

async function computeOverlayPosition(): Promise<LogicalPosition | null> {
	// Prefer the monitor the main window is on; fall back to the primary.
	const monitor = (await currentMonitor()) ?? (await primaryMonitor());
	if (!monitor) return null;

	const scale = monitor.scaleFactor;
	const monitorX = monitor.position.x / scale;
	const monitorY = monitor.position.y / scale;
	const monitorWidth = monitor.size.width / scale;
	const monitorHeight = monitor.size.height / scale;

	const x = monitorX + (monitorWidth - OVERLAY_WIDTH) / 2;
	const y = monitorY + monitorHeight - OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN;
	return new LogicalPosition(x, y);
}

/**
 * Listen for the overlay's `ready` handshake and re-send whatever status is
 * current. The returned promise is cached and awaited before the window is
 * created, so the listener is guaranteed live before the overlay can emit
 * `ready`; otherwise the handshake could land in the gap between window
 * creation and listener registration and be lost. Caching the promise (not a
 * boolean flag) also prevents a duplicate listener if two creations race.
 */
function ensureReadyListener(): Promise<void> {
	readyListenerRegistered ??= recordingOverlayReady
		.listen(() => {
			if (latestStatus) void recordingOverlayStatus.emit(latestStatus);
		})
		.then(() => undefined);
	return readyListenerRegistered;
}

async function createOverlayWindow(): Promise<WebviewWindow | null> {
	await ensureReadyListener();

	// Created hidden and positioned by `applyStatus` before its first `show()`,
	// so the window is never painted at this initial position. No need to
	// compute a real one here.
	const overlay = new WebviewWindow(WINDOW_LABEL, {
		url: '/recording-overlay',
		title: 'Recording',
		width: OVERLAY_WIDTH,
		height: OVERLAY_HEIGHT,
		transparent: true,
		decorations: false,
		shadow: false,
		alwaysOnTop: true,
		visibleOnAllWorkspaces: true,
		skipTaskbar: true,
		resizable: false,
		maximizable: false,
		minimizable: false,
		// User can't close it; visibility is driven entirely by recorder state.
		closable: false,
		// Never take focus from the app the user is dictating into.
		focus: false,
		focusable: false,
		// Created hidden; the first `show()` reveals it once positioned.
		visible: false,
	});

	return new Promise<WebviewWindow | null>((resolve) => {
		overlay.once('tauri://created', () => resolve(overlay));
		overlay.once('tauri://error', (event) => {
			log.warn(
				new Error(
					`Failed to create recording overlay window: ${JSON.stringify(event.payload)}`,
				),
			);
			resolve(null);
		});
	});
}

async function getOrCreateOverlayWindow(): Promise<WebviewWindow | null> {
	// getByLabel is the source of truth: it survives this module's state being
	// torn down by a hot reload and detects a window closed out from under us.
	const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existing) return existing;
	return createOverlayWindow();
}

async function applyStatus(status: RecordingOverlayStatus | null) {
	// A newer sync() has already overwritten latestStatus, so the status we
	// captured is stale and a later queued task owns the final state. Reading
	// the shared latestStatus is the whole cancellation mechanism: the queue
	// gives ordering, this gives last-write-wins.
	const isSuperseded = () => status !== latestStatus;
	if (isSuperseded()) return;

	if (!status) {
		const overlay = await WebviewWindow.getByLabel(WINDOW_LABEL);
		if (overlay) await overlay.hide();
		return;
	}

	const overlay = await getOrCreateOverlayWindow();
	if (!overlay || isSuperseded()) return;

	const position = await computeOverlayPosition();
	if (isSuperseded()) return;
	if (position) await overlay.setPosition(position);
	if (isSuperseded()) return;

	await overlay.show();
	if (isSuperseded()) {
		// A newer sync superseded us mid-show. The queued task will run next,
		// but if the latest intent is "hidden" we hide now to collapse the
		// brief show-then-hide flicker rather than wait for it.
		if (!latestStatus) await overlay.hide();
		return;
	}

	await recordingOverlayStatus.emit(status);
}

/**
 * Show the overlay with the given status, or hide it when passed `null`.
 * Fire-and-forget: failures are logged, never thrown, because the overlay is
 * cosmetic and must not break the recording flow.
 */
function sync(status: RecordingOverlayStatus | null): void {
	latestStatus = status;
	queue = queue
		.then(() => applyStatus(status))
		.catch((error) => {
			log.warn(error instanceof Error ? error : new Error(String(error)));
		});
}

/**
 * Forward a live mic level (raw RMS) to the overlay. Targeted emit to the
 * overlay window only (not a global broadcast) since this fires ~30x/sec while
 * recording. No-op cost if the overlay is not open. Used for VAD, whose audio
 * lives in JS; manual recording's level is emitted from the Rust CPAL worker
 * straight to the same channel.
 */
function reportLevel(level: number): void {
	// Fire-and-forget and swallow: this fires ~30x/sec, and at the very start of
	// a session it can race ahead of the overlay window existing. A missed level
	// frame is invisible, so a rejected emit must never surface as an unhandled
	// rejection.
	void recordingOverlayMicLevel.emitTo(WINDOW_LABEL, level).catch(() => {});
}

export const recordingOverlay = { sync, reportLevel };
