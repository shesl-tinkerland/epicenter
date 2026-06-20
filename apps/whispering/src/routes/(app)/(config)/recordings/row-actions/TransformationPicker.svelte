<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { createMutation } from '@tanstack/svelte-query';
	import { goto } from '$app/navigation';
	import TransformationPickerBody from '$lib/components/TransformationPickerBody.svelte';
	import { deliverTransformationResult } from '$lib/operations/delivery';
	import { report } from '$lib/report';
	import { sound } from '$lib/operations/sound';
	import { rpc } from '$lib/rpc';

	const combobox = useCombobox();

	const transformRecording = createMutation(
		() => rpc.transformer.transformRecording.options,
	);

	let { recordingId }: { recordingId: string } = $props();
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip="Run a post-processing transformation to run on your recording"
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				<LayersIcon class="size-4" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 max-w-xl p-0">
		<TransformationPickerBody
			onSelect={(transformation) => {
				combobox.closeAndFocusTrigger();

				const loading = report.loading({
					title: '🔄 Running transformation...',
					description:
						'Applying your selected transformation to the transcribed text...',
				});

				transformRecording.mutate(
					{ recordingId, transformation },
					{
						onError: (error) => loading.reject({ cause: error }),
						onSuccess: async (transformedText) => {
							sound.playSoundIfEnabled('transformationComplete');
							const { notice } = await deliverTransformationResult({
								text: transformedText,
								recordingId,
							});
							loading.resolve(notice);
						},
					},
				);
			}}
			onSelectManageTransformations={() => {
				combobox.closeAndFocusTrigger();
				goto('/transformations');
			}}
			placeholder="Select transcription post-processing..."
		/>
	</Popover.Content>
</Popover.Root>
