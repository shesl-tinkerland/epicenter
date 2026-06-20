<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Empty from '@epicenter/ui/empty';
	import { Kbd } from '@epicenter/ui/kbd';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import { type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { type Candidate, createCandidate } from '$lib/operations/candidates';
	import { persistCompletedRun } from '$lib/operations/transform';
	import { sound } from '$lib/operations/sound';
	import { report } from '$lib/report';
	import { osNotify } from '#platform/os-notify';
	import { services } from '$lib/services';
	import { transformations } from '$lib/state/transformations.svelte';
	import CandidateCards from '$lib/components/CandidateCards.svelte';
	import { revealMainWindow } from '$lib/main-window';
	import * as pickerWindow from './transformationPickerWindow.tauri';

	// The captured selection, handed over by the main window after the shortcut
	// simulates a copy. Empty until the first input event arrives.
	let input = $state('');
	// One candidate per toggled transformation, kept in memory; never persisted
	// until accept. This is the single source of truth for the picker: the chip
	// row's value is derived from it, so the two can never drift apart.
	let candidates = $state<Candidate[]>([]);
	let selectedIndex = $state(0);
	// One-shot guard for accept: it commits exactly one run, so block re-entry
	// while a prior accept is still awaiting its result or hiding the window.
	// Rapid Enter (or Enter + double-click) would otherwise double-persist the
	// run and double-paste into the source app.
	let accepting = $state(false);

	// Which transformations are toggled on, projected from the candidate set. Feeds
	// the chip row as a controlled value; toggling routes back through reconcile.
	const activeIds = $derived(candidates.map((c) => c.transformation.id));

	let unlistenInput: UnlistenFn | null = null;

	onMount(async () => {
		unlistenInput = await pickerWindow.pickerInput.listen((event) =>
			receiveInput(event.payload.input),
		);
		// Tell the main window we're mounted so it replays the pending selection;
		// covers the first open, before the main window knows this webview exists.
		await pickerWindow.pickerReady.emit();
	});

	onDestroy(() => unlistenInput?.());

	// Each open starts fresh over the newly captured selection. Clearing the
	// candidate set also empties the derived chip selection.
	function receiveInput(text: string) {
		input = text;
		candidates = [];
		selectedIndex = 0;
		// The window is hidden and reused, not destroyed, so clear the accept
		// guard on each fresh open or the next accept would stay blocked.
		accepting = false;
	}

	// Rebuild the candidate set to match the toggled id set, the sole writer of
	// `candidates`. Promises of chips that stayed on are kept so they don't re-run;
	// newly toggled chips start one candidate each.
	function reconcile(ids: string[]) {
		const existing = new Map(candidates.map((c) => [c.transformation.id, c]));
		const selectedId = candidates[selectedIndex]?.transformation.id;
		candidates = ids.flatMap((id) => {
			const kept = existing.get(id);
			if (kept) return [kept];
			const transformation = transformations.get(id);
			if (!transformation) return [];
			return [createCandidate({ input, transformation })];
		});
		// Follow the highlighted candidate by identity if it survived the toggle;
		// otherwise clamp into range. Index-only tracking would slide the highlight
		// onto a different result when an earlier chip is removed.
		const survivedAt = candidates.findIndex(
			(c) => c.transformation.id === selectedId,
		);
		selectedIndex =
			survivedAt >= 0
				? survivedAt
				: Math.min(selectedIndex, Math.max(0, candidates.length - 1));
	}

	// Toggle a transformation by id (the number-key path). Mirrors a chip click:
	// compute the next id set and reconcile. `activeIds` is derived from the
	// candidate set, so there is no separate toggle state to keep in sync.
	function toggleTransformation(id: string) {
		reconcile(
			activeIds.includes(id)
				? activeIds.filter((x) => x !== id)
				: [...activeIds, id],
		);
	}

	/**
	 * Accept the highlighted candidate: commit exactly one run and put the result
	 * on the clipboard. The picker deliberately does not paste in place. Pasting
	 * would require handing keyboard focus back to the source app after this window
	 * hides, which macOS does not do reliably while the main window is open (the
	 * main window snatches focus, so the paste lands in the wrong place). So the
	 * universal cross-app, cross-device path delivers to the clipboard and lets the
	 * user paste; in-place insertion belongs to native integrations in the apps
	 * Epicenter owns, not to this window. Feedback is an OS notification, not a
	 * toast: this window hides before it confirms, and the main window may be
	 * hidden too, so a notification is the only surface guaranteed to reach the user.
	 */
	async function accept() {
		if (accepting) return;
		const candidate = candidates[selectedIndex];
		if (!candidate) return;

		accepting = true;
		const result = await candidate.result;
		if (result.error) {
			report.error({ title: 'That result failed', cause: result.error });
			accepting = false;
			return;
		}
		const output = result.data;

		persistCompletedRun({
			transformationId: candidate.transformation.id,
			input: candidate.input,
			output,
			startedAt: candidate.startedAt,
		});
		void sound.playSoundIfEnabled('transformationComplete');

		await services.text.copyToClipboard(output);
		await pickerWindow.hide();
		osNotify('Copied to clipboard', 'Press Cmd+V to paste it where you want.');
	}

	async function dismiss() {
		await pickerWindow.hide();
	}

	async function manageTransformations() {
		await dismiss();
		await revealMainWindow.emit({ path: '/transformations' });
	}

	// Capture phase so the picker owns these keys before the chips' bits-ui roving
	// focus can grab the arrows. Numbers address the chips (inputs); arrows and
	// Enter address the candidate cards (outputs); the two never overlap.
	function onKeydown(event: KeyboardEvent) {
		// If the user is typing in a real input (none today, but a filter box is the
		// obvious next addition), let it own every key. Without this, a digit would
		// toggle a chip and Enter would accept mid-type.
		if (isEditableTarget(event.target)) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			void dismiss();
			return;
		}

		// 1-9 toggle the Nth transformation. `event.code` (Digit1..Digit9) ignores
		// Shift/layout (so Shift+1 isn't "!"). Bare digits only; let Cmd+digit etc.
		// fall through to the OS.
		const digit = digitFromCode(event.code);
		if (digit !== null && !event.metaKey && !event.ctrlKey && !event.altKey) {
			const transformation = transformations.sorted[digit - 1];
			if (transformation) {
				event.preventDefault();
				event.stopPropagation();
				toggleTransformation(transformation.id);
			}
			return;
		}

		if (!candidates.length) return;

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			event.stopPropagation();
			selectedIndex = Math.min(selectedIndex + 1, candidates.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopPropagation();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			event.stopPropagation();
			void accept();
		}
	}

	function digitFromCode(code: string): number | null {
		const match = /^Digit([1-9])$/.exec(code);
		return match ? Number(match[1]) : null;
	}

	function isEditableTarget(target: EventTarget | null): boolean {
		return (
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement ||
			(target instanceof HTMLElement && target.isContentEditable)
		);
	}
