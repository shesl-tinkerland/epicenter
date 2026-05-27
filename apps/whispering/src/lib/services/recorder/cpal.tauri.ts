import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { categorizeRecorderError } from '$lib/services/recorder/categorize-error';
import {
	asDeviceIdentifier,
	type CpalRecordingParams,
	type Device,
	type DeviceAcquisitionOutcome,
	type ProbeActiveCpalRecording,
	RecorderError,
	type RecorderService,
	type RecordingSession,
} from '$lib/services/recorder/types';
import { commands } from '$lib/tauri/commands';

const log = createLogger('whispering/recorder/cpal');

/**
 * Enumerates available recording devices from the system.
 */
const enumerateDevices = async (): Promise<Result<Device[], RecorderError>> => {
	const { data: deviceNames, error: enumerateRecordingDevicesError } =
		await commands.enumerateRecordingDevices();
	if (enumerateRecordingDevicesError !== null) {
		return RecorderError.EnumerateDevices({
			cause: enumerateRecordingDevicesError,
		});
	}
	// On desktop, device names serve as both ID and label
	return Ok(
		deviceNames.map((name) => ({
			id: asDeviceIdentifier(name),
			label: name,
		})),
	);
};

/**
 * CPAL recorder backend. Returns both the `RecorderService` implementation
 * and a separate `probeActiveCpalRecording` function bound to the same
 * `activeSession` slot.
 *
 * Rehydration is intentionally not on the service interface: only cpal can
 * rehydrate (the Rust process keeps the stream alive across JS reloads), so
 * the probe is exposed as its own export rather than as a subtype of
 * `RecorderService`. The manual recorder calls it once at module init.
 *
 * Stop returns a `RecordingArtifact` handle: Rust writes the durable WAV
 * to `<appDataDir>/recordings/{id}.wav` and the JS side refers to the
 * recording by id from then on. There is no raw PCM on the wire.
 */
