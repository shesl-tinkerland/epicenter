/**
 * Type-level smoke tests for the boundary adapter.
 *
 * These assertions never run at value-level; they exist so a regression in
 * the `Wrap<F>` mapper or in `tauri-specta`'s output surfaces as a
 * `svelte-check` / `tsc` failure at the type level.
 */

import type { Result } from 'wellcrafted/result';
import type {
	commands,
	IpcRecorderError,
	LocalModelState,
	ModelStateEvent,
	ModelStatus,
	RecordingArtifact,
	TranscriptionError,
	TranscriptionSpec,
} from './commands';

// Helper: a no-op assertion that two types are equal.
type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

// stop_recording: fallible, returns the artifact struct. The error is the
// structured `RecorderError` IPC enum, not a bare string: this assertion is the
// contract proof that the recorder boundary stays typed.
type _StopRecording = Expect<
	Equal<
		ReturnType<typeof commands.stopRecording>,
		Promise<Result<RecordingArtifact, IpcRecorderError>>
	>
>;

// pause_playback / resume_playback: infallible across IPC. A platform failure
// is logged in Rust and never surfaces as an error the frontend must handle, so
// these stay plain Promises with no Result wrap.
type _PausePlayback = Expect<
	Equal<ReturnType<typeof commands.pausePlayback>, Promise<string[]>>
>;

type _ResumePlayback = Expect<
	Equal<ReturnType<typeof commands.resumePlayback>, Promise<void>>
>;

// transcribe_recording: fallible, takes recordingId plus the per-call spec.
type _TranscribeRecording = Expect<
	Equal<
		ReturnType<typeof commands.transcribeRecording>,
		Promise<Result<string, TranscriptionError>>
	>
>;

type _TranscribeRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.transcribeRecording>,
		[string, TranscriptionSpec]
	>
>;

// set_unload_policy: infallible (Rust `()`). Stays plain Promise; no Result
// wrap.
type _SetUnloadPolicy = Expect<
	Equal<ReturnType<typeof commands.setUnloadPolicy>, Promise<void>>
>;

type _SetUnloadPolicyArg = Expect<
	Equal<
		Parameters<typeof commands.setUnloadPolicy>,
		['never' | 'immediately' | 'after_5_minutes' | 'after_30_minutes']
	>
>;

// get_transcription_state: infallible snapshot for late-mounted observers.
type _GetTranscriptionState = Expect<
	Equal<
		ReturnType<typeof commands.getTranscriptionState>,
		Promise<LocalModelState>
	>
>;

type _ModelStateEventShape = Expect<
	Equal<
		ModelStateEvent,
		| { kind: 'loading_started'; state: LocalModelState }
		| {
				kind: 'loading_completed';
				state: LocalModelState;
				elapsedMs: number;
		  }
		| { kind: 'loading_failed'; state: LocalModelState; error: string }
		| { kind: 'inference_started'; state: LocalModelState }
		| {
				kind: 'inference_completed';
				state: LocalModelState;
				elapsedMs: number;
		  }
		| { kind: 'inference_failed'; state: LocalModelState; error: string }
		| {
				kind: 'unloaded';
				state: LocalModelState;
				reason: { kind: 'immediate' } | { kind: 'idle'; idleSecs: number };
		  }
	>
>;

type _ModelStatusShape = Expect<
	Equal<
		ModelStatus,
		| { kind: 'idle' }
		| { kind: 'loading' }
		| { kind: 'ready' }
		| { kind: 'inferring' }
		| { kind: 'error'; message: string }
	>
>;

// open_accessibility_settings: fallible, returns unit as null. Deliberately a
// bare-string error (tier 2): the frontend wraps it into one PermissionsError
// variant and only displays the message; it never branches on the cause.
type _OpenAccessibilitySettings = Expect<
	Equal<
		ReturnType<typeof commands.openAccessibilitySettings>,
		Promise<Result<null, string>>
	>
>;

// encode_recording_for_upload: hand-rolled, raw bytes success path. Error stays
// a bare string (tier 2): `tauri::ipc::Response` is not `specta::Type`, so this
// command lives outside the generated surface, and the frontend treats a
// failure as best-effort ("compression skipped"), never branching on it.
type _EncodeRecordingForUpload = Expect<
	Equal<
		ReturnType<typeof commands.encodeRecordingForUpload>,
		Promise<Result<ArrayBuffer, string>>
	>
>;

// TranscriptionSpec is the per-call local transcription config.
type _TranscriptionSpecShape = Expect<
	Equal<
		TranscriptionSpec,
		{
			engine: 'whispercpp' | 'parakeet' | 'moonshine';
			modelName: string;
			language?: string | null;
			initialPrompt?: string | null;
		}
	>
>;
