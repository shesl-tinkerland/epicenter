<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import TranscriptionRuntimeSetup from '$lib/components/settings/TranscriptionRuntimeSetup.svelte';
	import { getTranscriptionSetupReadiness } from '$lib/settings/transcription-validation';
	import SetupSection from './SetupSection.svelte';

	const readiness = $derived(getTranscriptionSetupReadiness());
</script>

<svelte:head> <title>Setup - Whispering</title> </svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col px-4 py-6 sm:px-8">
	<div class="max-w-2xl space-y-2 pb-4">
		<h1 class="text-2xl font-semibold tracking-tight">Setup</h1>
		<p class="text-sm text-muted-foreground">
			Choose a transcription service and finish the runtime settings this
			device needs before recording.
		</p>
	</div>

	<SetupSection
		number="1"
		title="Transcription runtime"
		description="Pick where transcription runs and set the model or provider details."
		complete={readiness.isReady}
	>
		{#if readiness.isReady}
			<Alert.Root>
				<CheckCircle2Icon class="size-4" />
				<Alert.Title>Whispering is ready to record</Alert.Title>
				<Alert.Description>
					Your selected transcription service has the required runtime setup
					for this device.
				</Alert.Description>
			</Alert.Root>
		{:else}
			<Alert.Root variant="warning">
				<CircleAlertIcon class="size-4" />
				<Alert.Title>Finish setup before recording</Alert.Title>
				<Alert.Description>
					{readiness.primaryIssue ?? 'Complete the required transcription setup.'}
				</Alert.Description>
			</Alert.Root>
		{/if}

		<TranscriptionRuntimeSetup />
	</SetupSection>

	<SetupSection
		number="2"
		title="Start recording"
		description="Use the home screen once the runtime is ready."
		complete={readiness.isReady}
	>
		<div class="flex flex-col gap-2 sm:flex-row">
			<Button href="/" disabled={!readiness.isReady}>Start recording</Button>
			<Button href="/settings/transcription" variant="outline">
				Open transcription settings
			</Button>
		</div>
	</SetupSection>
</div>
