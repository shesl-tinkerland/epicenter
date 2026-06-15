<script lang="ts">
	import { onDestroy } from 'svelte';
	import { type Command, commands } from '$lib/commands';
	import { report } from '$lib/report';
	import type { Tauri } from '#platform/tauri';
	import { syncGlobalShortcutsWithSettings } from '$routes/(app)/_layout-utils/register-commands';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';
	import { os } from '#platform/os';
	import {
		bindingsOverlap,
		isEmptyBinding,
		keyBindingToLabel,
		parseManualBinding,
	} from '$lib/utils/key-binding';
	import { validateGlobalBinding } from '$lib/utils/reserved-shortcuts';
	import RecorderShell from './RecorderShell.svelte';

	// `tauri` is passed non-null from the Tauri-gated global settings page; the
	// recorder drives the rdev backend through it. Recording goes through rdev
	// (not webview keydown) so it can capture the Fn key and physical positions.
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

	let open = $state(false);
	let isListening = $state(false);

	// Accumulate the union of every combo the listener reports during a capture,
	// then commit when all keys release (sourced from rdev, not the webview).
	let capturedModifiers = new Set<Modifier>();
	let capturedKeys = new Set<Key>();
	let unlisten: (() => void) | undefined;

	async function startCapture() {
		isListening = true;
		capturedModifiers = new Set();
		capturedKeys = new Set();
		await tauri.globalShortcuts.setCapturing(true);
		unlisten = await tauri.globalShortcuts.listenForCapture((combo) => {
			for (const modifier of combo.modifiers) capturedModifiers.add(modifier);
			for (const key of combo.keys) capturedKeys.add(key);
			// Empty combo = everything released. Commit what we accumulated.
			if (
				isEmptyBinding(combo) &&
				capturedModifiers.size + capturedKeys.size > 0
			) {
				void commitCapture();
			}
		});
	}

	async function stopCapture() {
		isListening = false;
		unlisten?.();
		unlisten = undefined;
		await tauri.globalShortcuts.setCapturing(false);
	}

	// If the recorder is torn down mid-capture (route change, or the popover
	// dismissed by unmount rather than by onOpenChange), nothing else exits
	// capture mode, so Rust would stay capturing and silently swallow every
	// global shortcut. Always leave capture on destroy.
	onDestroy(() => {
		if (isListening) void stopCapture();
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

	async function commitCapture() {
		const next: KeyBinding = {
			modifiers: [...capturedModifiers],
			keys: [...capturedKeys],
		};
		await stopCapture();
		if (!validateAndReport(next)) return;
		await persist(next);
		open = false;
	}

	async function persist(next: KeyBinding) {
		deviceConfig.set(`shortcuts.global.${command.id}`, next);
		await syncGlobalShortcutsWithSettings();
		report.success({
			title: `Global shortcut set to ${keyBindingToLabel(next, os.isApple)}`,
			description: `Press the shortcut to trigger "${command.title}"`,
		});
	}

	async function clear() {
		await stopCapture();
		deviceConfig.set(`shortcuts.global.${command.id}`, null);
		await syncGlobalShortcutsWithSettings();
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
			open = false;
		});
		return true;
	}

	const recorder = {
		get isListening() {
			return isListening;
		},
		get label() {
			return label;
		},
		get manualInitial() {
			return label ?? '';
		},
		start: () => void startCapture(),
		stop: () => void stopCapture(),
		clear: () => void clear(),
		submitManual,
	};
</script>

<RecorderShell
	bind:open
	title={command.title}
	{recorder}
	copy={{
		placeholder,
		recordHelp: 'Press a gesture. Fn and modifier-only holds work here.',
		manualHelp: 'Type a gesture (e.g. fn+space, ctrl+meta)',
		manualPlaceholder: 'e.g. fn+space',
		manualButtonLabel: 'Type manually',
		listeningHint: 'Release to set, Esc to cancel',
	}}
/>
