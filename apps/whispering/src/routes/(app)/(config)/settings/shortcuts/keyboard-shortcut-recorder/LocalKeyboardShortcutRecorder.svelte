<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Command } from '$lib/commands';
	import { report } from '$lib/report';
	import { shortcuts } from '#platform/shortcuts';
	import { os } from '#platform/os';
	import type { KeyBinding } from '$lib/tauri/commands';
	import {
		keyBindingToLabel,
		keyBindingToString,
		parseManualBinding,
	} from '$lib/utils/key-binding';
	import { createChordRecorder } from './create-chord-recorder';
	import RecorderShell from './RecorderShell.svelte';

	const {
		command,
		placeholder,
	}: {
		command: Command;
		placeholder?: string;
	} = $props();

	const binding = $derived(shortcuts.current(command.id));
	const label = $derived(binding ? keyBindingToLabel(binding, os.isApple) : null);

	// Whether the recorder popover is open, and whether a capture session is
	// running inside it.
	let open = $state(false);
	let capturing = $state(false);

	const chordRecorder = createChordRecorder({
		onCapture: (next) => void commit(next),
	});

	function startSession() {
		capturing = true;
		chordRecorder.start();
	}

	function stopSession() {
		if (!capturing) return;
		capturing = false;
		chordRecorder.stop();
	}

	// If the recorder is torn down mid-capture (route change or the popover
	// dismissed by unmount), the window listeners would leak; always stop.
	onDestroy(stopSession);

	// Report why a binding is refused (the seam owns the policy: an exact duplicate
	// would make the matcher fire two commands). Returns true when refused.
	function rejectConflict(next: KeyBinding): boolean {
		const reason = shortcuts.findConflict(command.id, next);
		if (!reason) return false;
		report.error({
			title: 'That shortcut is already in use',
			description: reason,
			cause: {
				name: 'ShortcutConflict',
				message: `${keyBindingToLabel(next, os.isApple)}: ${reason}`,
			},
		});
		return true;
	}

	async function persist(next: KeyBinding) {
		await shortcuts.set(command.id, next);
		report.success({
			title: `Local shortcut set to ${keyBindingToLabel(next, os.isApple)}`,
			description: `Press the shortcut to trigger "${command.title}"`,
		});
	}

	// On a clean capture: refuse a collision (stay listening so the user can retry),
	// otherwise persist and close.
	async function commit(next: KeyBinding) {
		if (rejectConflict(next)) return;
		await persist(next);
		stopSession();
		open = false;
	}

	function submitManual(raw: string): boolean {
		const next = parseManualBinding(raw);
		if (!next) {
			report.error({
				title: 'Invalid shortcut',
				description: 'Try e.g. ctrl+shift+a, space, or a single key like f5.',
				cause: {
					name: 'InvalidManualShortcut',
					message: `"${raw}" is not a valid combination.`,
				},
			});
			return false;
		}
		if (rejectConflict(next)) return false;
		void persist(next).then(() => {
			stopSession();
			open = false;
		});
		return true;
	}

	async function clear() {
		stopSession();
		await shortcuts.clear(command.id);
		report.success({
			title: 'Local shortcut cleared',
			description: `Please set a new shortcut to trigger "${command.title}"`,
		});
	}

	const recorder = {
		get isListening() {
			return capturing;
		},
		get label() {
			return label;
		},
		get manualInitial() {
			return binding ? keyBindingToString(binding) : '';
		},
		start: startSession,
		stop: stopSession,
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
		recordHelp: 'Click to record or edit manually',
		manualHelp: 'Enter shortcut manually (e.g., ctrl+shift+a)',
		manualPlaceholder: 'e.g., ctrl+shift+a',
		manualButtonLabel: 'Edit manually',
		listeningHint: 'Release to set, Esc to cancel',
	}}
/>
