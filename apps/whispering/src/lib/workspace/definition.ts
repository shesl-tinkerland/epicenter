import { field } from '@epicenter/field';
import {
	createWorkspace,
	defineKv,
	defineTable,
	type IanaTimeZone,
	type InferKvValue,
	type InferTableRow,
	nullable,
	satisfiesWorkspace,
} from '@epicenter/workspace';
import { type Static, type TProperties, Type } from 'typebox';

// ── Constant imports ─────────────────────────────────────────────────────────

import { RECORDING_TRIGGERS } from '$lib/constants/audio/recording-triggers';
import { INFERENCE_PROVIDER_IDS } from '$lib/constants/inference';
import {
	PROVIDERS,
	TRANSCRIPTION_SERVICE_IDS,
	type TranscriptionServiceId,
} from '$lib/services/transcription/providers';

/**
 * Tables store normalized domain entities. Each row is replaced atomically via
 * `table.set()`, there's no field-level merging. Schemas validate rows on read.
 */
/**
 * A terminal job outcome: `completed` or `failed`. Both variants carry the
 * finish instant; `failed` adds the error message; `completed` carries whatever
 * job-specific payload the caller declares through `completedExtra`.
 *
 * Only terminal states are ever stored. A job still in flight has no outcome
 * (the storing column is null); liveness comes from the in-flight mutation,
 * never from durable state. A stored 'running'/'transcribing' status would
 * wedge on crash: the process that died can no longer write the terminal
 * state. See
 * docs/articles/20260612T190745-liveness-belongs-to-the-process-not-the-row.md.
 */
function terminalOutcome<CompletedExtra extends TProperties>(
	completedExtra: CompletedExtra,
) {
	return Type.Union([
		Type.Object({
			status: Type.Literal('completed'),
			completedAt: field.instant(),
			...completedExtra,
		}),
		Type.Object({
			status: Type.Literal('failed'),
			completedAt: field.instant(),
			error: Type.String(),
		}),
	]);
}

/**
 * Terminal outcome of transcribing a recording. The transcript text lives in
 * its own `transcript` column, so the `completed` variant only records when it
 * finished.
 */
const TranscriptionOutcome = terminalOutcome({});

/**
 * Audio recordings captured by the user. One row per recording session.
 *
 * `transcription` holds only the terminal outcome (completed or failed). A
 * recording that is currently transcribing has no `transcription`; liveness is
 * derived from the in-flight mutation, never stored.
 */
const recordings = defineTable({
	id: field.string(),
	title: field.string(),
	recordedAt: field.instant(),
	recordedAtZone: field.string<IanaTimeZone>(),
	transcript: field.string(),
	duration: nullable(field.number()),
	transcription: nullable(field.json(TranscriptionOutcome)),
});

/** Recording row type inferred from the workspace table schema. */
export type Recording = InferTableRow<typeof recordings>;

/**
 * A single deterministic find/replace pair. A list of these runs offline (no API
 * key) before the prompt (`preReplacements`) and after it (`postReplacements`):
 * a small dictionary ("new paragraph" to a newline, filler stripping, proper-noun
 * fixes) covers far more real-world cleanup than a single replacement each.
 */
const Replacement = Type.Object({
	find: Type.String(),
	replace: Type.String(),
	useRegex: Type.Boolean(),
});

/** One find/replace pair within a transformation's pre/post phase. */
export type Replacement = Static<typeof Replacement>;

/**
 * The one optional AI phase of a transformation: a single prompt template run
 * against a single model on a single backend (inference provider). The backend
 * and model live here, on the prompt, not on a separate step row.
 */
const TransformationPrompt = Type.Object({
	inferenceProvider: field.select(INFERENCE_PROVIDER_IDS),
	model: Type.String(),
	systemPromptTemplate: Type.String(),
	userPromptTemplate: Type.String(),
});

/** The single prompt phase of a transformation. */
export type TransformationPrompt = Static<typeof TransformationPrompt>;

