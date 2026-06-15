<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import {
		ACCEPT_AUDIO,
		ACCEPT_VIDEO,
		FileDropZone,
		MEGABYTE,
	} from '@epicenter/ui/file-drop-zone';
	import * as Kbd from '@epicenter/ui/kbd';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import XIcon from '@lucide/svelte/icons/x';
	import { createQuery } from '@tanstack/svelte-query';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
	import { tryAsync } from 'wellcrafted/result';
	import { commandCallbacks } from '$lib/commands';
	import TranscriptDialog from '$lib/components/copyable/TranscriptDialog.svelte';
	import {
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		RECORDING_MODE_ICONS,
		RECORDING_MODE_OPTIONS,
		type RecordingMode,
	} from '$lib/constants/audio';
	import { getShortcutDisplayLabel } from '$lib/utils/keyboard';
	import { keyBindingToLabel } from '$lib/utils/key-binding';
	import { os } from '#platform/os';
	import {
		stopManualRecording,
		stopVadRecording,
	} from '$lib/operations/recording';
	import { uploadRecordings } from '$lib/operations/upload';
	import { report } from '$lib/report';
	import { rpc } from '$lib/rpc';
	import { services } from '$lib/services';
	import { tauri } from '#platform/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import CapturePipeline from './_components/CapturePipeline.svelte';
	import ManualRecordingAction from './_components/ManualRecordingAction.svelte';
	import VadRecordingAction from './_components/VadRecordingAction.svelte';

	const latestRecording = $derived(recordings.sorted[0]);

	// The global toggle-recording shortcut, formatted for the hint text. Stored
	// as a structured KeyBinding (desktop rdev backend), so format it directly.
	const globalToggleBinding = $derived(
		deviceConfig.get('shortcuts.global.toggleManualRecording'),
	);
	const globalToggleLabel = $derived(
		globalToggleBinding ? keyBindingToLabel(globalToggleBinding, os.isApple) : '',
	);
	const PageError = defineErrors({
		SetupDragDropFailed: ({ cause }: { cause: unknown }) => ({
			message: `Failed to set up drag drop listener: ${extractErrorMessage(cause)}`,
			cause,
		}),
		FileRejected: ({
			fileName,
			reason,
		}: {
			fileName: string;
			reason: string;
		}) => ({
			message: `${fileName}: ${reason}`,
			fileName,
			reason,
		}),
	});

	const audioPlaybackUrlQuery = createQuery(() => ({
		...rpc.audio.getPlaybackUrl(() => latestRecording?.id ?? '').options,
		enabled: !!latestRecording?.id,
	}));

	const availableModes = $derived(
		RECORDING_MODE_OPTIONS.filter((mode) => {
			if (!mode.desktopOnly) return true;
			// Desktop only, only show if Tauri is available
			return !!tauri;
		}),
	);

	const AUDIO_EXTENSIONS = [
		'mp3',
		'wav',
		'm4a',
		'aac',
		'ogg',
		'flac',
		'wma',
		'opus',
	] as const;

	const VIDEO_EXTENSIONS = [
		'mp4',
		'avi',
		'mov',
		'wmv',
		'flv',
		'mkv',
		'webm',
		'm4v',
	] as const;

	// Store unlisten function for drag drop events
	let unlistenDragDrop: UnlistenFn | undefined;

	// Set up desktop drag and drop listener
	onMount(async () => {
		if (!tauri) return;
		const { error } = await tryAsync({
			try: async () => {
				const { getCurrentWebview } = await import('@tauri-apps/api/webview');
				const { extname } = await import('@tauri-apps/api/path');

				const isAudio = async (path: string) =>
					AUDIO_EXTENSIONS.includes(
						(await extname(path)) as (typeof AUDIO_EXTENSIONS)[number],
					);
				const isVideo = async (path: string) =>
					VIDEO_EXTENSIONS.includes(
						(await extname(path)) as (typeof VIDEO_EXTENSIONS)[number],
					);

				unlistenDragDrop = await getCurrentWebview().onDragDropEvent(
					async (event) => {
						if (settings.get('recording.mode') !== 'upload') return;
						if (
							event.payload.type !== 'drop' ||
							event.payload.paths.length === 0
						)
							return;

						// Filter for audio/video files based on extension
						const pathResults = await Promise.all(
							event.payload.paths.map(async (path) => ({
								path,
								isValid: (await isAudio(path)) || (await isVideo(path)),
							})),
						);
						const validPaths = pathResults
							.filter(({ isValid }) => isValid)
							.map(({ path }) => path);

						if (validPaths.length === 0) {
							report.info({
								title: 'No valid files',
								description: 'Please drop audio or video files',
							});
							return;
						}

						await switchRecordingMode('upload');

						// Convert file paths to File objects. The file-drop event only
						// fires on Tauri, so `tauri` is non-null in this branch.
						if (!tauri) return;
						const { data: files, error } =
							await tauri.fs.pathsToFiles(validPaths);

						if (error) {
							report.error({ cause: error, title: 'Failed to read files' });
							return;
						}

						if (files.length > 0) {
							await uploadRecordings({ files });
						}
					},
				);
			},
			catch: (error) =>
				PageError.SetupDragDropFailed({
					cause: error,
				}),
		});
		if (error) report.error({ cause: error });
	});

	onDestroy(() => {
		unlistenDragDrop?.();
		// Clean up audio URL when component unmounts to prevent memory leaks
		if (latestRecording?.id) {
			services.blobs.audio.revokeUrl(latestRecording.id);
		}
	});

	async function stopAllRecordingModesExcept(modeToKeep: RecordingMode) {
		const recordingModes = [
			{
				mode: 'manual' as const,
				isActive: () => manualRecorder.state === 'RECORDING',
				stop: () => stopManualRecording(),
			},
			{
				mode: 'vad' as const,
				isActive: () => vadRecorder.state !== 'IDLE',
				stop: () => stopVadRecording(),
			},
		] satisfies {
			mode: RecordingMode;
			isActive: () => boolean;
			stop: () => Promise<unknown>;
		}[];

		const modesToStop = recordingModes.filter(
			(recordingMode) =>
				recordingMode.mode !== modeToKeep && recordingMode.isActive(),
		);

		await Promise.all(modesToStop.map((recordingMode) => recordingMode.stop()));
	}

	async function switchRecordingMode(newMode: RecordingMode) {
		await stopAllRecordingModesExcept(newMode);

		if (settings.get('recording.mode') !== newMode) {
			settings.set('recording.mode', newMode);
			report.success({
				title: 'Recording mode switched',
				description: `Switched to ${newMode} recording mode`,
			});
		}
	}
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

