<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { toastOnError } from '@epicenter/ui/sonner';
	import * as Table from '@epicenter/ui/table';
	import {
		DateTimeString,
		type IanaTimeZone,
		type TableParseError,
	} from '@epicenter/workspace';
	import ArrowUpCircleIcon from '@lucide/svelte/icons/arrow-up-circle';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import XIcon from '@lucide/svelte/icons/x';
	import { requireFuji } from '$lib/session';
	import { asEntryId, type Entry } from '$lib/workspace';

	const fuji = requireFuji();

	const conformance = $derived(fuji.entries.conformance);

	const causeLabel = {
		ValidationFailed: 'Does not match the schema',
		MigrationFailed: 'Migration failed',
		UnknownVersion: 'Unrecognized version stamp',
	} satisfies Record<TableParseError['name'], string>;

	/**
	 * Rebuild a valid entry from a nonconforming row, keeping every field
	 * that still fits the current schema and defaulting the rest. Every parse
	 * error carries the raw stored value, so all three nonconforming causes
	 * (failed validation, failed migration, corrupt version stamp) repair the
	 * same way: coerce what fits, default the rest, and let set() restamp the
	 * current version.
	 */
	function repairEntry(error: TableParseError): Entry {
		const raw = error.row as Record<string, unknown>;
		const now = DateTimeString.now();
		const str = (v: unknown) => (typeof v === 'string' ? v : '');
		const strings = (v: unknown) =>
			Array.isArray(v)
				? v.filter((x): x is string => typeof x === 'string')
				: [];
		return {
			id: asEntryId(error.id),
			title: str(raw.title),
			subtitle: str(raw.subtitle),
			type: strings(raw.type),
			tags: strings(raw.tags),
			pinned: raw.pinned === true,
			rating: typeof raw.rating === 'number' ? raw.rating : 0,
			deletedAt: DateTimeString.is(raw.deletedAt) ? raw.deletedAt : null,
			date: DateTimeString.is(raw.date) ? raw.date : now,
			dateZone: (typeof raw.dateZone === 'string'
				? raw.dateZone
				: 'UTC') as IanaTimeZone,
			createdAt: DateTimeString.is(raw.createdAt) ? raw.createdAt : now,
			updatedAt: now,
		};
	}

	function discard(error: TableParseError) {
		confirmationDialog.open({
			title: 'Discard this entry?',
			description: `Entry "${error.id}" will be permanently removed. This cannot be undone.`,
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => {
				fuji.tables.entries.delete(asEntryId(error.id));
			},
		});
	}
</script>

<main class="flex h-full flex-1 flex-col overflow-hidden">
	<div class="flex items-center justify-between border-b px-4 py-2">
		<h2 class="text-sm font-semibold">Needs Attention</h2>
		<span class="text-xs text-muted-foreground">
			{conformance.rows.length} entries match the current schema
		</span>
	</div>

	{#if conformance.nonconforming.length === 0 && conformance.newerWriter.length === 0}
		<Empty.Root class="flex-1">
			<Empty.Media>
				<CircleCheckIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Every entry matches the schema</Empty.Title>
			<Empty.Description>
				Entries that fail the schema or come from a newer Fuji will appear
				here.
			</Empty.Description>
		</Empty.Root>
	{:else}
		<div class="flex-1 space-y-4 overflow-auto p-4">
			{#if conformance.newerWriter.length > 0}
				<Alert.Root variant="warning">
					<ArrowUpCircleIcon class="size-4" />
					<Alert.Title>
						{conformance.newerWriter.length}
						{conformance.newerWriter.length === 1 ? 'entry was' : 'entries were'}
						written by a newer version of Fuji
					</Alert.Title>
					<Alert.Description>
						Update this app to read or edit them. They stay synced and
						untouched; editing here is refused so the newer fields survive.
					</Alert.Description>
				</Alert.Root>
			{/if}

			{#if conformance.nonconforming.length > 0}
				<Alert.Root variant="warning">
					<TriangleAlertIcon class="size-4" />
					<Alert.Title>
						{conformance.nonconforming.length}
						{conformance.nonconforming.length === 1
							? 'entry does'
							: 'entries do'}
						not match the current schema
					</Alert.Title>
					<Alert.Description>
						The data is intact but hidden from your lists. Repair keeps the
						fields that still fit and fills in defaults for the rest; discard
						removes the entry permanently.
					</Alert.Description>
				</Alert.Root>

				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Entry</Table.Head>
							<Table.Head>Cause</Table.Head>
							<Table.Head>Details</Table.Head>
							<Table.Head class="w-[100px]"></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each conformance.nonconforming as error (error.id)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{error.id}</Table.Cell>
								<Table.Cell>{causeLabel[error.name]}</Table.Cell>
								<Table.Cell class="max-w-md truncate text-muted-foreground">
									{error.message}
								</Table.Cell>
								<Table.Cell>
									<div class="flex items-center justify-end gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											title="Repair entry"
											onclick={() => {
												toastOnError(
													fuji.tables.entries.set(repairEntry(error)),
													'Couldn\'t repair entry',
												);
											}}
										>
											<WrenchIcon class="size-4" />
										</Button>
										<Button
											variant="ghost-destructive"
											size="icon-sm"
											title="Discard entry"
											onclick={() => discard(error)}
										>
											<XIcon class="size-4" />
										</Button>
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}

			{#if conformance.newerWriter.length > 0}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Entry</Table.Head>
							<Table.Head>Written by</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each conformance.newerWriter as error (error.id)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{error.id}</Table.Cell>
								<Table.Cell class="text-muted-foreground">
									Schema version {error.version}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</div>
	{/if}
</main>
