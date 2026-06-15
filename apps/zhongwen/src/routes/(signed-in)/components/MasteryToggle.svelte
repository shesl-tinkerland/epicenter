<script lang="ts">
	import { ToggleGroup, ToggleGroupItem } from '@epicenter/ui/toggle-group';
	import type { Vocabulary } from '@epicenter/zhongwen';

	/**
	 * The self-report control: one tap sets a word's comfort. Fully controlled,
	 * its value is derived from the live word, never a parallel `$state`, so the
	 * Words list and the reflection sheet both show the truth in the table.
	 */
	let {
		mastery,
		onChange,
	}: {
		mastery: Vocabulary['mastery'];
		onChange: (mastery: Vocabulary['mastery']) => void;
	} = $props();
</script>

<ToggleGroup
	type="single"
	variant="outline"
	size="sm"
	value={String(mastery)}
	onValueChange={(value) => {
		if (value) onChange(Number(value) as Vocabulary['mastery']);
	}}
>
	<ToggleGroupItem value="0" aria-label="Mark as new">New</ToggleGroupItem>
	<ToggleGroupItem value="1" aria-label="Mark as learning">
		Learning
	</ToggleGroupItem>
	<ToggleGroupItem value="2" aria-label="Mark as known">Known</ToggleGroupItem>
</ToggleGroup>
