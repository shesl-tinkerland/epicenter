<script lang="ts">
	import { MODELS_BY_ID } from '@epicenter/constants/ai-providers';
	import { Button } from '@epicenter/ui/button';
	import * as Select from '@epicenter/ui/select';
	import { Textarea } from '@epicenter/ui/textarea';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { APP_MODELS } from '$lib/chat/models';
	import type { ConversationHandle } from '$lib/chat/chat-state.svelte';

	let {
		active,
	}: {
		active: ConversationHandle | undefined;
	} = $props();

	const currentModelLabel = $derived(
		active
			? (MODELS_BY_ID[active.model as keyof typeof MODELS_BY_ID]?.label ??
				active.model)
			: '',
	);

	function send() {
		if (!active) return;
		const content = active.inputValue.trim();
		if (!content) return;
		active.inputValue = '';
		active.sendMessage(content);
	}
</script>

<div class="flex flex-col gap-1.5 border-t bg-background px-2 py-1.5">
	<!-- Model select: ordered roles (Fast / Best) -->
	<div class="flex gap-2">
		<Select.Root
			type="single"
			value={active?.model ?? ''}
			onValueChange={(v) => {
				if (v && active) active.model = v;
			}}
		>
			<Select.Trigger size="sm" class="flex-1">
				<span class="truncate">{currentModelLabel}</span>
			</Select.Trigger>
			<Select.Content>
				{#each APP_MODELS as id (id)}
					<Select.Item value={id} label={MODELS_BY_ID[id].label}>
						<div class="flex w-full items-center justify-between gap-4">
							<span>{MODELS_BY_ID[id].label}</span>
							<span class="text-xs text-muted-foreground">
								{MODELS_BY_ID[id].credits} cr
							</span>
						</div>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</div>

	<!-- Input + send/stop button -->
	<form
		class="flex items-end gap-1.5"
		aria-label="Chat message"
		onsubmit={(e) => {
			e.preventDefault();
			send();
		}}
	>
		{#if active}
			<Textarea
				class="min-h-0 max-h-32 flex-1 resize-none overflow-y-auto"
				rows={1}
				placeholder="Type a message…"
				bind:value={active.inputValue}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
						e.preventDefault();
						send();
					}
				}}
			/>
		{/if}
		{#if active?.isLoading}
			<Button
				variant="outline"
				size="icon-lg"
				type="button"
				onclick={() => active?.stop()}
			>
				<SquareIcon />
			</Button>
		{:else}
			<Button
				variant="default"
				size="icon-lg"
				type="submit"
				disabled={!active?.inputValue.trim()}
			>
				<SendIcon />
			</Button>
		{/if}
	</form>
</div>
