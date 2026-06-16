import { InstantString } from '@epicenter/field';
import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, isErr, Ok, type Result } from 'wellcrafted/result';
import type { InferenceProviderId } from '$lib/constants/inference';
import { services } from '$lib/services';
import type {
	DeviceConfigKey,
	SecretKey,
} from '$lib/state/device-config.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { secrets } from '$lib/state/secrets.svelte';
import { transformationRuns } from '$lib/state/transformation-runs.svelte';
import { transformationHasWork } from '$lib/state/transformations.svelte';
import { asTemplateString, interpolateTemplate } from '$lib/utils/template';
import type {
	Replacement,
	Transformation,
	TransformationPrompt,
	TransformationRun,
} from '$lib/workspace';

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
		/** The provider's API key: a secret, routed through `secrets.get`. */
		apiKeyConfigKey: SecretKey;
		/** Device config key for the endpoint; null when not configurable. */
		endpointConfigKey: DeviceConfigKey | null;
	}
>;

/**
 * The deviceConfig keys a provider reads. Exposed so the editor can warn when the
 * credential a transformation needs is missing, instead of failing only at run
 * time. These live in deviceConfig (local, never synced); no sign-in required to
 * use your own key.
 */
export function getProviderConfigKeys(provider: InferenceProviderId): {
	apiKeyConfigKey: SecretKey;
	endpointConfigKey: DeviceConfigKey | null;
} {
	const { apiKeyConfigKey, endpointConfigKey } = COMPLETION_PROVIDERS[provider];
	return { apiKeyConfigKey, endpointConfigKey };
}

export const TransformError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	Empty: ({ message }: { message: string }) => ({ message }),
	ReplacementFailed: ({ message }: { message: string }) => ({ message }),
	PromptFailed: ({ message }: { message: string }) => ({ message }),
});
export type TransformError = InferErrors<typeof TransformError>;

/**
 * Apply a list of deterministic find/replace pairs in order. Offline, no API
 * key. A bad regex fails the whole phase with the pattern in the message.
 */
function applyReplacements(
	input: string,
	replacements: Replacement[],
): Result<string, string> {
	let text = input;
	for (const { find, replace, useRegex } of replacements) {
		if (useRegex) {
			try {
				text = text.replace(new RegExp(find, 'g'), replace);
			} catch (error) {
				return Err(`Invalid regex pattern: ${extractErrorMessage(error)}`);
			}
		} else {
			text = text.replaceAll(find, replace);
		}
	}
	return Ok(text);
}

/**
 * Run the one optional AI phase: interpolate the templates with `{{input}}`,
 * then call the prompt's backend with its model. Keys, model names, and URLs are
 * pasted strings, so trim once here: a trailing space fails the request opaquely.
 */
async function runPrompt(
	input: string,
	prompt: TransformationPrompt,
): Promise<Result<string, { message: string }>> {
	const systemPrompt = interpolateTemplate(
		asTemplateString(prompt.systemPromptTemplate),
		{ input },
	);
	const userPrompt = interpolateTemplate(
		asTemplateString(prompt.userPromptTemplate),
		{ input },
	);

	const config = COMPLETION_PROVIDERS[prompt.inferenceProvider];

	// The API key is a secret: read it from the credential facade, which routes to
	// the device or the (locked) vault. A missing or locked key is a user-actionable
	// failure raised here, before the provider runs with a blank key. `locked` is
	// unreachable until the account-aware vault sync wave ships its lifecycle UI;
	// handled now so this call site already covers every read state.
	const apiKey = secrets.get(config.apiKeyConfigKey);
	if (apiKey.status === 'missing') {
		return Err({
			message: `Add your ${prompt.inferenceProvider} API key in settings.`,
		});
	}
	if (apiKey.status === 'locked') {
		return Err({
			message: `Unlock your secret vault to use ${prompt.inferenceProvider}.`,
		});
	}

	return config.service.complete({
		apiKey: apiKey.value.trim(),
		model: prompt.model.trim(),
		baseUrl: config.endpointConfigKey
			? deviceConfig.get(config.endpointConfigKey).trim() || undefined
			: undefined,
		systemPrompt,
		userPrompt,
	});
}

/**
 * The guard both entry points share: a run needs non-empty input and a
 * transformation with at least one phase (the runnable invariant). Returns the
 * matching error, or null when the run may proceed. `runTransformation` calls it
 * before any write so a run that can't legitimately start leaves no record.
 */
