<script lang="ts" generics="K extends SelectSettingKey">
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	// Bound to the synced workspace `settings` store by design. Device-local
	// selects (bitrate, sample rate on the recording page) stay bespoke on
	// purpose: `deviceConfig` is a separate store with its own value map, and
	// generalizing this component over both stores costs far more in generic
	// machinery than the handful of duplicated `<Select.Root>` blocks it saves.
	import {
		type SelectSettingKey,
		type SettingValue,
		settings,
	} from '$lib/state/settings.svelte';

	let {
		key,
		label,
		items,
		description,
	}: {
		key: K;
		label: string;
		items: readonly { value: SettingValue<K>; label: string }[];
		description?: string;
	} = $props();

	// Opaque, generated id wired into both `for` and the trigger from one source.
	const id = $props.id();

	const selectedLabel = $derived(
		items.find((item) => item.value === settings.get(key))?.label,
	);
</script>

<Field.Field>
	<Field.Label for={id}>{label}</Field.Label>
	<Select.Root
		type="single"
		bind:value={
			() => String(settings.get(key)),
			(value) => {
				// bits-ui Select is string-valued; the items list is the source of
				// truth for mapping the string form back to the typed setting value.
				const match = items.find((item) => String(item.value) === value);
				if (match) settings.set(key, match.value);
			}
		}
	>
		<Select.Trigger {id} class="w-full">
			{selectedLabel ?? 'Select an option'}
		</Select.Trigger>
		<Select.Content>
			{#each items as item}
				<Select.Item value={String(item.value)} label={item.label} />
			{/each}
		</Select.Content>
	</Select.Root>
	{#if description}
		<Field.Description>{description}</Field.Description>
	{/if}
</Field.Field>
