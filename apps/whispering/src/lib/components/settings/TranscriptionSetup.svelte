<!--
	The shared transcriber-setup core: lead with the recommended setup for the
	currently selected service (the model download on desktop, the API-key field
	on web) and tuck the full service picker behind a disclosure. A first-run
	user wants the default; the picker is a wall of unfamiliar provider names
	that reads as "this is a developer tool". Anyone who wants a cloud provider
	or a different model opens the disclosure.

	This is the one piece both first-run surfaces share: the minimal not-ready
	screen on home and the first-run wizard's engine step compose it, so the
	setup mechanics live in exactly one place.
-->
<script lang="ts">
	import * as Collapsible from '@epicenter/ui/collapsible';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { settings } from '$lib/state/settings.svelte';
	import TranscriptionRuntimeConfig from './TranscriptionRuntimeConfig.svelte';
	import TranscriptionServiceSelect from './TranscriptionServiceSelect.svelte';

	let {
		id = 'transcription-setup',
		class: className,
	}: { id?: string; class?: string } = $props();
</script>

<div class={['w-full space-y-4', className]}>
	<TranscriptionRuntimeConfig {id} hideServiceSelect showAdvanced={false} />

	<Collapsible.Root>
		<Collapsible.Trigger
			class="flex w-full items-center justify-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180"
		>
			Use a different service
			<ChevronDown class="size-4 transition-transform" />
		</Collapsible.Trigger>
		<Collapsible.Content class="pt-4">
			<TranscriptionServiceSelect
				id="{id}-picker"
				label="Service"
				bind:selected={() => settings.get('transcription.service'),
					(selected) => settings.set('transcription.service', selected)}
			/>
		</Collapsible.Content>
	</Collapsible.Root>
</div>
