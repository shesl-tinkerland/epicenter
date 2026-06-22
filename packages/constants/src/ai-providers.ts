/**
 * AI provider registry and model catalog for hosted chat.
 *
 * `AI_MODELS` is the single source of the live provider vocabulary: `AiProvider`
 * is derived from it, and `AI_PROVIDERS` must carry a label for every provider
 * it serves, enforced at compile time. There is no separate durable provider
 * registry: a provider retired from the catalog drops out of the vocabulary, and
 * `providerLabel` degrades its historical id to raw text at the render edge
 * rather than throwing. The model id is a free string: the OpenAI-compatible
 * gateway (ADR-0050) owns routing, so a model the backend cannot serve is a
 * runtime gateway error, not a compile error here. This catalog is the single
 * source of which ids we sell and what each costs.
 */

/**
 * One sellable model. `label` is the product role shown in the picker (Fast,
 * Best), not a vendor name. `provider` tags the gateway lane the id routes to;
 * the catalog literal pins `id`, `provider`, and `credits` together, so a model
 * is described in exactly one place.
 */
export type AiModel = {
	id: string;
	provider: 'openai' | 'gemini';
	label: string;
	credits: number;
};

/** A provider the live catalog serves. Derived from the model union, so
 *  `AI_MODELS` is the single source of the provider vocabulary. */
export type AiProvider = AiModel['provider'];

/**
 * Vendor display names, keyed by provider id. `satisfies Record<AiProvider>`
 * forces a label for every live provider: add a provider to the catalog and
 * forget its label here, and this stops compiling at the missing key. Internal:
 * callers resolve a label through `providerLabel`, which tolerates ids this code
 * does not recognize, so a stray historical id degrades to one literal cell.
 */
const AI_PROVIDERS = {
	openai: { label: 'OpenAI' },
	gemini: { label: 'Google' },
} as const satisfies Record<AiProvider, { label: string }>;

/**
 * Resolve a persisted provider id to its vendor label for display, falling back
 * to the raw id when this deploy does not recognize it. The live cost guide
 * always passes a known `AiProvider`; the activity feed may pass an arbitrary
 * historical string, so one unrecognized id never fails the whole read.
 */
export function providerLabel(id: string): string {
	return Object.hasOwn(AI_PROVIDERS, id)
		? AI_PROVIDERS[id as AiProvider].label
		: id;
}

/**
 * The catalog, in display order. One credit = $0.01 at Pro overage
 * ($1 / 100 credits); prices hold margin against provider list prices for an
 * average chat call of 750 input and 1500 output tokens. `gemini-3.5-flash`
 * is the Chinese-tuned default for Vocab and is not offered elsewhere.
 */
export const AI_MODELS = [
	{ id: 'gpt-5.4-mini', provider: 'openai', label: 'Fast', credits: 2 },
	{ id: 'gpt-5.5', provider: 'openai', label: 'Best', credits: 10 },
	{ id: 'gemini-3.5-flash', provider: 'gemini', label: 'Fast', credits: 2 },
] as const satisfies readonly AiModel[];

export type ServableModel = (typeof AI_MODELS)[number]['id'];

/** Tuple of every servable model id, for arktype `type.enumerated(...)`. */
export const SERVABLE_MODELS = AI_MODELS.map((model) => model.id) as [
	ServableModel,
	...ServableModel[],
];

/** Catalog entry by id, for pickers that render label and credits. */
export const MODELS_BY_ID = Object.fromEntries(
	AI_MODELS.map((model) => [model.id, model]),
) as Record<ServableModel, AiModel>;
