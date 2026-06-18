<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import { onDestroy } from 'svelte';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { type Command, commands } from '$lib/commands';
	import { report } from '$lib/report';
	import { shortcuts } from '#platform/shortcuts';
	import type { Tauri } from '#platform/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';
	import { os } from '#platform/os';
	import {
		bindingsOverlap,
		isEmptyBinding,
		isTierZeroChord,
		keyBindingToLabel,
		parseManualBinding,
	} from '$lib/utils/key-binding';
	import { validateGlobalBinding } from '$lib/utils/reserved-shortcuts';
	import { createGlobalChordRecorder } from './create-global-chord-recorder';
	import RecorderShell from './RecorderShell.svelte';

	// `tauri` is passed non-null from the Tauri-gated global settings page.
	const {
		command,
		placeholder = 'Press a key combination',
		tauri,
	}: {
		command: Command;
		placeholder?: string;
		tauri: Tauri;
	} = $props();

	const binding = $derived(deviceConfig.get(`shortcuts.global.${command.id}`));
	const label = $derived(binding ? keyBindingToLabel(binding, os.isApple) : null);

	// The recorder is always available here: chords record straight from the
	// webview with no Accessibility grant. Only a platform that can never run
	// global shortcuts at all (Linux Wayland) has nothing to offer.
	const canRecord = $derived(!dictationCapability.isUnsupported);

	// Which backend reads the keys. When the tap is active (trusted and running) it
	// sees everything: Fn, modifier-only holds, and chords. Otherwise the webview
	// reads chords only, with no permission; Fn and holds wait on the grant. The
	// source follows trust reactively, so granting Accessibility mid-capture (the
	// tap spins up because capture holds it) upgrades the open recorder in place.
	const useTapCapture = $derived(dictationCapability.isActive);

	// Whether the recorder popover is open, and whether a capture session is
	// running inside it.
	let open = $state(false);
	let capturing = $state(false);

	// Accumulated across a tap capture: the held combo, committed on release.
	let capturedModifiers = new Set<Modifier>();
	let capturedKeys = new Set<Key>();

	const chordRecorder = createGlobalChordRecorder({
		onCapture: (next) => void commitWebviewChord(next),
	});

	// Exactly one capture brain runs at a time, chosen by trust. If trust flips
	// while the session is open (the user grants Accessibility), this tears down
	// the old brain and starts the right one with no reopen.
	$effect(() => {
		if (!capturing) return;
		if (useTapCapture) {
			capturedModifiers = new Set();
			capturedKeys = new Set();
			// `listenForCapture` resolves async; if trust flips and this effect tears
			// down before it does, detach the moment it lands so the listener cannot
			// leak (the pattern dictation-capability.svelte.ts uses for the same race).
			let torn = false;
			let unlisten: (() => void) | undefined;
			void tauri.globalShortcuts
				.listenForCapture((combo) => {
					for (const modifier of combo.modifiers) capturedModifiers.add(modifier);
					for (const key of combo.keys) capturedKeys.add(key);
					// Empty combo = everything released. Commit what we accumulated.
					if (
						isEmptyBinding(combo) &&
						capturedModifiers.size + capturedKeys.size > 0
					) {
						void commitTapBinding({
							modifiers: [...capturedModifiers],
							keys: [...capturedKeys],
						});
					}
				})
				.then((fn) => {
					if (torn) fn();
					else unlisten = fn;
				});
			return () => {
				torn = true;
				unlisten?.();
			};
		}
		chordRecorder.start();
		return () => chordRecorder.stop();
	});

	async function startSession() {
		capturing = true;
		// Tell the supervisor we are capturing. From the dormant floor this spins
		// the tap up (gated on trust) so an Fn or modifier-only binding is even
		// recordable; when the tap is already running it just enters capture mode.
		// An untrusted user lands in `untrusted`, which lights the upgrade hint.
		await tauri.globalShortcuts.setCapturing(true);
	}

	async function stopSession() {
		if (!capturing) return;
		capturing = false;
		// Drop the capture-hold; the tap tears back down to the floor unless a
		// binding or auto-paste still wants it.
		await tauri.globalShortcuts.setCapturing(false);
	}

	// If the recorder is torn down mid-capture (route change, or the popover
	// dismissed by unmount), nothing else leaves capture mode, so the supervisor
	// would keep holding the tap. Always end the session on destroy.
	onDestroy(() => {
		if (capturing) void stopSession();
	});

	// A gesture's keys must be unique to it. The matcher fires on exact set
	// equality with no prefix resolution, so a gesture that contains (or is
	// contained by) another would shadow it or be unreachable. Refuse the overlap
	// and name the gesture it collides with.
	function overlapReason(next: KeyBinding): string | null {
		for (const other of commands) {
			if (other.id === command.id) continue;
			const otherBinding = deviceConfig.get(`shortcuts.global.${other.id}`);
			if (!otherBinding || isEmptyBinding(otherBinding)) continue;
			if (bindingsOverlap(next, otherBinding)) {
				return `Those keys are already part of the "${other.title}" gesture (${keyBindingToLabel(otherBinding, os.isApple)}). Each global gesture needs its own keys, so a key used by one gesture cannot be part of another.`;
			}
		}
		return null;
	}

	// Reject reserved or overlapping gestures before saving. Returns true when the
	// binding is allowed; otherwise reports why and leaves the current binding
	// untouched.
	function validateAndReport(next: KeyBinding): boolean {
		const reason = validateGlobalBinding(next) ?? overlapReason(next);
		if (!reason) return true;
		report.error({
			title: 'That shortcut is not available',
			description: reason,
			cause: {
				name: 'UnavailableShortcut',
				message: `${keyBindingToLabel(next, os.isApple)}: ${reason}`,
			},
		});
		return false;
	}

	// A webview capture can only legitimately produce a Tier-0 chord (one key plus
	// a non-Fn modifier). A bare key would bind a lone keypress globally, so refuse
	// it and point Fn / modifier-only holds at the grant that unlocks the tap. The
	// recorder stays listening, so the user just adds a modifier and tries again.
	async function commitWebviewChord(next: KeyBinding) {
		if (!isTierZeroChord(next)) {
			report.error({
				title: 'Add a modifier',
				description:
					'A global chord needs a modifier such as Cmd or Ctrl plus one key. To record Fn or a modifier-only hold, grant Accessibility.',
				cause: {
					name: 'NotAChord',
					message: `${keyBindingToLabel(next, os.isApple)} is not a chord the permission-free backend can register.`,
				},
			});
			return;
		}
		if (!validateAndReport(next)) return;
		await finishCapture(next);
	}

	// A tap capture may be a chord, an Fn hold, or a modifier-only hold: all valid.
	async function commitTapBinding(next: KeyBinding) {
		if (!validateAndReport(next)) {
			capturedModifiers = new Set();
			capturedKeys = new Set();
			return;
		}
		await finishCapture(next);
	}

	// Persist first (a Tier-1 binding's `setBindings` keeps the tap held), then
	// drop the capture-hold, so an Fn binding never flaps the tap off and back on.
	async function finishCapture(next: KeyBinding) {
		await persist(next);
		await stopSession();
		open = false;
	}

	async function persist(next: KeyBinding) {
		deviceConfig.set(`shortcuts.global.${command.id}`, next);
		await shortcuts.sync();
		report.success({
			title: `Global shortcut set to ${keyBindingToLabel(next, os.isApple)}`,
			description: `Press the shortcut to trigger "${command.title}"`,
		});
	}

	async function clear() {
		await stopSession();
		deviceConfig.set(`shortcuts.global.${command.id}`, null);
		await shortcuts.sync();
		report.success({
			title: 'Global shortcut cleared',
			description: `Set a new shortcut to trigger "${command.title}"`,
		});
	}

	function submitManual(raw: string): boolean {
		const next = parseManualBinding(raw);
		if (!next) {
			report.error({
				title: 'Invalid shortcut',
				description:
					'Try e.g. fn+space, ctrl+meta, or a modifier-only hold like fn.',
				cause: {
					name: 'InvalidManualShortcut',
					message: `"${raw}" is not a valid combination.`,
				},
			});
			return false;
		}
		if (!validateAndReport(next)) return false;
		void persist(next).then(() => {
			void stopSession();
			open = false;
		});
		return true;
	}

	const recordHelp = $derived(
		useTapCapture
			? 'Press a gesture. Fn and modifier-only holds work here.'
			: 'Press a chord. Fn and holds need Accessibility (see above).',
	);

	const recorder = {
		get isListening() {
			return capturing;
		},
		get label() {
			return label;
		},
		get manualInitial() {
			return label ?? '';
		},
		start: () => void startSession(),
		stop: () => void stopSession(),
		clear: () => void clear(),
		submitManual,
	};
