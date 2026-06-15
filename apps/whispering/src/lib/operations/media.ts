import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { log, report } from '$lib/report';
import { settings } from '$lib/state/settings.svelte';
import type { MediaControlFailure, MediaPlayer } from '$lib/tauri/commands';

// The one best-effort macOS side effect for recording: pause Music/Spotify
// while recording, resume them after. Recording never waits on this and never
// fails because of it.
//
// `chain` is the entire state: a promise resolving to the players we currently
// have paused (`[]` when nothing is paused). Every pause/resume tacks itself
// onto the tail, so the AppleScript calls run strictly one after another: a
// late resume can never race a fresh pause from a quick stop-then-restart. The
// resolved value answers the only question resume needs ("which players did I
// pause?") and doubles as the "currently paused" flag. Both helpers always
// resolve, so the chain never wedges.

let chain: Promise<MediaPlayer[]> = Promise.resolve([]);
let didExplainPermissionDenied = false;

function shouldPauseMedia(): boolean {
	return Boolean(
		tauri && os.isApple && settings.get('sound.pauseMediaDuringRecording'),
	);
}

/** Log every failure, and surface the permission hint once per session. */
function reportFailures(failures: MediaControlFailure[]): void {
	for (const failure of failures) {
		log.warn(
			new Error(
				`Media control failed for ${failure.player}: ${failure.message}`,
			),
			failure,
		);
	}

	if (didExplainPermissionDenied) return;
	if (!failures.some((failure) => failure.permissionDenied)) return;

	didExplainPermissionDenied = true;
	report.info({
		title: 'Media control is blocked',
		description:
			'Allow Whispering to control Music or Spotify in macOS Automation settings.',
	});
}

async function pauseActiveMedia(): Promise<MediaPlayer[]> {
	if (!tauri) return [];
	try {
		const { data, error } = await tauri.media.pause();
		if (error !== null) {
			log.warn(new Error(`Failed to pause media: ${error}`));
			return [];
		}
		reportFailures(data.failures);
		return data.paused;
	} catch (error) {
		log.warn(new Error(`Failed to pause media: ${String(error)}`));
		return [];
	}
}

async function resumeMedia(players: MediaPlayer[]): Promise<void> {
	if (!tauri || players.length === 0) return;
	try {
		const { data, error } = await tauri.media.resume(players);
		if (error !== null) {
			log.warn(new Error(`Failed to resume media: ${error}`));
			return;
		}
		reportFailures(data);
	} catch (error) {
		log.warn(new Error(`Failed to resume media: ${String(error)}`));
	}
}

export const recordingMedia = {
	/** Pause active media if enabled. Fire-and-forget: recording never waits. */
	pause(): void {
		if (!shouldPauseMedia()) return;
		// Already paused? Keep that set; otherwise pause what's playing now.
		chain = chain.then((paused) =>
			paused.length > 0 ? paused : pauseActiveMedia(),
		);
	},

	/**
	 * Resume whatever the matching `pause()` paused. A no-op when nothing was
	 * paused, so every stop/cancel/start-failure path can call it blindly.
	 */
	resume(): void {
		chain = chain.then(async (paused) => {
			await resumeMedia(paused);
			return [];
		});
	},
};
