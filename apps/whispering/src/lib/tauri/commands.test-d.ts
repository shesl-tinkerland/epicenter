/**
 * Type-level smoke tests for the boundary adapter.
 *
 * These assertions never run at value-level; they exist so a regression in
 * the `Wrap<F>` mapper or in `tauri-specta`'s output surfaces as a
 * `svelte-check` / `tsc` failure at the type level.
 */

import type { Result } from 'wellcrafted/result';
import type {
	LocalModelState,
	ModelStateEvent,
	ModelStatus,
	RecordingArtifact,
	TranscriptionConfig,
	TranscriptionError,
} from './commands';
import { commands } from './commands';

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

// transcribe_recording: fallible, takes only recordingId now (config is
// ambient via setTranscriptionConfig).
type _TranscribeRecording = Expect<
	Equal<
		ReturnType<typeof commands.transcribeRecording>,
		Promise<Result<string, TranscriptionError>>
	>
>;

type _TranscribeRecordingArgs = Expect<
	Equal<Parameters<typeof commands.transcribeRecording>, [string]>
>;

// set_transcription_config: infallible (Rust `()`). Stays plain Promise; no
// Result wrap.
type _SetTranscriptionConfig = Expect<
	Equal<ReturnType<typeof commands.setTranscriptionConfig>, Promise<void>>
>;

type _SetTranscriptionConfigArg = Expect<
	Equal<
		Parameters<typeof commands.setTranscriptionConfig>,
		[TranscriptionConfig]
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
				reason:
					| { kind: 'immediate' }
					| { kind: 'idle'; idleSecs: number }
					| { kind: 'config_changed' };
		  }
		| { kind: 'selection_changed'; state: LocalModelState }
	>
>;

type _ModelStatusShape = Expect<
	Equal<
		ModelStatus,
		| { kind: 'idle' }
		| { kind: 'switching' }
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

// TranscriptionConfig is the ambient config the FE pushes once per change.
type _TranscriptionConfigShape = Expect<
	Equal<
		TranscriptionConfig,
		{
			engine: 'whispercpp' | 'parakeet' | 'moonshine';
			modelPath: string;
			language?: string | null;
			initialPrompt?: string | null;
			unloadPolicy:
				| 'never'
				| 'immediately'
				| 'after_5_minutes'
				| 'after_30_minutes';
		}
	>
>;