</script>

{#if canRecord}
	<RecorderShell
		bind:open
		title={command.title}
		{recorder}
		copy={{
			placeholder,
			recordHelp,
			manualHelp: 'Type a gesture (e.g. fn+space, ctrl+meta)',
			manualPlaceholder: 'e.g. fn+space',
			manualButtonLabel: 'Type manually',
			listeningHint: 'Release to set, Esc to cancel',
		}}
	>
		{#snippet warning()}
			{#if dictationCapability.needsAccessibility}
				<!-- Chords already record without permission; this is the honest
				upgrade for the holds the webview cannot see, not a wall. -->
				<Alert.Root variant="warning" class="text-xs">
					<AlertTriangle class="size-4" />
					<Alert.Title class="text-xs font-medium">
						Fn and holds need Accessibility
					</Alert.Title>
					<Alert.Description class="space-y-2 text-xs">
						<p>
							Chords record here without any permission. To record Fn
							push-to-talk or a modifier-only hold, grant macOS Accessibility.
						</p>
						<Button
							variant="outline"
							size="sm"
							onclick={() => accessibilityGuide.open()}
						>
							Enable Accessibility
						</Button>
					</Alert.Description>
				</Alert.Root>
			{/if}
		{/snippet}
	</RecorderShell>
{:else}
	<!-- Unsupported (Linux Wayland): no global-shortcut backend, so show the
	current binding read-only with no recorder. -->
	<div class="flex items-center justify-end gap-2">
		{#if label}
			<Kbd.Root>{label}</Kbd.Root>
		{/if}
	</div>
{/if}
