<script lang="ts">
	import { RatingGroup, type RatingGroupRootProps } from 'bits-ui';
	import { cn } from '../utils.js';

	let {
		value = $bindable(0),
		max = 5,
		orientation = 'horizontal',
		class: className,
		...rest
	}: RatingGroupRootProps = $props();
</script>

<RatingGroup.Root
	class={cn('group flex w-fit place-items-center gap-1 rounded-md outline-hidden', className)}
	bind:value
	{max}
	{orientation}
	{...rest}
/>
