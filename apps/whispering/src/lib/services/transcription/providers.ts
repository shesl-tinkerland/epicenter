/**
 * The single source of truth for transcription providers. One entry per
 * provider owns every fact: label, location, models, capabilities, and the
 * deviceConfig/settings key NAMES used to read its config (never the values,
 * which the dispatcher in `operations/transcribe.ts` reads).
 *
 * Pointer-field naming: the suffix names the store. A `*ConfigKey` field
 * holds the name of a `deviceConfig` entry (device-local, never synced); a
 * `*SettingKey` field holds the name of a `settings` entry (synced workspace
 * KV). Dispatchers resolve the pointer against the matching store.
 *
 * Behavior is deliberately not here. The `id -> transcribe` wiring lives as a
 * static table in the dispatcher, where the provider SDKs already load. That
 * keeps this record free of SDK imports so the workspace schema can import
 * `TRANSCRIPTION_SERVICE_IDS` without bundling them. Icons and the UI-facing
 * join live in `./provider-ui.ts` (icons being the one field heavy enough to
 * pollute that import).
 */
import type { DeviceConfigKey } from '$lib/state/device-config.svelte';

type Capabilities = { supportsPrompt: boolean; supportsLanguage: boolean };
type CloudModel = { name: string; description: string; cost: string };

type CloudProvider = {
	location: 'cloud';
	label: string;
	description: string;
	capabilities: Capabilities;
	models: readonly CloudModel[];
	defaultModel: string;
	apiKeyConfigKey: DeviceConfigKey;
	/**
	 * The settings key holding this provider's model selection. Constrained to
	 * the leaf shape `transcription.${string}.model`, not a precise union of the
	 * cloud keys: a precise union here would make `typeof PROVIDERS` reference a
	 * type derived from itself (`satisfies Record<..., TranscriptionProvider>`
	 * closes the loop). The real guard is the call site
	 * `settings.get(provider.modelSettingKey)`, which rejects keys absent from
	 * the settings schema.
	 */
	modelSettingKey: `transcription.${string}.model`;
	/** Device config key for the endpoint override; null when not configurable. */
	endpointConfigKey: DeviceConfigKey | null;
	/**
	 * Where this provider documents its transcription models; null when the
	 * provider has no good page to link. The settings page renders this under
	 * the model picker.
	 */
	modelsDoc: { label: string; href: string } | null;
};

type LocalProvider = {
	location: 'local';
	label: string;
	description: string;
	capabilities: Capabilities;
	/**
	 * The device config key holding the engine's selected model: a folder
	 * entry name inside the engine's models folder, never a path.
	 */
	modelConfigKey: DeviceConfigKey;
	/** Whether the engine's model is a single file or a directory. */
	modelKind: 'file' | 'directory';
};

type SelfHostedProvider = {
	location: 'self-hosted';
	label: string;
	description: string;
	capabilities: Capabilities;
	endpointConfigKey: DeviceConfigKey;
	modelIdConfigKey: DeviceConfigKey;
};

type TranscriptionProvider = CloudProvider | LocalProvider | SelfHostedProvider;

