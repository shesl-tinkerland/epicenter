<!--
	The universal first-run setup flow. Shown by home whenever transcription
	isn't ready (or we're mid-flow), first launch or a later regression alike:
	if you're here, something needs setting up, so the full guided flow is the
	helpful thing. No persisted "have they seen it" flag; home holds the flow
	open with ephemeral state and releases on completion.

	Value-first order: engine -> first dictation (the aha; the mic prompt happens
	in-context here) -> dictate-anywhere upsell (macOS only; reuses the existing
	Accessibility guide and reads the live capability) -> done. Steps are derived
	from live state: the Accessibility step is absent where it has no meaning
	(web, Linux Wayland) and adapts its content to the capability.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Kbd from '@epicenter/ui/kbd';
	import { createMutation } from '@tanstack/svelte-query';
	import type { Component } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { MediaQuery } from 'svelte/reactivity';
	import { fly, scale } from 'svelte/transition';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Loader from '@lucide/svelte/icons/loader-circle';
	import Mic from '@lucide/svelte/icons/mic';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { TranscriptionRuntimeConfig } from '$lib/components/settings';
	import TranscriptionServiceSelect from '$lib/components/settings/TranscriptionServiceSelect.svelte';
	import {
		startManualRecording,
		stopManualRecording,
	} from '$lib/operations/recording';
	import { getTranscriptionReadiness } from '$lib/settings/transcription-validation';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import { tauri } from '#platform/tauri';

	let { onComplete }: { onComplete: () => void } = $props();

	const transcriptionReadiness = $derived(getTranscriptionReadiness());
	const engineReady = $derived(transcriptionReadiness.isReady);
	const shortcutLabel = $derived(getRecordingShortcutLabel('manual'));

	// The Accessibility step exists only where it has meaning: a desktop build
	// that can tap the keyboard at all (not web, not Linux Wayland). Whether the
	// grant is present changes the step's CONTENT, not its existence, so granting
	// mid-step can't make the step vanish.
	const includeAccess = $derived(
		Boolean(tauri) && !dictationCapability.isUnsupported,
	);
	const steps = $derived([
		{ key: 'engine', label: 'Voice engine' },
		{ key: 'try', label: 'First dictation' },
		...(includeAccess
			? [{ key: 'access', label: 'Dictate anywhere' } as const]
			: []),
	] as const);

	let stepIndex = $state(0);
	let done = $state(false);
	const current = $derived(steps[Math.min(stepIndex, steps.length - 1)]);
	const isLastStep = $derived(stepIndex >= steps.length - 1);
	const transitionKey = $derived(done ? 'done' : (current?.key ?? 'engine'));

	const reduceMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
	const flyIn = $derived(
		reduceMotion.current
			? { duration: 0 }
			: { y: 12, duration: 240, easing: cubicOut },
	);
	const popIn = $derived(
		reduceMotion.current
			? { duration: 0 }
			: { start: 0.96, duration: 220, easing: cubicOut },
	);

	// First dictation drives the real recorder. Start and stop are separate
	// mutations because stop awaits the whole transcription pipeline (mirrors
	// ManualRecordingAction).
	const startMutation = createMutation(() => ({
		mutationFn: startManualRecording,
	}));
	const stopMutation = createMutation(() => ({
		mutationFn: stopManualRecording,
	}));
	const isRecording = $derived(manualRecorder.state === 'RECORDING');
	const isStopping = $derived(stopMutation.isPending);
	// The practice transcript is just the latest recording's text, surfaced once
	// the wizard's own stop has resolved. Derived, not an effect-latch: stop awaits
	// the whole pipeline, so by the time `isSuccess` flips the row is already saved,
	// and computing it synchronously avoids a one-frame flash of the Record button
	// between paint and a post-effect assignment.
	const practiceTranscript = $derived(
		stopMutation.isSuccess && !isRecording
			? (recordings.sorted[0]?.transcript?.trim() ?? '')
			: '',
	);
	function toggleRecord() {
		if (isRecording) stopMutation.mutate();
		else startMutation.mutate();
	}

	const requiredSatisfied = $derived(
		current?.key === 'engine' ? engineReady : true,
	);

	function statusOf(i: number) {
		if (done) return 'done';
		if (i > stepIndex) return 'future';
		if (i === stepIndex) return 'current';
		return 'done';
	}
	function next() {
		if (isLastStep) {
			done = true;
			return;
		}
		stepIndex += 1;
	}
	function back() {
		if (done) {
			done = false;
			return;
		}
		stepIndex = Math.max(0, stepIndex - 1);
	}

	let bodyEl = $state<HTMLDivElement | null>(null);
	$effect(() => {
		stepIndex;
		done;
		bodyEl?.focus();
	});
