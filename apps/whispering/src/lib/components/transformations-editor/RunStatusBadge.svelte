<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';

	type Status = 'completed' | 'failed' | 'running';
	let { status }: { status: Status } = $props();
</script>

<Badge
	variant="outline"
	class={status === 'completed'
		? 'text-green-600 dark:text-green-400'
		: status === 'failed'
			? 'text-red-600 dark:text-red-400'
			: 'text-blue-600 dark:text-blue-400'}
>
	{#if status === 'completed'}
		<CircleCheckIcon class="size-3" />
	{:else if status === 'failed'}
		<CircleXIcon class="size-3" />
	{:else}
		<Spinner class="size-3" />
	{/if}
	{status}
</Badge>
