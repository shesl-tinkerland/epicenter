<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Modal from '@epicenter/ui/modal';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { TimezoneCombobox } from '@epicenter/ui/timezone-combobox';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { IanaTimeZone, type TableWriteError } from '@epicenter/workspace';
	import ClipboardPasteIcon from '@lucide/svelte/icons/clipboard-paste';
	import { requireFuji } from '$lib/session';

	const LINE_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s(.+)$/;
	const fuji = requireFuji();

	/** One-line reason per refusal, matching the Needs Attention page's wording. */
	const REFUSAL_REASON = {
		NewerWriterRefusal: 'written by a newer version of Fuji',
		UnreadableRefusal: 'encrypted with a key this device does not have',
	} satisfies Record<TableWriteError['name'], string>;

	let isOpen = $state(false);
	let rawText = $state('');
	let timezone = $state(IanaTimeZone.current());
	let importing = $state(false);

	const parsed = $derived.by(() => {
		if (!rawText.trim()) return { entries: [], skipped: 0 };

		const lines = rawText.split('\n').filter((l) => l.trim());
		const matched = lines
			.map((line) => LINE_REGEX.exec(line))
			.filter((m) => m !== null);
		const entries = matched.map((m) => ({ iso: m[1]!, text: m[2]! }));
		return { entries, skipped: lines.length - entries.length };
	});

	/**
	 * Send the parsed lines to the workspace and report the outcome. bulkSet
	 * refuses any row whose id already holds a newer or undecryptable entry; with
	 * fresh ids that cannot happen on this path, but if it ever does, say how many
	 * were held back and why instead of reporting a clean import. Clear and close
	 * only on success so a failure leaves the pasted text recoverable.
	 */
	async function importEntries() {
		importing = true;
		try {
			const { written, refused } =
				await fuji.collaboration.actions.entries_bulk_create({
					dateZone: timezone,
					entries: parsed.entries.map(({ iso, text }) => ({
						title: text,
						date: iso,
					})),
				});
			rawText = '';
			isOpen = false;

			if (refused.length === 0) {
				toast.success(`Added ${written} ${written === 1 ? 'entry' : 'entries'}`);
				return;
			}
			const byReason = new Map<TableWriteError['name'], number>();
			for (const { name } of refused) {
				byReason.set(name, (byReason.get(name) ?? 0) + 1);
			}
			toast.warning(`Added ${written}, skipped ${refused.length}`, {
				description: [...byReason]
					.map(([name, n]) => `${n} ${REFUSAL_REASON[name]}`)
					.join(', '),
			});
		} catch (error) {
			toast.error("Couldn't add entries", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			importing = false;
		}
	}
</script>

<Modal.Root bind:open={isOpen}>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon-sm"
					onclick={() => (isOpen = true)}
				>
					<ClipboardPasteIcon class="size-4" />
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>Bulk add entries</Tooltip.Content>
	</Tooltip.Root>
	<Modal.Content class="sm:max-w-lg">
		<Modal.Header>
			<Modal.Title>Bulk Add Entries</Modal.Title>
			<Modal.Description>
				Paste timestamped lines. Each line: ISO 8601 timestamp, then a space,
				then text.
			</Modal.Description>
		</Modal.Header>
		<form
			onsubmit={(e) => {
			e.preventDefault();
			if (parsed.entries.length === 0 || importing) return;
			importEntries();
		}}
			class="flex flex-col gap-4"
		>
			<Textarea
				bind:value={rawText}
				placeholder={"2026-04-08T12:39:54.844Z Your text here\n2026-04-08T13:01:22.000Z Another entry"}
				rows={8}
				class="font-mono text-xs"
			/>
			<div class="space-y-1.5">
				<span class="text-sm font-medium">Timezone</span>
				<TimezoneCombobox bind:value={timezone} />
			</div>
			{#if rawText.trim()}
				<p class="text-sm text-muted-foreground">
					{parsed.entries.length}
					{parsed.entries.length === 1 ? 'entry' : 'entries'}
					parsed
					{#if parsed.skipped > 0}
						, {parsed.skipped} skipped
					{/if}
				</p>
			{/if}
			<Modal.Footer>
				<Button variant="outline" type="button" onclick={() => (isOpen = false)}
					>Cancel</Button
				>
				<Button
					type="submit"
					disabled={parsed.entries.length === 0 || importing}
				>
					{#if importing}
						<Spinner class="size-3.5" />
						<span>Adding</span>
					{:else}
						Add {parsed.entries.length}
						{parsed.entries.length === 1 ? 'entry' : 'entries'}
					{/if}
				</Button>
			</Modal.Footer>
		</form>
	</Modal.Content>
</Modal.Root>