<div
	class="flex flex-1 flex-col items-center justify-start gap-4 w-full max-w-lg mx-auto px-4 pt-6 pb-24 sm:justify-center sm:py-0"
>
	<SectionHeader.Root class="xs:flex hidden flex-col items-center gap-4">
		<SectionHeader.Title
			level={1}
			class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
		>
			Whispering
		</SectionHeader.Title>
		<SectionHeader.Description class="text-center">
			Press shortcut → speak → get text. Free and open source ❤️
		</SectionHeader.Description>
	</SectionHeader.Root>

	<ToggleGroup.Root
		type="single"
		bind:value={() => settings.get('recording.mode'),
			(mode) => {
				if (!mode) return;
				void switchRecordingMode(mode as RecordingMode);
			}}
		class="w-full"
	>
		{#each availableModes as option}
			{@const ModeIcon = RECORDING_MODE_ICONS[option.value]}
			<ToggleGroup.Item
				value={option.value}
				aria-label="Switch to {option.label.toLowerCase()} mode"
			>
				<ModeIcon class="size-4" />
				<span class="hidden truncate sm:inline">{option.label}</span>
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>

	{#snippet manualPipeline()}
		<CapturePipeline>
			<ManualDeviceSelector />
			<TranscriptionSelector triggerVariant="pipeline" />
			<TransformationSelector />
		</CapturePipeline>
	{/snippet}

	{#snippet vadPipeline()}
		<CapturePipeline>
			<VadDeviceSelector />
			<TranscriptionSelector triggerVariant="pipeline" />
			<TransformationSelector />
		</CapturePipeline>
	{/snippet}

	{#if settings.get('recording.mode') === 'manual'}
		<div class="flex w-full flex-col items-center gap-3">
			<ManualRecordingAction
				pipeline={manualPipeline}
			/>
			{#if manualRecorder.state === 'RECORDING'}
				<Button
					tooltip="Cancel recording and discard audio"
					onclick={() => commandCallbacks.cancelRecording()}
					variant="ghost-destructive"
					size="sm"
					style="view-transition-name: {viewTransition.global.cancel};"
				>
					<XIcon class="size-4" />
					Cancel
				</Button>
			{/if}
		</div>
	{:else if settings.get('recording.mode') === 'vad'}
		<div class="flex w-full flex-col items-center gap-3">
			<VadRecordingAction
				pipeline={vadPipeline}
			/>
		</div>
	{:else if settings.get('recording.mode') === 'upload'}
		<div class="flex flex-col items-center gap-4 w-full">
			<FileDropZone
				accept="{ACCEPT_AUDIO}, {ACCEPT_VIDEO}"
				maxFiles={10}
				maxFileSize={25 * MEGABYTE}
				onUpload={async (files) => {
					if (files.length > 0) {
						await uploadRecordings({ files });
					}
				}}
				onFileRejected={({ file, reason }) => {
					report.error({
						cause: PageError.FileRejected({
							fileName: file.name,
							reason,
						}).error,
						title: 'File rejected',
					});
				}}
				class="h-32 sm:h-36 lg:h-40 xl:h-44 w-full"
			/>
			<CapturePipeline>
				<TranscriptionSelector triggerVariant="pipeline" />
				<TransformationSelector />
			</CapturePipeline>
		</div>
	{/if}

	{#if latestRecording}
		<div class="xxs:flex hidden w-full flex-col gap-2">
			<TranscriptDialog
				recordingId={latestRecording.id}
				transcript={latestRecording.transcript}
				rows={1}
				disabled={!latestRecording.transcript.trim()}
				onDelete={() => {
					confirmationDialog.open({
						title: 'Delete recording',
						description: 'Are you sure you want to delete this recording?',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => {
							services.blobs.audio.revokeUrl(latestRecording.id);
							recordings.delete(latestRecording.id);
							report.success({
								title: 'Deleted recording!',
								description: 'Your recording has been deleted.',
							});
						},
					});
				}}
			/>

			{#if audioPlaybackUrlQuery.data}
				<audio
					style="view-transition-name: {viewTransition.recording(
						latestRecording.id,
					).audio}"
					src={audioPlaybackUrlQuery.data}
					controls
					class="h-8 w-full"
				></audio>
			{/if}
		</div>
	{/if}

	<div class="xs:flex hidden flex-col items-center gap-3">
		{#if settings.get('recording.mode') === 'manual'}
			<p class="text-foreground/75 text-center text-sm">
				Click the microphone or press
				<Link
					tooltip="Go to local shortcut in settings"
					href="/settings/shortcuts"
				>
					<Kbd.Root
						>{getShortcutDisplayLabel(
							settings.get('shortcut.toggleManualRecording'),
						)}</Kbd.Root
					>
				</Link>
				to start recording here.
			</p>
			{#if tauri}
				<p class="text-foreground/75 text-sm">
					Press
					<Link
						tooltip="Go to global shortcut in settings"
						href="/settings/shortcuts"
					>
						<Kbd.Root>{globalToggleLabel}</Kbd.Root>
					</Link>
					to start recording anywhere.
				</p>
			{/if}
		{:else if settings.get('recording.mode') === 'vad'}
			<p class="text-foreground/75 text-center text-sm">
				Click the microphone or press
				<Link
					tooltip="Go to local shortcut in settings"
					href="/settings/shortcuts"
				>
					<Kbd.Root
						>{getShortcutDisplayLabel(
							settings.get('shortcut.toggleVadRecording'),
						)}</Kbd.Root
					>
				</Link>
				to start a voice activated session.
			</p>
		{:else if settings.get('recording.mode') === 'upload'}
			{#if tauri}
				<p class="text-foreground/75 text-sm">
					Press
					<Link
						tooltip="Go to global shortcut in settings"
						href="/settings/shortcuts"
					>
						<Kbd.Root>{globalToggleLabel}</Kbd.Root>
					</Link>
					to start recording instead.
				</p>
			{/if}
		{/if}
		<p class="text-muted-foreground text-center text-sm font-light">
			{#if !tauri}
				Tired of switching tabs?
				<Link
					tooltip="Get Whispering for desktop"
					href="https://epicenter.so/whispering"
					target="_blank"
					rel="noopener noreferrer"
				>
					Get the native desktop app
				</Link>
			{/if}
		</p>
	</div>
</div>