function checkRunnable(
	input: string,
	transformation: Transformation,
): Result<never, TransformError> | null {
	if (!input.trim()) {
		return TransformError.InvalidInput({
			message: 'Empty input. Please enter some text to transform',
		});
	}
	if (!transformationHasWork(transformation)) {
		return TransformError.Empty({
			message:
				'This transformation has nothing to run. Add a replacement or a prompt',
		});
	}
	return null;
}

/**
 * Execute a transformation's three phases against `input` and return the output:
 * deterministic `preReplacements`, then the optional `prompt`, then deterministic
 * `postReplacements`. Pure execution: no workspace writes, no persistence, no
 * toasts. Validates the runnable invariant up front so direct callers (the
 * candidate fan-out) get the same guards as a persisted run.
 */
export async function executeTransformation({
	input,
	transformation,
}: {
	input: string;
	transformation: Transformation;
}): Promise<Result<string, TransformError>> {
	const guard = checkRunnable(input, transformation);
	if (guard) return guard;

	const { preReplacements, prompt, postReplacements } = transformation;

	const preResult = applyReplacements(input, preReplacements);
	if (isErr(preResult)) {
		return TransformError.ReplacementFailed({ message: preResult.error });
	}
	let current = preResult.data;

	if (prompt) {
		const promptResult = await runPrompt(current, prompt);
		if (isErr(promptResult)) {
			return TransformError.PromptFailed({
				message: extractErrorMessage(promptResult.error),
			});
		}
		current = promptResult.data;
	}

	const postResult = applyReplacements(current, postReplacements);
	if (isErr(postResult)) {
		return TransformError.ReplacementFailed({ message: postResult.error });
	}
	return Ok(postResult.data);
}

/**
 * Run a transformation and persist its run record. Persists at kickoff (with
 * `result: null`) and again on the terminal outcome (including failure); liveness
 * is derived from `startedAt`, never stored. Execution is delegated to
 * `executeTransformation`; this wrapper owns only the persistence. The returned
 * Result is purely for caller control flow. No toasts, no notifications.
 */
export async function runTransformation({
	input,
	transformation,
	recordingId,
}: {
	input: string;
	transformation: Transformation;
	recordingId: string | null;
}): Promise<Result<string, TransformError>> {
	// Don't leave a run record for a run that can't legitimately start.
	const guard = checkRunnable(input, transformation);
	if (guard) return guard;

	const transformationRun = {
		id: nanoid(),
		transformationId: transformation.id,
		recordingId,
		input,
		startedAt: InstantString.now(),
		result: null,
	} satisfies TransformationRun;
	transformationRuns.set(transformationRun);

	// A thrown provider or execution error must still land as a failed terminal
	// result. Without this, a throw escapes past the persistence below and the
	// kickoff row stays stuck at `result: null`, so the run reads as forever
	// running. Normalize any throw into an Err the failure branch records.
	let result: Result<string, TransformError>;
	try {
		result = await executeTransformation({ input, transformation });
	} catch (error) {
		result = TransformError.PromptFailed({
			message: extractErrorMessage(error),
		});
	}

	if (isErr(result)) {
		transformationRuns.set({
			...transformationRun,
			result: {
				status: 'failed',
				completedAt: InstantString.now(),
				error: result.error.message,
			},
		} satisfies TransformationRun);
		return result;
	}

	transformationRuns.set({
		...transformationRun,
		result: {
			status: 'completed',
			completedAt: InstantString.now(),
			output: result.data,
		},
	} satisfies TransformationRun);
	return result;
}

/**
 * Persist a single completed ad-hoc run (`recordingId: null`). The commit-time
 * counterpart to `runTransformation`: instead of a kickoff row plus a terminal
 * write, an ad-hoc run owns nothing until it succeeds, so this writes exactly one
 * completed row, never a kickoff, failed, or interrupted one. Used by the picker
 * accept and the clipboard quick-run, both of which run via `executeTransformation`
 * (no writes) and commit only the chosen result. `startedAt` is when execution
 * began; the result is terminal, so no liveness is ever derived from it.
 */
export function persistCompletedRun({
	transformationId,
	input,
	output,
	startedAt,
}: {
	transformationId: string;
	input: string;
	output: string;
	startedAt: InstantString;
}): void {
	transformationRuns.set({
		id: nanoid(),
		transformationId,
		recordingId: null,
		input,
		startedAt,
		result: {
			status: 'completed',
			completedAt: InstantString.now(),
			output,
		},
	} satisfies TransformationRun);
}
