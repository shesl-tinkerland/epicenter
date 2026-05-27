import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { defineKeys } from 'wellcrafted/query';
import { Err, Ok } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { defineQuery } from '$lib/rpc/client';
import { services } from '$lib/services';
import {
	CpalRecorderServiceLive,
	probeActiveCpalRecording,
} from '$lib/services/recorder';
import {
	asDeviceIdentifier,
	type RecorderService,
	type RecordingSession,
	type StartRecordingParams,
} from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

const ManualRecorderError = defineErrors({
	EnumerateDevicesFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
	AlreadyRecording: () => ({
		message:
			'A recording is already in progress. Stop the current one before starting a new one.',
	}),
	NoActiveRecording: () => ({
		message: 'No active recording session to stop. Start a recording first.',
	}),
});
type ManualRecorderError = InferErrors<typeof ManualRecorderError>;

export const manualRecorderKeys = defineKeys({
	devices: ['recorder', 'devices'],
});

/**
 * Creates the manual recorder with reactive state.
 *
 * State is owned by this module via Svelte's `$state` rune for synchronous
 * reactivity. Mirrors the shape of `vadRecorder` in `vad-recorder.svelte.ts`:
 *
 * - Reactive access: `manualRecorder.state` (triggers effects on change)
 * - Operations: `manualRecorder.startRecording()` etc.
 * - Device enumeration as a TanStack Query for loading states in selectors
 *
 * Each recording is a `RecordingSession` object returned by the backend that
 * started it. The RecordingSession owns its own stop/cancel/subscribe; the
 * recorder service is only consulted at start time, so toggling
 * `recording.method` mid-recording can't misroute teardown (the in-flight
 * RecordingSession stays bound to its original backend).
 *
 * Subscription is per-RecordingSession rather than per-service. The previous
 * model subscribed to both navigator and cpal at module init even though
 * only one would ever fire; now `attach()` subscribes to the live
 * RecordingSession and `detach()` cleans up on stop/cancel.
 *
 * On Tauri, state is bootstrapped from `probeActiveCpalRecording()` at module
 * init (a Rust CPAL session can outlive a JS reload). The navigator backend
 * cannot rehydrate, so there is no navigator probe.
 */

/**
 * Resolve the backend + start parameters from current settings in a single
 * decision. CpalRecorderServiceLive is null on web (build-time fact); even
 * when non-null, the runtime setting decides whether to use it.
 */
function resolveStartDecision(recordingId: string): {
	service: RecorderService;
	params: StartRecordingParams;
} {
	if (
		CpalRecorderServiceLive &&
		deviceConfig.get('recording.method') === 'cpal'
	) {
		const deviceId = deviceConfig.get('recording.cpal.deviceId');
		return {
			service: CpalRecorderServiceLive,
			params: {
				method: 'cpal',
				recordingId,
				selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
				sampleRate: deviceConfig.get('recording.cpal.sampleRate'),
			},
		};
	}

	const deviceId = deviceConfig.get('recording.navigator.deviceId');
	return {
		service: services.navigatorRecorder,
		params: {
			method: 'navigator',
			recordingId,
			selectedDeviceId: deviceId ? asDeviceIdentifier(deviceId) : null,
			bitrateKbps: deviceConfig.get('recording.navigator.bitrateKbps'),
		},
	};
}

function createManualRecorder() {
	let _state = $state<WhisperingRecordingState>('IDLE');
	let _current: RecordingSession | null = null;
	let _unsubscribe: (() => void) | null = null;

	function attach(session: RecordingSession) {
		_unsubscribe?.();
		_current = session;
		_unsubscribe = session.subscribe((s) => {
			_state = s;
			if (s === 'IDLE') detach();
		});
	}

	function detach() {
		_unsubscribe?.();
		_unsubscribe = null;
		_current = null;
		_state = 'IDLE';
	}

	// Bootstrap: only CPAL can outlive a JS reload (the Rust process keeps the
	// cpal stream alive across page reloads). Navigator state lives in this JS
	// process, so a reload zeroes it out by definition; no probe needed.
	//
	// The promise is awaited before any stop/cancel/start runs. Without that
	// gate, a user action firing before the rehydration probe resolves would
	// see a stale `_current === null` and either no-op the cancel (leaking
	// the Rust session) or double-start on top of a rehydrated one.
	const bootstrapped = probeActiveCpalRecording
		? probeActiveCpalRecording().then(({ data }) => {
				if (data) attach(data);
			})
		: Promise.resolve();

	return {
		get state(): WhisperingRecordingState {
			return _state;
		},

		enumerateDevices: defineQuery({
			queryKey: manualRecorderKeys.devices,
			queryFn: async () => {
				const { service } = resolveStartDecision(nanoid());
				const { data, error } = await service.enumerateDevices();
				if (error)
					return ManualRecorderError.EnumerateDevicesFailed({ cause: error });
				return Ok(data);
			},
		}),

		async startRecording() {
			await bootstrapped;
			if (_current) return ManualRecorderError.AlreadyRecording();
			const { service, params } = resolveStartDecision(nanoid());
			const { data, error: startRecordingError } =
				await service.startRecording(params);

			if (startRecordingError) return Err(startRecordingError);

			attach(data.session);
			return Ok(data.deviceAcquisition);
		},

		async stopRecording() {
			await bootstrapped;
			if (!_current) return ManualRecorderError.NoActiveRecording();
			const { data, error: stopRecordingError } = await _current.stop();
			if (stopRecordingError) return Err(stopRecordingError);
			return Ok(data);
		},

		async cancelRecording() {
			await bootstrapped;
			if (!_current) return Ok({ status: 'no-recording' as const });
			const { data: cancelResult, error: cancelRecordingError } =
				await _current.cancel();
			if (cancelRecordingError) return Err(cancelRecordingError);
			return Ok(cancelResult);
		},
	};
}

export const manualRecorder = createManualRecorder();
