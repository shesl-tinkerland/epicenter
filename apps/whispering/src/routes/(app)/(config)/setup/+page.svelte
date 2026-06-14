<!-- Engine step (the setup index `/setup`): transcription runtime picker + readiness alert. -->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Link } from '@epicenter/ui/link';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import { onMount } from 'svelte';
	import { announceModelDownload } from '$lib/components/settings/local-model-toasts';
	import TranscriptionRuntimeSetup from '$lib/components/settings/TranscriptionRuntimeSetup.svelte';
	import { RECOMMENDED_MODELS } from '$lib/constants/local-models';
	import {
		isLocalProviderId,
		PROVIDERS,
	} from '$lib/services/transcription/providers';
	import { getTranscriptionSetupReadiness } from '$lib/settings/transcription-validation';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { localModelDownloads } from '$lib/state/local-model-downloads.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { tauri } from '#platform/tauri';

	const runtime = $derived(getTranscriptionSetupReadiness());

	// Zero-click recommended path: on a desktop first run, when the selected
	// engine is local but its model isn't on disk yet, download the recommended
	// model in the background and select it, so a first-timer reaches a ready
	// runtime without a click. Fires once on mount, so it never re-triggers on
	// engine switches; progress shows in the model card's hero, which reads the
	// same shared download handle. (Download runs in Rust via plugin-upload and
	// has no cancel yet — see follow-up.)
	onMount(async () => {
		if (!tauri) return;
		const service = settings.get('transcription.service');
		if (!isLocalProviderId(service)) return;
		const handle = localModelDownloads.get(RECOMMENDED_MODELS[service]);
		await handle.refresh();
		if (handle.state.type !== 'not-downloaded') return;
		const entryName = announceModelDownload(await handle.download());
		if (entryName) deviceConfig.set(PROVIDERS[service].modelConfigKey, entryName);
	});
</script>

<div class="space-y-4">
	<TranscriptionRuntimeSetup
		id="setup-transcription-service"
		label="Runtime"
		showAdvanced={false}
	/>

	{#if runtime.isReady}
		<Alert.Root>
			<CheckCircle2Icon class="size-4 text-green-500" />
			<Alert.Title>Transcription is configured</Alert.Title>
			<Alert.Description>
				{runtime.service?.label ?? 'Your runtime'} is ready on this device.
			</Alert.Description>
		</Alert.Root>
	{:else}
		<Alert.Root variant="warning">
			<AlertCircleIcon class="size-4" />
			<Alert.Title>Transcription needs setup</Alert.Title>
			<Alert.Description>
				{runtime.primaryIssue ??
					'Choose a runtime and fill in the required fields.'}
			</Alert.Description>
		</Alert.Root>
	{/if}

	<Link href="/settings/transcription" class="text-sm text-muted-foreground">
		Advanced transcription settings
	</Link>
</div>
