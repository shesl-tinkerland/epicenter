<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import type { Snippet } from 'svelte';

	let {
		number,
		title,
		description,
		complete,
		children,
	}: {
		number: string;
		title: string;
		description: string;
		complete: boolean;
		children?: Snippet;
	} = $props();
</script>

<section class="grid gap-4 border-t py-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
	<div class="space-y-2">
		<div class="flex items-center gap-2">
			<span
				class="flex size-7 items-center justify-center rounded-full border text-sm font-medium"
			>
				{number}
			</span>
			{#if complete}
				<Badge variant="success">Ready</Badge>
			{:else}
				<Badge variant="outline">Needs setup</Badge>
			{/if}
		</div>
		<div>
			<h2 class="text-lg font-semibold tracking-tight">{title}</h2>
			<p class="text-sm text-muted-foreground">{description}</p>
		</div>
	</div>
	<div class="min-w-0 space-y-4">
		{@render children?.()}
	</div>
</section>
