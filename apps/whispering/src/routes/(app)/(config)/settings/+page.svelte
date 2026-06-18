<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Button } from '@epicenter/ui/button';
	import { Switch } from '@epicenter/ui/switch';
	import LockIcon from '@lucide/svelte/icons/lock';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import {
		clipboardFallback,
		pasteBack,
	} from '$lib/components/accessibility-feature-copy';
	import { openSystemSettings } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { SettingSelect, SettingSwitch } from '$lib/components/settings';
	import { report } from '$lib/report';
	import { autostartKeys } from '$lib/tauri/autostart-keys';
	import { tauri } from '#platform/tauri';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { settings } from '$lib/state/settings.svelte';

	const retentionItems = [
		{ value: 'keep-forever', label: 'Keep All Recordings' },
		{ value: 'limit-count', label: 'Keep Limited Number' },
		{ value: 'keep-none', label: "Don't Keep Recordings" },
	] as const;

	// Both pruning strategies act retroactively: they delete recordings you
	// already have, not just future ones. The label alone reads as forward-only,
	// so the description has to say otherwise.
	const retentionDescription = $derived.by(() => {
		switch (settings.get('retention.strategy')) {
			case 'keep-none':
				return 'Recordings are deleted right after transcription. Turning this on also deletes recordings you already have.';
			case 'limit-count':
				return 'Older recordings beyond your limit are deleted automatically, including ones you already have.';
			case 'keep-forever':
				return undefined;
		}
	});

	// Values stay `number` (not literals): `retention.maxCount` is a
	// `field.integer`, so SettingSelect infers its value type from these options.
	const maxRecordingItems: { value: number; label: string }[] = [
		{ value: 5, label: '5 Recordings' },
		{ value: 10, label: '10 Recordings' },
		{ value: 25, label: '25 Recordings' },
		{ value: 50, label: '50 Recordings' },
		{ value: 100, label: '100 Recordings' },
	];

	// Autostart is Tauri-only; on web `tauri` is null and the query stays
	// disabled (default value `false`).
	const autostartQuery = createQuery(() =>
		tauri
			? tauri.autostart.isEnabled.options
			: {
					queryKey: autostartKeys.isEnabled,
					queryFn: async () => false,
					enabled: false,
					initialData: false,
				},
	);
	const enableAutostartMutation = createMutation(() =>
		tauri
			? tauri.autostart.enable.options
			: {
					mutationKey: autostartKeys.enable,
					mutationFn: async () => undefined,
				},
	);
	const disableAutostartMutation = createMutation(() =>
		tauri
			? tauri.autostart.disable.options
			: {
					mutationKey: autostartKeys.disable,
					mutationFn: async () => undefined,
				},
	);
</script>

<svelte:head> <title>Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>General</Field.Legend>
	<Field.Description>
		Configure your general Whispering preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Transcription output</Field.Legend>
			<Field.Description>
				Applies immediately after an audio transcription finishes.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="output.transcription.clipboard"
					label="Copy transcript to clipboard"
				/>

				<SettingSwitch
					key="output.transcription.cursor"
					label="Paste transcript at cursor"
				/>

				{#if tauri && dictationCapability.isUnavailable}
					<!-- The toggle stays on and interactive (it records intent), but the
					paste can't fire without the macOS Accessibility grant. Annotate the
					current capability inline; offer the grant only when there is one to
					give (untrusted or stale, not Wayland). -->
					<div
						class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
					>
						<LockIcon class="size-3.5 shrink-0" aria-hidden="true" />
						<span>{pasteBack} {clipboardFallback}</span>
						{#if dictationCapability.needsAccessibility}
							<Button
								variant="link"
								class="h-auto p-0 text-sm font-normal"
								onclick={openSystemSettings}
							>
								Open Settings
							</Button>
						{/if}
					</div>
				{/if}

				{#if tauri && settings.get('output.transcription.cursor')}
					<div class={dictationCapability.isUnavailable ? 'opacity-50' : ''}>
						<SettingSwitch
							key="output.transcription.enter"
							label="Press Enter after pasting transcript"
						/>
					</div>
				{/if}
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Recipe output</Field.Legend>
			<Field.Description>
				Applies after you run a saved recipe on a transcription.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="output.recipe.clipboard"
					label="Copy recipe output to clipboard"
				/>

				<SettingSwitch
					key="output.recipe.cursor"
					label="Paste recipe output at cursor"
				/>

				{#if tauri && settings.get('output.recipe.cursor')}
					<SettingSwitch
						key="output.recipe.enter"
						label="Press Enter after pasting recipe output"
					/>
				{/if}
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<SettingSelect
			store={settings}
			key="retention.strategy"
			label="Auto Delete Recordings"
			items={retentionItems}
			description={retentionDescription}
		/>

		{#if settings.get('retention.strategy') === 'limit-count'}
			<SettingSelect
				store={settings}
				key="retention.maxCount"
				label="Maximum Recordings"
				items={maxRecordingItems}
			/>
		{/if}

		{#if tauri}
			<Field.Field orientation="horizontal">
				<Field.Content>
					<Field.Label for="autostart">Launch on Startup</Field.Label>
					<Field.Description>
						Automatically open Whispering when you log in
					</Field.Description>
				</Field.Content>
				<Switch
					id="autostart"
					checked={autostartQuery.data ?? false}
					onCheckedChange={(checked) => {
						if (checked) {
							enableAutostartMutation.mutate(undefined, {
								onError: (error) => report.error({ cause: error }),
							});
						} else {
							disableAutostartMutation.mutate(undefined, {
								onError: (error) => report.error({ cause: error }),
							});
						}
					}}
					disabled={autostartQuery.isPending ||
						enableAutostartMutation.isPending ||
						disableAutostartMutation.isPending}
				/>
			</Field.Field>
		{/if}
	</Field.Group>
</Field.Set>
