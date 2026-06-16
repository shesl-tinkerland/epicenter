import { tauri } from '#platform/tauri';
import {
	TRANSCRIPTION_PROVIDERS,
	type TranscriptionProviderEntry,
} from '$lib/services/transcription/provider-ui';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { secrets } from '$lib/state/secrets.svelte';
import { settings } from '$lib/state/settings.svelte';

function hasValue(value: string) {
	return value.trim() !== '';
}

export function getSelectedTranscriptionProvider():
	| TranscriptionProviderEntry
	| undefined {
	const selectedServiceId = settings.get('transcription.service');
	return TRANSCRIPTION_PROVIDERS.find((s) => s.id === selectedServiceId);
}

export function isTranscriptionServiceAvailable(
	service: TranscriptionProviderEntry,
): boolean {
	return Boolean(tauri) || service.location !== 'local';
}

/**
 * Gets the currently selected transcription service.
 * Returns undefined if the service is not available on this platform.
 *
 * @returns The selected transcription service, or undefined if none selected or invalid
 */
export function getSelectedTranscriptionService():
	| TranscriptionProviderEntry
	| undefined {
	const service = getSelectedTranscriptionProvider();
	if (service && !isTranscriptionServiceAvailable(service)) return undefined;
	return service;
}

/**
 * Whether a transcription service is usable right now. The required key is the
 * provider's own config key (apiKey / endpoint / model), read from its registry
 * entry. A cloud provider's key is a secret read through the credential facade,
 * so "usable" means `available`: both `missing` and `locked` return false (a
 * locked vault holds the key but cannot hand it over). The locked case is
 * differentiated only in {@link getTranscriptionReadiness}'s message, not as
 * a separate "configured" state, since every caller of this asks "can I use it".
 *
 * @param service - The transcription service to check
 * @returns true if the service is usable, false otherwise
 */
export function isTranscriptionServiceConfigured(
	service: TranscriptionProviderEntry,
): boolean {
	switch (service.location) {
		case 'cloud':
			return secrets.get(service.apiKeyConfigKey).status === 'available';
		case 'self-hosted':
			return (
				hasValue(deviceConfig.get(service.endpointConfigKey)) &&
				hasValue(deviceConfig.get(service.modelIdConfigKey))
			);
		case 'local':
			return hasValue(deviceConfig.get(service.modelConfigKey));
	}
}

/**
 * Whether a cloud service is unusable because its key sits in a locked vault
 * rather than being unset. Only cloud keys are secrets; self-hosted and local
 * config lives on the device and is never locked. Drives the "configured but
 * locked" readiness message, telling the user to unlock rather than to add a key.
 */
function isCloudSecretLocked(service: TranscriptionProviderEntry): boolean {
	return (
		service.location === 'cloud' &&
		secrets.get(service.apiKeyConfigKey).status === 'locked'
	);
}

export type TranscriptionReadiness = {
	service: TranscriptionProviderEntry | undefined;
	isServiceAvailable: boolean;
	isRuntimeConfigured: boolean;
	isReady: boolean;
	primaryIssue: string | null;
};

export function getTranscriptionReadiness(): TranscriptionReadiness {
	const service = getSelectedTranscriptionProvider();
	const isServiceAvailable = service
		? isTranscriptionServiceAvailable(service)
		: false;
	const isRuntimeConfigured =
		service && isServiceAvailable
			? isTranscriptionServiceConfigured(service)
			: false;

	if (!service) {
		return {
			service,
			isServiceAvailable,
			isRuntimeConfigured,
			isReady: false,
			primaryIssue: 'Choose a transcription service.',
		};
	}

	if (!isServiceAvailable) {
		return {
			service,
			isServiceAvailable,
			isRuntimeConfigured,
			isReady: false,
			primaryIssue: `${service.label} is only available in the desktop app.`,
		};
	}

	if (!isRuntimeConfigured) {
		const primaryIssue = isCloudSecretLocked(service)
			? `Unlock your secret vault to use ${service.label}.`
			: (
					{
						cloud: `Add your ${service.label} API key.`,
						'self-hosted': `Set your ${service.label} endpoint and model ID.`,
						local: `Download or select a ${service.label} model.`,
					} as const
				)[service.location];

		return {
			service,
			isServiceAvailable,
			isRuntimeConfigured,
			isReady: false,
			primaryIssue,
		};
	}

	return {
		service,
		isServiceAvailable,
		isRuntimeConfigured,
		isReady: true,
		primaryIssue: null,
	};
}