function createCpalRecorder(): {
	service: RecorderService;
	probe: ProbeActiveCpalRecording;
} {
	let activeSession: RecordingSession | null = null;

	function buildSession(recordingId: string): RecordingSession {
		const subscribers = new Set<(s: WhisperingRecordingState) => void>();
		let currentState: WhisperingRecordingState = 'RECORDING';
		let tauriUnlisten: Promise<UnlistenFn> | null = null;

		const notify = (state: WhisperingRecordingState) => {
			// Idempotent: same-state notifications collapse to a no-op. Rust
			// emits 'recorder:state-changed' IDLE from `stop_recording`, then
			// our explicit `teardown()` also notifies IDLE; without this
			// guard we'd fire the handler twice for one transition.
			if (currentState === state) return;
			currentState = state;
			for (const handler of subscribers) handler(state);
		};

		const ensureTauriListener = () => {
			if (tauriUnlisten) return;
			// Rust emits 'recorder:state-changed' from every mutation path
			// (see src-tauri/src/recorder/commands.rs). Forward to subscribers
			// so Rust-initiated transitions (future auto-stop, device
			// disconnect) reach the UI.
			tauriUnlisten = listen<WhisperingRecordingState>(
				'recorder:state-changed',
				(event) => notify(event.payload),
			);
		};

		// Takes `session` as an argument rather than closing over the const
		// declared below. Both work because teardown only runs from
		// stop/cancel handlers (which can only fire after `session` is
		// bound), but the explicit argument keeps the function TDZ-safe if a
		// future caller invokes teardown from a path declared above the
		// `session = ...` initializer.
		const teardown = (session: RecordingSession) => {
			if (activeSession === session) activeSession = null;
			if (tauriUnlisten) {
				void tauriUnlisten.then((unlisten) => unlisten());
				tauriUnlisten = null;
			}
			notify('IDLE');
		};

		const session: RecordingSession = {
			recordingId,
			backend: 'cpal',

			stop: async () => {
				const { data: artifact, error: stopRecordingError } =
					await commands.stopRecording();
				if (stopRecordingError !== null) {
					teardown(session);
					return RecorderError.StopFailed({ cause: stopRecordingError });
				}

				// Rust's `stop_recording` returns the artifact handle but does
				// not close the worker; we still own the cpal stream and the
				// worker thread. Send `close_recording_session` so Rust can
				// join the worker and free the stream.
				const { error: closeError } = await commands.closeRecordingSession();
				if (closeError !== null)
					log.error(RecorderError.StopFailed({ cause: closeError }));
				teardown(session);

				return Ok({ kind: 'artifact', artifact });
			},

			cancel: async () => {
				// cancel_recording on the Rust side discards the in-flight
				// samples and tears down the session worker. One round trip.
				// Run teardown regardless so the UI reflects no-recording, but
				// propagate the error so the user knows the cancel didn't
				// fully complete (Rust state may be inconsistent).
				const { error: cancelError } = await commands.cancelRecording();
				teardown(session);
				if (cancelError !== null) {
					return RecorderError.CancelFailed({ cause: cancelError });
				}
				return Ok({ status: 'cancelled' });
			},

			subscribe(handler) {
				ensureTauriListener();
				subscribers.add(handler);
				// Fire current state immediately so callers don't have to mirror
				// 'RECORDING' at attach time.
				handler(currentState);
				return () => {
					subscribers.delete(handler);
				};
			},
		};

		return session;
	}

	const service: RecorderService = {
		enumerateDevices,

		startRecording: async ({
			selectedDeviceId,
			recordingId,
			sampleRate,
		}: CpalRecordingParams) => {
			const { data: devices, error: enumerateError } = await enumerateDevices();
			if (enumerateError !== null) return Err(enumerateError);

			const deviceIds = devices.map((d) => d.id);
			const fallbackDeviceId = deviceIds.at(0);
			if (!fallbackDeviceId) {
				return RecorderError.NoDevice({
					message: selectedDeviceId
						? "We couldn't find the selected microphone. Make sure it's connected and try again!"
						: "We couldn't find any microphones. Make sure they're connected and try again!",
				});
			}

			const deviceOutcome: DeviceAcquisitionOutcome = (() => {
				if (!selectedDeviceId) {
					return {
						outcome: 'fallback',
						reason: 'no-device-selected',
						deviceId: fallbackDeviceId,
					};
				}
				if (deviceIds.includes(selectedDeviceId)) {
					return { outcome: 'success', deviceId: selectedDeviceId };
				}
				return {
					outcome: 'fallback',
					reason: 'preferred-device-unavailable',
					deviceId: fallbackDeviceId,
				};
			})();

			const deviceIdentifier = deviceOutcome.deviceId;
			const sampleRateNum = sampleRate ? Number.parseInt(sampleRate, 10) : null;

			const { error: initRecordingSessionError } =
				await commands.initRecordingSession(
					deviceIdentifier,
					recordingId,
					sampleRateNum,
				);
			if (initRecordingSessionError !== null)
				return (
					categorizeRecorderError(initRecordingSessionError) ??
					RecorderError.InitFailed({
						cause: initRecordingSessionError,
					})
				);

			const { error: startRecordingError } = await commands.startRecording();
			if (startRecordingError !== null)
				return (
					categorizeRecorderError(startRecordingError) ??
					RecorderError.StartFailed({ cause: startRecordingError })
				);

			const session = buildSession(recordingId);
			activeSession = session;
			return Ok({ session, deviceAcquisition: deviceOutcome });
		},
	};

	const probe: ProbeActiveCpalRecording = async () => {
		// Probe Rust directly. The probe is called once at module init when
		// `activeSession` is null by definition, so there is no in-memory
		// shortcut to check.
		const { data: liveRecordingId, error: getIdError } =
			await commands.getCurrentRecordingId();
		if (getIdError !== null) {
			return RecorderError.GetStateFailed({ cause: getIdError });
		}
		if (!liveRecordingId) return Ok(null);

		const rehydrated = buildSession(liveRecordingId);
		activeSession = rehydrated;
		return Ok(rehydrated);
	};

	return { service, probe };
}

const cpal = createCpalRecorder();
export const CpalRecorderServiceLive: RecorderService = cpal.service;
export const probeActiveCpalRecording: ProbeActiveCpalRecording = cpal.probe;