export const PROVIDERS = {
	OpenAI: {
		location: 'cloud',
		label: 'OpenAI',
		description: 'Industry-standard Whisper API',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.openai.apiKey',
		modelSettingKey: 'transcription.openai.model',
		endpointConfigKey: 'providers.openai.endpoint',
		modelsDoc: {
			label: 'OpenAI docs',
			href: 'https://platform.openai.com/docs/guides/speech-to-text',
		},
		defaultModel: 'whisper-1',
		models: [
			{
				name: 'whisper-1',
				description:
					"OpenAI's flagship speech-to-text model with multilingual support. Reliable and accurate transcription for a wide variety of use cases.",
				cost: '$0.36/hour',
			},
			{
				name: 'gpt-4o-transcribe',
				description:
					'GPT-4o powered transcription with enhanced understanding and context. Best for complex audio requiring deep comprehension.',
				cost: '$0.36/hour',
			},
			{
				name: 'gpt-4o-mini-transcribe',
				description:
					'Cost-effective GPT-4o mini transcription model. Good balance of performance and cost for standard transcription needs.',
				cost: '$0.18/hour',
			},
		],
	},
	Groq: {
		location: 'cloud',
		label: 'Groq',
		description: 'Lightning-fast cloud transcription',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.groq.apiKey',
		modelSettingKey: 'transcription.groq.model',
		endpointConfigKey: 'providers.groq.endpoint',
		modelsDoc: {
			label: 'Groq docs',
			href: 'https://console.groq.com/docs/speech-to-text',
		},
		defaultModel: 'whisper-large-v3-turbo',
		models: [
			{
				name: 'whisper-large-v3',
				description:
					'Best accuracy (10.3% WER) and full multilingual support, including translation. Recommended for error-sensitive applications requiring multilingual support.',
				cost: '$0.111/hour',
			},
			{
				name: 'whisper-large-v3-turbo',
				description:
					'Fast multilingual model with good accuracy (12% WER). Best price-to-performance ratio for multilingual applications.',
				cost: '$0.04/hour',
			},
		],
	},
	ElevenLabs: {
		location: 'cloud',
		label: 'ElevenLabs',
		description: 'Voice AI platform with transcription',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.elevenlabs.apiKey',
		endpointConfigKey: null,
		modelSettingKey: 'transcription.elevenlabs.model',
		modelsDoc: {
			label: 'ElevenLabs docs',
			href: 'https://elevenlabs.io/docs/capabilities/speech-to-text',
		},
		defaultModel: 'scribe_v2',
		models: [
			{
				name: 'scribe_v2',
				description:
					'Latest flagship transcription model with 97% accuracy. Features speaker diarization (up to 48 speakers), entity detection, keyterm prompting, and dynamic audio tagging across 90+ languages.',
				cost: '$0.40/hour',
			},
			{
				name: 'scribe_v1',
				description:
					'Previous generation transcription model with 96.7% accuracy for English. Supports 99 languages with word-level timestamps and speaker diarization.',
				cost: '$0.40/hour',
			},
			{
				name: 'scribe_v1_experimental',
				description:
					'Experimental version of Scribe with latest features and improvements. May include cutting-edge capabilities but with potential instability.',
				cost: '$0.40/hour',
			},
		],
	},
	Deepgram: {
		location: 'cloud',
		label: 'Deepgram',
		description: 'Real-time speech recognition API',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.deepgram.apiKey',
		endpointConfigKey: null,
		modelSettingKey: 'transcription.deepgram.model',
		modelsDoc: null,
		defaultModel: 'nova-3',
		models: [
			{
				name: 'nova-3',
				description:
					"Deepgram's most advanced speech-to-text model with superior accuracy and speed. Best for high-quality transcription needs.",
				cost: '$0.0043/minute',
			},
			{
				name: 'nova-2',
				description: "Deepgram's previous best speech-to-text model.",
				cost: '$0.0043/minute',
			},
			{
				name: 'nova',
				description:
					'Deepgram Nova model with excellent accuracy and performance. Good balance of speed and quality.',
				cost: '$0.0043/minute',
			},
			{
				name: 'enhanced',
				description:
					'Enhanced general-purpose model with good accuracy for most use cases. Cost-effective option.',
				cost: '$0.0025/minute',
			},
			{
				name: 'base',
				description:
					'Base model for standard transcription needs. Most cost-effective option with reasonable accuracy.',
				cost: '$0.0020/minute',
			},
		],
	},
	Mistral: {
		location: 'cloud',
		label: 'Mistral AI',
		description: 'Advanced Voxtral speech understanding',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		apiKeyConfigKey: 'providers.mistral.apiKey',
		endpointConfigKey: null,
		modelSettingKey: 'transcription.mistral.model',
		modelsDoc: {
			label: 'Mistral docs',
			href: 'https://mistral.ai/news/voxtral/',
		},
		defaultModel: 'voxtral-mini-latest',
		models: [
			{
				name: 'voxtral-mini-latest',
				description:
					'API-optimized Voxtral Mini model delivering unparalleled cost and latency efficiency. Supports multilingual transcription with high accuracy.',
				cost: '$0.12/hour',
			},
			{
				name: 'voxtral-small-latest',
				description:
					'Voxtral Small model for higher accuracy and broader language support. Suitable for most transcription needs with a balance of cost and performance.',
				cost: '$0.24/hour',
			},
		],
	},

	whispercpp: {
		location: 'local',
		label: 'Whisper C++',
		description: 'Fast local transcription with no internet required',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		modelConfigKey: 'transcription.whispercpp.model',
		modelKind: 'file',
	},
	parakeet: {
		location: 'local',
		label: 'Parakeet',
		description:
			'Recommended fast local transcription with automatic language detection',
		capabilities: { supportsPrompt: false, supportsLanguage: false },
		modelConfigKey: 'transcription.parakeet.model',
		modelKind: 'directory',
	},
	moonshine: {
		location: 'local',
		label: 'Moonshine',
		description: 'Small English-only local transcription',
		capabilities: { supportsPrompt: false, supportsLanguage: false },
		modelConfigKey: 'transcription.moonshine.model',
		modelKind: 'directory',
	},

	speaches: {
		location: 'self-hosted',
		label: 'Speaches',
		description: 'Self-hosted transcription server',
		capabilities: { supportsPrompt: true, supportsLanguage: true },
		endpointConfigKey: 'providers.speaches.endpoint',
		modelIdConfigKey: 'providers.speaches.modelId',
	},
} as const satisfies Record<string, TranscriptionProvider>;

export type TranscriptionServiceId = keyof typeof PROVIDERS;

/**
 * The ids of cloud providers, derived from PROVIDERS. The dispatch table in
 * `operations/transcribe.ts` is `satisfies Record<CloudProviderId, ...>`, so
 * adding a cloud provider here without a transcriber there is a compile error.
 */
export type CloudProviderId = {
	[K in TranscriptionServiceId]: (typeof PROVIDERS)[K]['location'] extends 'cloud'
		? K
		: never;
}[TranscriptionServiceId];

/**
 * The ids of local engines, derived the same way. `isLocalProviderId` is the
 * one narrowing boundary callers use before reading local-only fields or
 * touching the engine's models folder.
 */
export type LocalProviderId = {
	[K in TranscriptionServiceId]: (typeof PROVIDERS)[K]['location'] extends 'local'
		? K
		: never;
}[TranscriptionServiceId];

export function isLocalProviderId(
	id: TranscriptionServiceId,
): id is LocalProviderId {
	return PROVIDERS[id].location === 'local';
}

/** Every provider ID, e.g. for `field.select(TRANSCRIPTION_SERVICE_IDS)`. */
export const TRANSCRIPTION_SERVICE_IDS = Object.keys(
	PROVIDERS,
) as TranscriptionServiceId[];