/**
 * User-defined transformations. A transformation is a fixed three-phase shape:
 * deterministic `preReplacements`, one optional AI `prompt`, then deterministic
 * `postReplacements`. At least one phase is present (enforced at write time, not
 * by the schema). This replaces the old arbitrary N-step pipeline: there is no
 * ordered `transformationSteps` table, no per-step model memory, no step editor.
 */
const transformations = defineTable({
	id: field.string(),
	title: field.string(),
	description: field.string(),
	preReplacements: field.json(Type.Array(Replacement)),
	prompt: nullable(field.json(TransformationPrompt)),
	postReplacements: field.json(Type.Array(Replacement)),
});

/** Transformation row type inferred from the workspace table schema. */
export type Transformation = InferTableRow<typeof transformations>;

/**
 * Terminal outcome of a finished transformation run, carrying the produced
 * `output` on success. Built from the shared `terminalOutcome` helper.
 *
 * Only terminal outcomes are stored. A run that is currently executing has no
 * `result` (the column is null); liveness is derived from `startedAt` recency,
 * never written. A stored `running` status would wedge on crash: the process
 * that died can no longer write the terminal state, so the row would claim
 * `running` forever. See
 * docs/articles/20260612T190745-liveness-belongs-to-the-process-not-the-row.md.
 *
 * Storage is one nullable JSON-encoded TEXT column (`result`); nothing in the
 * read path filters or sorts on these fields.
 */
const TransformationRunResult = terminalOutcome({ output: Type.String() });

/**
 * Execution records for transformations. One run per invocation.
 * State queries filter by top-level `recordingId` / `transformationId` and
 * sort by `startedAt`; the terminal outcome lives inside `result`, which is
 * null while the run is executing or if it was interrupted.
 */
const transformationRuns = defineTable({
	id: field.string(),
	transformationId: field.string(),
	recordingId: nullable(field.string()),
	input: field.string(),
	startedAt: field.instant(),
	result: nullable(field.json(TransformationRunResult)),
});

/** Transformation run row type inferred from the workspace table schema. */
export type TransformationRun = InferTableRow<typeof transformationRuns>;

/**
 * Synced settings stored as individual KV entries with last-write-wins resolution.
 *
 * Each key is independently resolved: two devices can change different settings
 * simultaneously without one overwriting the other. Dot-notation keys create a
 * natural namespace hierarchy and give per-key LWW granularity (unlike table rows
 * which are replaced atomically).
 *
 * Only preferences that roam across devices live here. API keys, filesystem paths,
 * hardware device IDs, base URLs, and global shortcuts stay in localStorage.
 */
/**
 * Sound effect toggles. Each event can independently play/mute a sound.
 * Manual = user-initiated recording. VAD = voice activity detection.
 */
const sound = {
	'sound.manualStart': defineKv(field.boolean(), () => true),
	'sound.manualStop': defineKv(field.boolean(), () => true),
	'sound.manualCancel': defineKv(field.boolean(), () => true),
	'sound.vadStart': defineKv(field.boolean(), () => true),
	'sound.vadCapture': defineKv(field.boolean(), () => true),
	'sound.vadStop': defineKv(field.boolean(), () => true),
	'sound.transcriptionComplete': defineKv(field.boolean(), () => true),
	'sound.transformationComplete': defineKv(field.boolean(), () => true),
} as const;

/**
 * Output behavior after transcription/transformation completes.
 * Controls clipboard, cursor paste, and simulated Enter key per pipeline stage.
 *
 * Uses `output.*` prefix to separate post-processing behavior from service
 * configuration: avoids polluting `transcription.*` and `transformation.*`
 * namespaces with unrelated concerns.
 *
 * Clipboard is the permission-free default; cursor paste is opt-in. Pasting at
 * the cursor synthesizes a Cmd/Ctrl+V keystroke (`write_text` -> enigo), and on
 * macOS injecting keystrokes into another app requires Accessibility. So both
 * cursor defaults are `false`: out of the box the transcript lands on the
 * clipboard (no permission, works on first launch) and the user pastes it.
 * Turning cursor paste on is the deliberate step that asks for Accessibility.
 * Transformation cursor also stays off so it cannot double-type over a
 * transcription that already pasted itself once a user turns both on.
 */
