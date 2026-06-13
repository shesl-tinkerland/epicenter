import { goto } from '$app/navigation';
import { report } from '$lib/report';
import { getTranscriptionSetupReadiness } from '$lib/settings/transcription-validation';

/**
 * Checks the current setup facts and points incomplete devices to setup.
 */
export function registerOnboarding() {
	if (window.location.pathname.startsWith('/setup')) return;

	const readiness = getTranscriptionSetupReadiness();
	if (readiness.isReady) return;

	report.info({
		title: 'Finish Whispering setup',
		description: readiness.primaryIssue ?? 'Complete setup before recording.',
		action: {
			label: 'Open setup',
			onClick: () => goto('/setup'),
		},
	});
}