</script>

<svelte:window onkeydowncapture={onKeydown} />

<div class="flex h-screen flex-col gap-4 p-6">
	<header class="flex flex-none items-start justify-between gap-2">
		<div class="space-y-1">
			<h2 class="text-2xl font-semibold tracking-tight">Transformations</h2>
			<p class="text-sm text-muted-foreground">
				Toggle transformations to run on your selection, then accept a result
			</p>
		</div>
		<Button variant="ghost" size="sm" onclick={manageTransformations}>
			Manage
		</Button>
	</header>

	<!-- The captured selection, the anchor every result is diffed against. -->
	<Card.Root class="flex-none gap-0 border-dashed bg-muted/30 py-3">
		<Card.Header class="gap-0 px-4 pb-1">
			<Card.Title
				class="text-[0.7rem] font-medium tracking-wider text-muted-foreground uppercase"
			>
				Your selection
			</Card.Title>
		</Card.Header>
		<Card.Content class="px-4">
			<p class="max-h-28 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
				{input}
			</p>
		</Card.Content>
	</Card.Root>

	{#if transformations.sorted.length === 0}
		<Empty.Root class="flex-1 border-0">
			<Empty.Title>No transformations yet</Empty.Title>
			<Empty.Description>
				Create one to run it on your selection.
			</Empty.Description>
			<Empty.Content>
				<Button size="sm" onclick={manageTransformations}>
					Create a transformation
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<ToggleGroup.Root
			type="multiple"
			value={activeIds}
			onValueChange={reconcile}
			class="flex flex-none flex-wrap justify-start gap-2"
		>
			{#each transformations.sorted as transformation, index (transformation.id)}
				<ToggleGroup.Item
					value={transformation.id}
					class="gap-1.5 rounded-md border-0 bg-muted px-4 text-muted-foreground hover:bg-muted/70 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
				>
					{#if index < 9}
						<span class="text-xs tabular-nums opacity-50">{index + 1}</span>
					{/if}
					{transformation.title || 'Untitled transformation'}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>

		{#if candidates.length === 0}
			<div class="flex flex-1 items-center justify-center">
				<p class="text-sm text-muted-foreground">
					Toggle a transformation above to see results.
				</p>
			</div>
		{:else}
			<CandidateCards
				{candidates}
				original={input}
				bind:selectedIndex
				onaccept={accept}
			/>
			<footer
				class="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground"
			>
				<span class="flex items-center gap-1">
					<Kbd>1</Kbd>-<Kbd>9</Kbd> run
				</span>
				<span class="flex items-center gap-1">
					<Kbd>&uarr;</Kbd><Kbd>&darr;</Kbd> pick
				</span>
				<span class="flex items-center gap-1"><Kbd>&crarr;</Kbd> copy</span>
				<span class="flex items-center gap-1"><Kbd>Esc</Kbd> dismiss</span>
			</footer>
		{/if}
	{/if}
</div>
