<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Link } from '@epicenter/ui/link';
	import * as Select from '@epicenter/ui/select';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { createMutation } from '@tanstack/svelte-query';
	import {
		BITRATE_OPTIONS,
		RECORDING_MODE_OPTIONS,
		SAMPLE_RATE_OPTIONS,
	} from '$lib/constants/audio';
	import { IS_LINUX, IS_MACOS } from '$lib/constants/platform';
	import {
		asDeviceIdentifier,
		type DeviceIdentifier,
	} from '$lib/services/recorder/types';
	import { report } from '$lib/report';
	import { tauri } from '$lib/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { whispering } from '$lib/whispering/whispering';
	import ManualSelectRecordingDevice from './ManualSelectRecordingDevice.svelte';
	import VadSelectRecordingDevice from './VadSelectRecordingDevice.svelte';

	// Derived labels for select triggers
	const recordingModeLabel = $derived(
		RECORDING_MODE_OPTIONS.find(
			(o) => o.value === settings.get('recording.mode'),
		)?.label,
	);

	const sampleRateLabel = $derived(
		SAMPLE_RATE_OPTIONS.find(
			(o) => o.value === deviceConfig.get('recording.cpal.sampleRate'),
		)?.label,
	);

	const bitrateLabel = $derived(
		BITRATE_OPTIONS.find(
			(o) => o.value === deviceConfig.get('recording.navigator.bitrateKbps'),
		)?.label,
	);

	const RECORDING_METHOD_OPTIONS = [
		{
			value: 'cpal',
			label: 'CPAL',
			description: IS_MACOS
				? 'Native Rust audio method. Records uncompressed WAV, reliable with shortcuts. Works with all transcription methods.'
				: 'Native Rust audio method. Records uncompressed WAV format. Works with all transcription methods.',
		},
		{
			value: 'navigator',
			label: 'Browser API',
			description: IS_MACOS
				? 'Web MediaRecorder API. Creates compressed files (WebM/Opus) suitable for cloud transcription. May have delays with shortcuts when app is in background (macOS AppNap).'
				: 'Web MediaRecorder API. Creates compressed files (WebM/Opus) suitable for cloud transcription.',
		},
	];

	const recordingMethodLabel = $derived(
		RECORDING_METHOD_OPTIONS.find(
			(o) => o.value === deviceConfig.get('recording.method'),
		)?.label,
	);

	const isUsingNavigatorMethod = $derived(
		!tauri ||
			deviceConfig.get('recording.method') === 'navigator',
	);

	const exportMarkdown = createMutation(() => ({
		mutationFn: whispering.actions.recordings_export_markdown,
	}));

	function getManualDeviceId(method: 'cpal' | 'navigator') {
		switch (method) {
			case 'cpal':
				return deviceConfig.get('recording.cpal.deviceId');
			case 'navigator':
				return deviceConfig.get('recording.navigator.deviceId');
		}
	}

	function setManualDeviceId(
		method: 'cpal' | 'navigator',
		selected: DeviceIdentifier | null,
	) {
		switch (method) {
			case 'cpal':
				deviceConfig.set('recording.cpal.deviceId', selected);
				break;
			case 'navigator':
				deviceConfig.set('recording.navigator.deviceId', selected);
				break;
		}
	}
</script>

