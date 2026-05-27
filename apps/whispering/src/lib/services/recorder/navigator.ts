import { Err, Ok, tryAsync, trySync } from 'wellcrafted/result';
import {
	TIMESLICE_MS,
	type WhisperingRecordingState,
} from '$lib/constants/audio';
import {
	cleanupRecordingStream,
	enumerateDevices,
	getRecordingStream,
} from '$lib/services/device-stream';
import { categorizeRecorderError } from './categorize-error';
import type {
	NavigatorRecordingParams,
	RecorderService,
	RecordingSession,
} from './types';
import { RecorderError } from './types';

type ActiveSession = {
	stream: MediaStream;
	mediaRecorder: MediaRecorder;
	recordedChunks: Blob[];
	session: RecordingSession;
};

/**
 * Navigator recorder service that uses the MediaRecorder API.
 * Available in both browser and desktop environments.
 *
 * Constructed via a factory so module-level state is just the single
 * in-flight session, if any. The exposed surface is `startRecording`
 * (factory), `getActiveRecording` (bootstrap), and `enumerateDevices`.
 * Per-session lifecycle (stop/cancel/subscribe) lives on the returned
 * `RecordingSession` so toggling the backend setting mid-recording does not
 * misroute teardown.
 */
function createNavigatorRecorder(): RecorderService {
	let activeSession: ActiveSession | null = null;

	function buildSession(args: {
		recordingId: string;
		stream: MediaStream;
		mediaRecorder: MediaRecorder;
		recordedChunks: Blob[];
		startedAtMs: number;
	}): { activeSession: ActiveSession; session: RecordingSession } {
		const { recordingId, stream, mediaRecorder, recordedChunks, startedAtMs } =
			args;
		const subscribers = new Set<(s: WhisperingRecordingState) => void>();
		let currentState: WhisperingRecordingState = 'RECORDING';

		const notify = (state: WhisperingRecordingState) => {
			// Idempotent: same-state notifications collapse to a no-op. Keeps
			// the teardown safe to call from multiple paths without double
			// firing 'IDLE' (e.g. an external listener and an explicit
			// teardown for the same transition).
			if (currentState === state) return;
			currentState = state;
			for (const handler of subscribers) handler(state);
		};

		const teardown = () => {
			activeSession = null;
			cleanupRecordingStream(stream);
			notify('IDLE');
		};

		const recordingSession: RecordingSession = {
			recordingId,
			backend: 'navigator',

			stop: async () => {
				const { data: blob, error: stopError } = await tryAsync({
					try: () =>
						new Promise<Blob>((resolve) => {
							mediaRecorder.addEventListener('stop', () => {
								const audioBlob = new Blob(recordedChunks, {
									type: mediaRecorder.mimeType,
								});
								resolve(audioBlob);
							});
							mediaRecorder.stop();
						}),
					catch: (error) => RecorderError.StopFailed({ cause: error }),
				});

				const durationMs = Date.now() - startedAtMs;

				teardown();

				if (stopError) return Err(stopError);

				return Ok({ kind: 'blob', blob, recordingId, durationMs });
			},

			cancel: async () => {
				mediaRecorder.stop();
				teardown();
				return Ok({ status: 'cancelled' });
			},

			subscribe(handler) {
				subscribers.add(handler);
				// Fire current state immediately so callers don't have to mirror
				// 'RECORDING' themselves at attach time.
				handler(currentState);
				return () => {
					subscribers.delete(handler);
				};
			},
		};

		const sessionRecord: ActiveSession = {
			stream,
			mediaRecorder,
			recordedChunks,
			session: recordingSession,
		};
		return { activeSession: sessionRecord, session: recordingSession };
	}

	return {
		enumerateDevices: async () => {
			const { data: devices, error } = await enumerateDevices();
			if (error) {
				return RecorderError.EnumerateDevices({ cause: error });
			}
			return Ok(devices);
		},

		startRecording: async ({
			selectedDeviceId,
			recordingId,
			bitrateKbps,
		}: NavigatorRecordingParams) => {
			if (activeSession) {
				return RecorderError.AlreadyRecording();
			}

			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream({ selectedDeviceId });
			if (acquireStreamError) {
				return (
					categorizeRecorderError(acquireStreamError) ??
					RecorderError.StreamAcquisition({ cause: acquireStreamError })
				);
			}

			const { stream, deviceOutcome } = streamResult;

			const mimeType = getSupportedAudioMimeType();
			const { data: mediaRecorder, error: recorderError } = trySync({
				try: () =>
					new MediaRecorder(stream, {
						bitsPerSecond: Number(bitrateKbps) * 1000,
						mimeType,
					}),
				catch: (error) => RecorderError.InitFailed({ cause: error }),
			});

			if (recorderError) {
				cleanupRecordingStream(stream);
				return Err(recorderError);
			}

			const recordedChunks: Blob[] = [];
			mediaRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
				if (event.data.size) recordedChunks.push(event.data);
			});

			mediaRecorder.start(TIMESLICE_MS);
			const startedAtMs = Date.now();

			const { activeSession: sessionRecord, session } = buildSession({
				recordingId,
				stream,
				mediaRecorder,
				recordedChunks,
				startedAtMs,
			});
			activeSession = sessionRecord;

			return Ok({ session, deviceAcquisition: deviceOutcome });
		},
	};
}

export const NavigatorRecorderServiceLive: RecorderService =
	createNavigatorRecorder();

/**
 * Determines the best supported audio MIME type for the current browser.
 *
 * Called before `MediaRecorder` construction so the type can be passed explicitly.
 * This is the industry-standard pattern (used by LibreChat, AutoGPT, 1code, etc.)
 * because:
 *
 * 1. Firefox (and forks like Zen) may leave `mediaRecorder.mimeType` empty when
 *    no type is specified at construction, see https://bugzilla.mozilla.org/show_bug.cgi?id=1512175
 * 2. Safari only supports `audio/mp4`, not `audio/webm`.
 * 3. Specifying upfront means the constructor throws `NotSupportedError` if invalid,
 *    rather than silently producing a blob with an empty type.
 * 4. MDN recommends calling `isTypeSupported()` before construction.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static
 */
function getSupportedAudioMimeType(): string {
	const candidates = [
		'audio/webm;codecs=opus',
		'audio/webm',
		'audio/ogg;codecs=opus',
		'audio/mp4',
		'audio/mp4;codecs=mp4a.40.2',
	];
	for (const candidate of candidates) {
		if (MediaRecorder.isTypeSupported(candidate)) return candidate;
	}
	return 'audio/webm';
}
