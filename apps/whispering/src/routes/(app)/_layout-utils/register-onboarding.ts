import { goto } from '$app/navigation';
import { report } from '$lib/report';
import {
	getSelectedTranscriptionService,
	isTranscriptionServiceConfigured,
} from '$lib/settings/transcription-validation';

/**
 * Checks if the user has configured the necessary API keys/settings for their selected transcription service.
 * Shows an onboarding toast if configuration is missing.
 */
export function registerOnboarding() {
	const selectedService = getSelectedTranscriptionService();

	// Check transcription service configuration
	if (!selectedService) {
		report.info({
			title: 'Welcome to Whispering!',
			description: 'Please select a transcription service to get started.',
			action: {
				label: 'Configure',
				onClick: () => goto('/settings/transcription'),
			},
		});
		return;
	}

	if (!isTranscriptionServiceConfigured(selectedService)) {
		const description = (
			{
				cloud: `Please add your ${selectedService.label} API key to get started.`,
				'self-hosted': `Please set your ${selectedService.label} server URL to get started.`,
				local: `Please download or select a ${selectedService.label} model to get started.`,
			} as const
		)[selectedService.location];

		report.info({
			title: 'Welcome to Whispering!',
			description,
			action: {
				label: 'Set up',
				onClick: () => goto('/settings/transcription'),
			},
		});
	}
}