<svelte:head> <title>Recording Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Recording</Field.Legend>
	<Field.Description>
		Configure your Whispering recording preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Field>
			<Field.Label for="recording-mode">Recording Mode</Field.Label>
			<Select.Root
				type="single"
				bind:value={() => settings.get('recording.mode'),
					(selected) => {
						if (selected) settings.set('recording.mode', selected);
					}}
			>
				<Select.Trigger id="recording-mode" class="w-full">
					{recordingModeLabel ?? 'Select a recording mode'}
				</Select.Trigger>
				<Select.Content>
					{#each RECORDING_MODE_OPTIONS as item}
						<Select.Item value={item.value} label={item.label} />
					{/each}
				</Select.Content>
			</Select.Root>
			<Field.Description>
				Choose how you want to activate recording:
				{RECORDING_MODE_OPTIONS.map(
					(option) => option.label.toLowerCase(),
				).join(', ')}
			</Field.Description>
		</Field.Field>

		{#if tauri && settings.get('recording.mode') === 'manual'}
			<Field.Field>
				<Field.Label for="recording-method">Recording Method</Field.Label>
				<Select.Root
					type="single"
					bind:value={() => deviceConfig.get('recording.method'),
						(selected) => {
							if (selected)
							deviceConfig.set(
									'recording.method',
									selected as 'cpal' | 'navigator',
								);
						}}
				>
					<Select.Trigger id="recording-method" class="w-full">
						{recordingMethodLabel ?? 'Select a recording method'}
					</Select.Trigger>
					<Select.Content>
						{#each RECORDING_METHOD_OPTIONS as item}
							<Select.Item value={item.value} label={item.label}>
								<div class="flex flex-col gap-0.5">
									<div class="font-medium">{item.label}</div>
									{#if item.description}
										<div class="text-xs text-muted-foreground">
											{item.description}
										</div>
									{/if}
								</div>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>
					{RECORDING_METHOD_OPTIONS.find(
					(option) => option.value === deviceConfig.get('recording.method'),
					)?.description}
				</Field.Description>
			</Field.Field>

			{#if IS_MACOS && deviceConfig.get('recording.method') === 'navigator'}
				<Alert.Root class="border-warning/20 bg-warning/5">
					<InfoIcon class="size-4 text-warning dark:text-warning" />
					<Alert.Title class="text-warning dark:text-warning">
						Global Shortcuts May Be Unreliable
					</Alert.Title>
					<Alert.Description>
						When using the navigator recorder, macOS App Nap may prevent the
						browser recording logic from starting when not in focus. Consider
						using the CPAL method for reliable global shortcut support.
					</Alert.Description>
				</Alert.Root>
			{/if}

		{/if}

		{#if settings.get('recording.mode') === 'manual'}
			{@const method = deviceConfig.get('recording.method')}
			<ManualSelectRecordingDevice
				bind:selected={() => {
					const selected = getManualDeviceId(method);
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) => setManualDeviceId(method, selected)}
			/>
		{:else if settings.get('recording.mode') === 'vad'}
			{#if IS_LINUX}
				<Alert.Root class="border-red-500/20 bg-red-500/5">
					<InfoIcon class="size-4 text-red-600 dark:text-red-400" />
					<Alert.Title class="text-red-600 dark:text-red-400">
						VAD Mode Not Supported on Linux
					</Alert.Title>
					<Alert.Description>
						Voice Activated Detection (VAD) mode requires the browser's
						Navigator API, which is not fully supported in Tauri on Linux.
						Device enumeration and recording will fail. Please use Manual
						recording mode instead.
						<Link
							href="https://github.com/EpicenterHQ/epicenter/issues/839"
							target="_blank"
							class="font-medium underline underline-offset-4 hover:text-red-700 dark:hover:text-red-300"
						>
							Learn more →
						</Link>
					</Alert.Description>
				</Alert.Root>
			{:else}
				<Alert.Root class="border-blue-500/20 bg-blue-500/5">
					<InfoIcon class="size-4 text-blue-600 dark:text-blue-400" />
					<Alert.Title class="text-blue-600 dark:text-blue-400">
						Voice Activated Detection Mode
					</Alert.Title>
					<Alert.Description>
						VAD mode uses the browser's Web Audio API for real-time voice
						detection and records via the browser's MediaRecorder API. Audio is
						encoded to uncompressed WAV format. VAD mode runs the browser
						recorder regardless of the CPAL/Browser API selection above.
					</Alert.Description>
				</Alert.Root>
			{/if}

			<VadSelectRecordingDevice
				bind:selected={() => {
					const selected = deviceConfig.get('recording.navigator.deviceId');
					return selected ? asDeviceIdentifier(selected) : null;
					},
					(selected) =>
						deviceConfig.set('recording.navigator.deviceId', selected)}
			/>
		{/if}

		{#if settings.get('recording.mode') === 'manual' || settings.get('recording.mode') === 'vad'}
			{#if tauri}
				<Field.Field>
					<Field.Label>Recording markdown export</Field.Label>
					<Button
						variant="outline"
						onclick={() => {
							exportMarkdown.mutate(undefined, {
								onSuccess: ({ data, error }) => {
									if (error !== null) {
										report.error({
											title: 'Recording markdown export failed',
											cause: error,
										});
										return;
									}
									if (data.status === 'cancelled') return;

									report.success({
										title: 'Recording markdown exported',
										description: `Wrote ${data.written} ${data.written === 1 ? 'file' : 'files'} to ${data.dir}.`,
									});
								},
							});
						}}
						disabled={exportMarkdown.isPending}
					>
						{exportMarkdown.isPending ? 'Exporting...' : 'Export markdown...'}
					</Button>
					<Field.Description>
						Write every current recording's transcript to a folder you choose.
						The files are snapshots: later edits in Whispering do not update
						them. Run the export again to refresh.
					</Field.Description>
				</Field.Field>
			{/if}

			{#if isUsingNavigatorMethod}
				<!-- Browser method settings -->
				<Field.Field>
					<Field.Label for="bit-rate">Bitrate</Field.Label>
					<Select.Root
						type="single"
						bind:value={() => deviceConfig.get('recording.navigator.bitrateKbps'),
							(selected) => {
								if (selected)
							deviceConfig.set(
										'recording.navigator.bitrateKbps',
										selected,
									);
							}}
					>
						<Select.Trigger id="bit-rate" class="w-full">
							{bitrateLabel ?? 'Select a bitrate'}
						</Select.Trigger>
						<Select.Content>
							{#each BITRATE_OPTIONS as item}
								<Select.Item value={item.value} label={item.label} />
							{/each}
						</Select.Content>
					</Select.Root>
					<Field.Description>
						The bitrate of the recording. Higher values mean better quality but
						larger file sizes.
					</Field.Description>
				</Field.Field>
			{:else}
				<!-- CPAL method settings -->
				<Field.Field>
					<Field.Label for="sample-rate">Sample Rate</Field.Label>
					<Select.Root
						type="single"
						bind:value={() => deviceConfig.get('recording.cpal.sampleRate'),
							(selected) => {
								if (selected)
							deviceConfig.set('recording.cpal.sampleRate', selected);
							}}
					>
						<Select.Trigger id="sample-rate" class="w-full">
							{sampleRateLabel ?? 'Select sample rate'}
						</Select.Trigger>
						<Select.Content>
							{#each SAMPLE_RATE_OPTIONS as item}
								<Select.Item value={item.value} label={item.label} />
							{/each}
						</Select.Content>
					</Select.Root>
					<Field.Description>
						Higher sample rates provide better quality but create larger files
					</Field.Description>
				</Field.Field>
			{/if}
		{/if}
	</Field.Group>
</Field.Set>
