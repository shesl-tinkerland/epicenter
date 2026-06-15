/**
 * Model configuration for Opensidian AI chat.
 *
 * Pure data: no Svelte runes, no side effects. The app curates a subset of the
 * shared catalog (`@epicenter/constants/ai-providers`); the provider is derived
 * from the model on the server, never chosen here.
 */

import type { ServableModel } from '@epicenter/constants/ai-providers';

/** Models this app offers, in display order. */
export const APP_MODELS = [
	'gpt-5.4-mini',
	'gpt-5.5',
] as const satisfies readonly ServableModel[];

/** The model a new conversation starts on: the first offered model. */
export const DEFAULT_MODEL = APP_MODELS[0];
