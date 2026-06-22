<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';

	let {
		value = $bindable(''),
		isGenerating,
		onSend,
		onStop,
	}: {
		value?: string;
		isGenerating: boolean;
		onSend: (content: string) => void;
		onStop: () => void;
	} = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			submit();
		}
	}

	function submit() {
		const content = value.trim();
		if (!content) return;
		onSend(content);
		value = '';
	}
</script>

<form
	class="flex gap-2 border-t p-4"
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	<Textarea
		placeholder="Ask something in English..."
		class="min-h-[44px] max-h-[120px] resize-none"
		aria-label="Message input"
		bind:value
		onkeydown={handleKeydown}
		disabled={isGenerating}
	/>
	{#if isGenerating}
		<Button type="button" variant="outline" onclick={onStop}>Stop</Button>
	{:else}
		<Button type="submit" disabled={!value.trim()}>Send</Button>
	{/if}
</form>
<p class="px-4 pb-2 text-xs text-muted-foreground">
	Enter to send, Shift+Enter for new line
</p>