</script>

{#snippet panelHead(Icon: Component, title: string, desc: string)}
	<div
		class="flex size-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary"
	>
		<Icon class="size-5" />
	</div>
	<div class="space-y-1.5">
		<h2 class="text-xl font-semibold tracking-tight text-balance">{title}</h2>
		<p
			class="mx-auto max-w-sm text-sm leading-relaxed text-pretty text-muted-foreground"
		>
			{desc}
		</p>
	</div>
{/snippet}

<div
	class="flex flex-1 flex-col items-center justify-center w-full px-4 py-12 sm:py-16"
>
	<div class="flex w-full max-w-lg flex-col items-center gap-8">
		<!-- Progress header -->
		<div class="flex w-full items-center">
			{#each steps as step, i}
				{@const status = statusOf(i)}
				<div class="flex flex-col items-center gap-2">
					<div
						class="flex size-9 items-center justify-center rounded-full border text-sm font-medium transition-all duration-300 {status ===
						'done'
							? 'border-primary bg-primary text-primary-foreground'
							: status === 'current'
								? 'border-primary text-primary ring-4 ring-primary/15'
								: 'border-border text-muted-foreground'}"
					>
						{#if status === 'done'}
							<span in:scale={popIn}><Check class="size-4" /></span>
						{:else}
							{i + 1}
						{/if}
					</div>
					<span
						class="text-xs font-medium transition-colors {status === 'current'
							? 'text-primary'
							: 'text-muted-foreground'}">{step.label}</span>
				</div>
				{#if i < steps.length - 1}
					<div class="mx-2 mb-6 h-0.5 flex-1 overflow-hidden rounded-full bg-border">
						<div
							class="h-full rounded-full bg-primary transition-all duration-500 ease-out"
							style="width: {i < stepIndex || done ? '100%' : '0%'}"
						></div>
					</div>
				{/if}
			{/each}
		</div>

		<!-- Body -->
		<div bind:this={bodyEl} tabindex="-1" class="w-full outline-none">
			{#key transitionKey}
				<div in:fly={flyIn}>
					{#if done}
						<div class="flex flex-col items-center gap-5 py-6 text-center">
							<div
								class="flex size-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary motion-safe:animate-[success-pop_260ms_ease-out]"
							>
								<Sparkles class="size-6" />
							</div>
							<div class="space-y-1.5">
								<h2 class="text-xl font-semibold tracking-tight">
									{dictationCapability.isActive
										? "You're ready to dictate anywhere"
										: "You're ready to record in Whispering"}
								</h2>
								<p
									class="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground"
								>
									{dictationCapability.isActive
										? 'Press your shortcut in any app, speak, and your words appear.'
										: 'Click the microphone on the home screen and speak. You can turn on dictate-anywhere later.'}
								</p>
							</div>
							{#if dictationCapability.isActive && shortcutLabel}
								<div
									class="inline-flex items-center gap-1.5 rounded-lg bg-muted/60 px-3 py-2 text-sm"
								>
									<span class="text-muted-foreground">Try it now:</span>
									<Kbd.Root>{shortcutLabel}</Kbd.Root>
								</div>
							{/if}
							<Button size="lg" onclick={onComplete}>Start dictating</Button>
						</div>
					{:else if current?.key === 'engine'}
						<div class="w-full space-y-4">
							<div class="space-y-1 text-center">
								<h2 class="text-xl font-semibold tracking-tight">
									Set up your voice engine
								</h2>
								<p class="text-sm text-muted-foreground">
									{transcriptionReadiness.primaryIssue ??
										'Choose what turns your speech into text. You can change it later.'}
								</p>
							</div>
							<!--
								Lead with the recommended setup for the selected service (the
								model download on desktop, the API-key field on web) and tuck the
								full service picker behind a disclosure. A first-run user wants the
								default; the picker is a wall of unfamiliar provider names that
								reads as "this is a developer tool".
							-->
							<TranscriptionRuntimeConfig
								id="first-run-transcription"
								hideServiceSelect
								showAdvanced={false}
							/>
							<Collapsible.Root>
								<Collapsible.Trigger
									class="flex w-full items-center justify-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180"
								>
									Use a different service
									<ChevronDown class="size-4 transition-transform" />
								</Collapsible.Trigger>
								<Collapsible.Content class="pt-4">
									<TranscriptionServiceSelect
										id="first-run-transcription-picker"
										label="Service"
										bind:selected={() => settings.get('transcription.service'),
											(selected) =>
												settings.set('transcription.service', selected)}
									/>
								</Collapsible.Content>
							</Collapsible.Root>
						</div>
					{:else if current?.key === 'try'}
						<Card.Root class="border-border/70 shadow-sm dark:shadow-none dark:ring-1 dark:ring-white/5">
							<Card.Content
								class="flex flex-col items-center gap-5 px-6 py-8 text-center"
							>
								<img src={studioMicrophone} alt="" class="size-14" />
								<div class="space-y-1.5">
									<h2 class="text-xl font-semibold tracking-tight text-balance">
										Try your first dictation
									</h2>
									<p
										class="mx-auto max-w-sm text-sm leading-relaxed text-pretty text-muted-foreground"
									>
										Click record and say anything. Whispering turns it into text.
									</p>
								</div>

								{#if isRecording}
									<div class="flex flex-col items-center gap-3" in:scale={popIn}>
										<div
											class="relative flex size-16 items-center justify-center rounded-full bg-primary/10"
										>
											<span
												class="absolute inset-0 rounded-full bg-primary/15 motion-safe:animate-ping"
											></span>
											<Mic class="relative size-6 text-primary" />
										</div>
										<div class="flex h-8 items-end gap-1" aria-hidden="true">
											{#each Array(7) as _, i}
												<div
													class="eq-bar w-1.5 rounded-full bg-primary"
													style="animation-delay: {i * 0.11}s"
												></div>
											{/each}
										</div>
										<span class="text-sm text-muted-foreground">
											Listening… click to stop
										</span>
									</div>
								{:else if isStopping}
									<span
										class="inline-flex items-center gap-2 text-sm text-muted-foreground"
									>
										<Loader class="size-4 animate-spin" /> Transcribing…
									</span>
								{:else if practiceTranscript}
									<div class="flex w-full flex-col items-center gap-3" in:fly={flyIn}>
										<div
											class="w-full rounded-xl border border-primary/30 bg-primary/5 p-4 text-left"
										>
											<div
												class="mb-1.5 flex items-center gap-2 text-sm font-medium text-primary"
											>
												<Check class="size-4" /> It works
											</div>
											<p class="text-sm leading-relaxed">"{practiceTranscript}"</p>
										</div>
										<Button variant="ghost" size="sm" onclick={toggleRecord}>
											<RotateCw class="size-4" />
											Try again
										</Button>
									</div>
								{:else}
									<Button size="lg" onclick={toggleRecord}>
										<Mic class="size-4" />
										Record
									</Button>
								{/if}
							</Card.Content>
						</Card.Root>
					{:else}
						<Card.Root class="border-border/70 shadow-sm dark:shadow-none dark:ring-1 dark:ring-white/5">
							<Card.Content
								class="flex flex-col items-center gap-5 px-6 py-8 text-center"
							>
								{@render panelHead(
									ShieldCheck,
									'Want to dictate in every app?',
									'To type into any other app (your editor, browser, chat) with a global shortcut, macOS needs Accessibility access. It is optional, and you can turn it on anytime.',
								)}

								{#if dictationCapability.isActive}
									<span
										class="inline-flex items-center gap-2 text-sm font-medium text-primary"
										in:scale={popIn}
									>
										<Check class="size-4" /> Accessibility is on
									</span>
								{:else}
									<Button size="lg" onclick={() => accessibilityGuide.open()}>
										<ShieldCheck class="size-4" />
										{dictationCapability.isStale
											? 'Fix Accessibility access'
											: 'Turn on Accessibility'}
									</Button>
									<p class="-mt-1 text-xs text-muted-foreground">
										Opens a short guide. We detect it automatically once it's on.
									</p>
								{/if}
							</Card.Content>
						</Card.Root>
					{/if}
				</div>
			{/key}
		</div>

		<!-- Controls -->
		{#if !done}
			<div class="flex w-full items-center justify-between">
				<Button variant="ghost" disabled={stepIndex === 0} onclick={back}>
					Back
				</Button>
				{#if current?.key === 'try' && !practiceTranscript}
					<Button variant="ghost" onclick={next}>Skip</Button>
				{:else if current?.key === 'access' && !dictationCapability.isActive}
					<Button variant="ghost" onclick={next}>Skip for now</Button>
				{:else}
					<Button disabled={!requiredSatisfied} onclick={next}>
						{isLastStep ? 'Finish' : 'Continue'}
					</Button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.eq-bar {
		height: 2rem;
		transform-origin: bottom;
		animation: eq 0.9s ease-in-out infinite;
	}
	@keyframes eq {
		0%,
		100% {
			transform: scaleY(0.25);
		}
		50% {
			transform: scaleY(1);
		}
	}
	@keyframes success-pop {
		0% {
			transform: scale(0.7);
			opacity: 0;
		}
		60% {
			transform: scale(1.08);
		}
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.eq-bar {
			animation: none;
			transform: scaleY(0.6);
		}
	}
</style>
