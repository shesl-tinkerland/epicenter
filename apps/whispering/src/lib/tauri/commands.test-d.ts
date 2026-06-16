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

// stop_recording: fallible, returns the artifact struct.
type _StopRecording = Expect<
	Equal<
		ReturnType<typeof commands.stopRecording>,
		Promise<Result<RecordingArtifact, string>>
	>
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

// open_accessibility_settings: fallible, returns unit as null.
type _OpenAccessibilitySettings = Expect<
	Equal<
		ReturnType<typeof commands.openAccessibilitySettings>,
		Promise<Result<null, string>>
	>
>;

// encode_recording_for_upload: hand-rolled, raw bytes success path.
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
