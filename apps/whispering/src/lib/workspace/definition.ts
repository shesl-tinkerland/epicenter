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

import { RECORDING_MODES } from '$lib/constants/audio/recording-modes';
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
	// The raw transcript, exactly as the transcriber produced it. Cleanup (Wave 2)
	// layers correction on top and delivers the cleaned text, but the raw words
	// stay here underneath so "show original" is always one click away. See
	// ADR 0013.
	transcript: field.string(),
	duration: nullable(field.number()),
	transcription: nullable(field.json(TranscriptionOutcome)),
});

/** Recording row type inferred from the workspace table schema. */
export type Recording = InferTableRow<typeof recordings>;

/**
 * A reusable text action: a name and a single instruction, run on demand over
 * whatever text the host hands it (text in, text out). Formats are the portable,
 * plural, always-picked half of the old `Transformation` split: they know
 * nothing about voice and carry no correction plumbing (that is Cleanup's job,
 * run once before any Format). See ADR 0013.
 *
 * Deliberately tiny: no pre/post replacements, no system/user prompt split, no
 * `{{input}}` placeholder, no per-Format model or provider (model comes from the
 * global `completion.*` default). `icon` is optional; null until one is assigned.
 */
const formats = defineTable({
	id: field.string(),
	name: field.string(),
	instructions: field.string(),
	icon: nullable(field.string()),
});

/** Format row type inferred from the workspace table schema. */
export type Format = InferTableRow<typeof formats>;

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
	'sound.pauseMediaDuringRecording': defineKv(field.boolean(), () => false),
} as const;

/**
 * Output behavior after transcription/transformation completes.
 * Controls clipboard, cursor paste, and simulated Enter key per pipeline stage.
 *
 * Uses `output.*` prefix to separate post-processing behavior from service
 * configuration: avoids polluting `transcription.*` and `transformation.*`
 * namespaces with unrelated concerns.
 *
 * Cursor default asymmetry (transcription=true, transformation=false): when a
 * transformation runs on the just-finished transcription, the transcription
 * has already typed itself at the cursor. Defaulting transformation.cursor to
 * true would double-type. Users who turn off transcription.cursor specifically
 * to let the transformation be the cursor output can flip the transformation
 * toggle on.
 */
const output = {
	'output.transcription.clipboard': defineKv(field.boolean(), () => true),
	'output.transcription.cursor': defineKv(field.boolean(), () => true),
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

/** User's preferred recording mode: manual trigger vs voice activity detection. */
const recording = {
	'recording.mode': defineKv(
		field.select(RECORDING_MODES),
		() => 'manual' as const,
	),
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
 * One dictionary entry: a deterministic spelling fix for the one thing AI cannot
 * reliably get right, proper nouns and domain terms ("brayden" -> "Braden").
 * `spell: ""` removes the matched text. `regex` and `wholeWord` are advanced
 * matching modes; both default to off (literal, anywhere).
 */
const DictionaryEntry = Type.Object({
	heard: Type.String(),
	spell: Type.String(),
	regex: Type.Optional(Type.Boolean()),
	wholeWord: Type.Optional(Type.Boolean()),
});

/** A single Cleanup dictionary entry. */
export type DictionaryEntry = Static<typeof DictionaryEntry>;

/**
 * The auto-cleanup tidy pass: one optional AI call that makes every transcript
 * correct. A discriminated union so `instructions` only exists when enabled.
 * Ships enabled; the median user never opens its instructions.
 */
const AutoCleanup = Type.Union([
	Type.Object({
		enabled: Type.Literal(true),
		instructions: Type.String(),
	}),
	Type.Object({
		enabled: Type.Literal(false),
	}),
]);

/** Auto-cleanup config: enabled with editable instructions, or disabled. */
export type AutoCleanup = Static<typeof AutoCleanup>;

/** Default tidy instruction. Kept faithful: fix mechanics, preserve wording. */
const DEFAULT_AUTO_CLEANUP_INSTRUCTIONS =
	'Fix grammar and punctuation. Keep my wording.';

/**
 * Cleanup: the singular, automatic correction layer that runs after every
 * transcription (Wave 2 wires the post-transcription path). Two mechanisms, an
 * optional `autoCleanup` AI tidy pass and a deterministic `dictionary`. Cleanup
 * is dictation-specific: it is automatic because voice input is noisy. See
 * ADR 0013.
 */
const cleanup = {
	'cleanup.autoCleanup': defineKv(
		AutoCleanup,
		(): Static<typeof AutoCleanup> => ({
			enabled: true,
			instructions: DEFAULT_AUTO_CLEANUP_INSTRUCTIONS,
		}),
	),
	'cleanup.dictionary': defineKv(
		Type.Array(DictionaryEntry),
		(): Static<typeof DictionaryEntry>[] => [],
	),
} as const;

/**
 * The single global AI default used for completions: which inference provider
 * and model the auto-cleanup pass and every Format run against. Per ADR 0013
 * there is no per-Format model or provider; this is the one place it lives. API
 * keys and endpoints stay in deviceConfig (local, never synced).
 */
const completion = {
	'completion.provider': defineKv(
		field.select(INFERENCE_PROVIDER_IDS),
		() => 'Google' as const,
	),
	'completion.model': defineKv(field.string(), () => 'gemini-2.5-flash'),
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
	// the schema and the backend can never drift.
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
		(): string | null => ' ',
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
		...cleanup,
		...completion,
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
			formats,
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