const output = {
	'output.transcription.clipboard': defineKv(field.boolean(), () => true),
	'output.transcription.cursor': defineKv(field.boolean(), () => false),
	'output.transcription.enter': defineKv(field.boolean(), () => false),
	'output.transformation.clipboard': defineKv(field.boolean(), () => true),
	'output.transformation.cursor': defineKv(field.boolean(), () => false),
	'output.transformation.enter': defineKv(field.boolean(), () => false),
} as const;

/**
 * Recording retention policy. `retention.strategy` is the source of truth for
 * how many recordings to keep: `keep-forever` (all), `limit-count` (the newest
 * `maxCount`), or `keep-none` (zero). `maxCount` only applies under
 * `limit-count`; it stays `>= 1` so the original "0 means never save" overload
 * can never be persisted again. "Keep zero" lives in the strategy enum, not in
 * a sentinel count: `keep-none` maps to a runtime count of 0 without storing 0.
 */
const dataRetention = {
	'retention.strategy': defineKv(
		field.select(['keep-forever', 'limit-count', 'keep-none']),
		() => 'keep-forever' as const,
	),
	'retention.maxCount': defineKv(field.integer({ minimum: 1 }), () => 100),
} as const;

/**
 * How the microphone starts capturing: manual trigger vs voice activity
 * detection. File import is a separate surface, not a trigger, so it is not a
 * value here.
 */
const recording = {
	'recording.trigger': defineKv(
		field.select(RECORDING_TRIGGERS),
		() => 'manual' as const,
	),
	// Pause system media playback while your voice is being captured, resume it
	// after. On by default: hearing music while you talk disrupts dictation, and
	// pausing media during voice capture is the least-astonishing behavior (it is
	// what a phone call does to your music). Discoverable without a nudge via the
	// settings toggle's description and the home-row quick toggle. A roaming
	// preference, not a per-device capability, so it follows you across machines
	// like the sound toggles.
	'recording.pausePlayback': defineKv(field.boolean(), () => true),
} as const;

/**
 * Transcription service and per-service model selections.
 *
 * Each service's model is its own KV entry so switching from OpenAI to Groq and
 * back preserves your OpenAI model choice.
 *
 * @see {@link https://github.com/EpicenterHQ/epicenter/blob/main/specs/20260312T170000-whispering-workspace-polish-and-migration.md | Spec Decision 2}
 */
function defineTranscriptionSettings(
	defaultTranscriptionService: TranscriptionServiceId,
) {
	return {
		'transcription.service': defineKv(
			field.select(TRANSCRIPTION_SERVICE_IDS),
			() => defaultTranscriptionService,
		),
		'transcription.openai.model': defineKv(
			field.string(),
			() => PROVIDERS.OpenAI.defaultModel as string,
		),
		'transcription.groq.model': defineKv(
			field.string(),
			() => PROVIDERS.Groq.defaultModel as string,
		),
		'transcription.elevenlabs.model': defineKv(
			field.string(),
			() => PROVIDERS.ElevenLabs.defaultModel as string,
		),
		'transcription.deepgram.model': defineKv(
			field.string(),
			() => PROVIDERS.Deepgram.defaultModel as string,
		),
		'transcription.mistral.model': defineKv(
			field.string(),
			() => PROVIDERS.Mistral.defaultModel as string,
		),
		'transcription.language': defineKv(field.string(), () => 'auto'),
		'transcription.prompt': defineKv(field.string(), () => ''),
	} as const;
}

/**
 * Currently active transformation, used as the dictation default.
 *
 * `selectedId`: FK to `transformations` table. `null` = no transformation selected.
 */
const transformation = {
	'transformation.selectedId': defineKv(
		nullable(field.string()),
		(): string | null => null,
	),
} as const;

/** Anonymized event logging toggle (Aptabase). */
const analytics = {
	'analytics.enabled': defineKv(field.boolean(), () => true),
} as const;

/**
 * In-app keyboard shortcuts. System-global shortcuts are device-specific and stay
 * in localStorage: these are only the shortcuts within the Whispering window.
 * `null` = unbound.
 */
