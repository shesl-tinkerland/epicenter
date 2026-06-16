import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { isErr, Ok, type Result } from 'wellcrafted/result';
import type { InferenceProviderId } from '$lib/constants/inference';
import { services } from '$lib/services';
import type { DeviceConfigKey } from '$lib/state/device-config.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { Format } from '$lib/workspace';

/**
 * Config map for completion providers, all sharing the
 * `{ apiKey, model, baseUrl?, systemPrompt, userPrompt }` call signature.
 * Exhaustive over InferenceProviderId: adding a provider to INFERENCE is a
 * compile error here until its entry exists. The custom service owns the
 * "endpoint is required" invariant via its validateParams. `*ConfigKey`
 * fields hold deviceConfig key names, same convention as the transcription
 * registry in `services/transcription/providers.ts`.
 */
const COMPLETION_PROVIDERS = {
	OpenAI: {
		service: services.completions.openai,
		apiKeyConfigKey: 'providers.openai.apiKey',
		endpointConfigKey: 'providers.openai.endpoint',
	},
	Groq: {
		service: services.completions.groq,
		apiKeyConfigKey: 'providers.groq.apiKey',
		endpointConfigKey: 'providers.groq.endpoint',
	},
	Anthropic: {
		service: services.completions.anthropic,
		apiKeyConfigKey: 'providers.anthropic.apiKey',
		endpointConfigKey: null,
	},
	Google: {
		service: services.completions.google,
		apiKeyConfigKey: 'providers.google.apiKey',
		endpointConfigKey: null,
	},
	OpenRouter: {
		service: services.completions.openrouter,
		apiKeyConfigKey: 'providers.openrouter.apiKey',
		endpointConfigKey: null,
	},
	Custom: {
		service: services.completions.custom,
		apiKeyConfigKey: 'providers.custom.apiKey',
		endpointConfigKey: 'providers.custom.endpoint',
	},
} as const satisfies Record<
	InferenceProviderId,
	{
		service: {
			complete: (opts: {
				apiKey: string;
				model: string;
				systemPrompt: string;
				userPrompt: string;
				baseUrl?: string;
			}) => Promise<Result<string, { message: string }>>;
		};
		apiKeyConfigKey: DeviceConfigKey;
		/** Device config key for the endpoint; null when not configurable. */
		endpointConfigKey: DeviceConfigKey | null;
	}
>;

export const RunFormatError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	Empty: ({ message }: { message: string }) => ({ message }),
	Failed: ({ message }: { message: string }) => ({ message }),
});
export type RunFormatError = InferErrors<typeof RunFormatError>;

/**
 * Run one Format over `input` and return its take: a single AI call whose
 * directive is `format.instructions` and whose content is `input`. Text in,
 * text out, nothing else: no pre/post replacements, no `{{input}}` template, no
 * per-Format model. Correction (Cleanup) has already run upstream, so `input`
 * is the corrected text and this never re-does cleanup.
 *
 * Provider and model come from the single global `completion.*` default, not
 * from the Format. Keys, model names, and endpoints are pasted strings, so trim
 * once here: a trailing space fails the request opaquely.
 *
 * Pure execution: no workspace writes, no persistence, no toasts. The picker
 * (Wave 3) is the caller; it owns delivery and any history bookkeeping.
 */
export async function run({
	input,
	format,
}: {
	input: string;
	format: Format;
}): Promise<Result<string, RunFormatError>> {
	if (!input.trim()) {
		return RunFormatError.InvalidInput({
			message: 'Empty input. Please enter some text to run a format on.',
		});
	}
	if (!format.instructions.trim()) {
		return RunFormatError.Empty({
			message: 'This format has no instructions. Add an instruction to run it.',
		});
	}

	const provider = settings.get('completion.provider');
	const model = settings.get('completion.model');
	const config = COMPLETION_PROVIDERS[provider];

	const result = await config.service.complete({
		apiKey: deviceConfig.get(config.apiKeyConfigKey).trim(),
		model: model.trim(),
		baseUrl: config.endpointConfigKey
			? deviceConfig.get(config.endpointConfigKey).trim() || undefined
			: undefined,
		systemPrompt: format.instructions,
		userPrompt: input,
	});

	if (isErr(result)) {
		return RunFormatError.Failed({
			message: extractErrorMessage(result.error),
		});
	}
	return Ok(result.data);
}