const shortcuts = {
	// These getDefault thunks are the single source for the in-app shortcut
	// defaults. The web backend (platform/shortcuts.browser.ts) reads them back
	// through `settings.getDefault('shortcut.*')` instead of redeclaring them, so
	// the schema and the backend can never drift. Values are the readable manual
	// grammar (`parseManualBinding`): `'space'`, `'c'`, `'ctrl+shift+a'`. The cell
	// stays `field.string()`, so this is a value re-spelling, not a migration; a
	// stale logical value (e.g. a stored `' '`) fails the parse and reads as unset.
	//
	// Push-to-talk ships unbound in-app: a stray Space-style tap would fire
	// start+immediate-stop and feed a junk recording to the pipeline, so the safe
	// in-app default is the toggle below.
	'shortcut.pushToTalk': defineKv(
		nullable(field.string()),
		(): string | null => null,
	),
	'shortcut.toggleManualRecording': defineKv(
		nullable(field.string()),
		(): string | null => 'space',
	),
	// Renamed from `shortcut.cancelManualRecording` (cancel now aborts manual or
	// VAD capture, so the "manual" qualifier is gone). No migration: pre-release,
	// the old key is simply orphaned and this falls back to its default.
	'shortcut.cancelRecording': defineKv(
		nullable(field.string()),
		(): string | null => 'c',
	),
	'shortcut.toggleVadRecording': defineKv(
		nullable(field.string()),
		(): string | null => 'v',
	),
	'shortcut.openTransformationPicker': defineKv(
		nullable(field.string()),
		(): string | null => 't',
	),
	'shortcut.runTransformationOnClipboard': defineKv(
		nullable(field.string()),
		(): string | null => 'r',
	),
} as const;

type CreateWhisperingOptions = {
	defaultTranscriptionService?: TranscriptionServiceId;
};

export function createWhispering({
	defaultTranscriptionService = 'parakeet',
}: CreateWhisperingOptions = {}) {
	/**
	 * Whispering KV schemas: ~40 entries for synced preferences. Defined locally
	 * so the raw schema map is not a module-level export. Callers reach the
	 * defaults and key list through the `settings` namespace on the returned
	 * workspace bundle.
	 */
	const kvDefinitions = {
		...sound,
		...output,
		...dataRetention,
		...recording,
		...defineTranscriptionSettings(defaultTranscriptionService),
		...transformation,
		...analytics,
		...shortcuts,
	};
	type SettingKey = keyof typeof kvDefinitions & string;

	const workspace = createWorkspace({
		// Workspace/Y.Doc identity, not an OAuth client id or Tauri bundle id.
		// This keys local storage and cloud rooms; change only with a data migration.
		id: 'epicenter-whispering',
		tables: {
			recordings,
			transformations,
			transformationRuns,
		},
		kv: kvDefinitions,
	});

	const settingKeys = Object.keys(kvDefinitions) as SettingKey[];

	return satisfiesWorkspace({
		...workspace,
		/**
		 * Synced setting metadata for the Whispering workspace.
		 *
		 * Owns the KV schema map: callers never see the raw `defineKv` definitions.
		 * Use `kv.get`/`kv.set`/`kv.observeAll` for live values; reach for `settings`
		 * for the key list, per-key defaults, and the bulk reset.
		 */
		settings: {
			/** Every synced setting key, in declaration order. */
			keys: settingKeys,
			/** Return the default value for a setting key (factory-evaluated). */
			getDefault<K extends SettingKey>(
				key: K,
			): InferKvValue<(typeof kvDefinitions)[K]> {
				return kvDefinitions[key].defaultValue() as InferKvValue<
					(typeof kvDefinitions)[K]
				>;
			},
			/**
			 * Reset every synced workspace setting to its default in a single Yjs
			 * transaction (one `observeAll` firing, not one per key).
			 */
			reset(): void {
				workspace.ydoc.transact(() => {
					for (const key of settingKeys) {
						(workspace.kv.set as (key: string, value: unknown) => void)(
							key,
							kvDefinitions[key].defaultValue(),
						);
					}
				});
			},
		},
	});
}
