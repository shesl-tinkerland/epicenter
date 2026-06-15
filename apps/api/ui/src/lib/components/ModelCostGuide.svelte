<script lang="ts">
	import { providerLabel } from '@epicenter/constants/ai-providers';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import * as Table from '@epicenter/ui/table';
	import { createQuery } from '@tanstack/svelte-query';
	import { billing } from '$lib/billing/queries';

	const models = createQuery(() => billing.models.options);
</script>

{#if models.isPending}
	<div class="space-y-2">
		{#each Array(10) as _}
			<Skeleton class="h-8 w-full" />
		{/each}
	</div>
{:else if models.isError}
	<p class="text-sm text-destructive">Failed to load model costs.</p>
{:else}
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Model</Table.Head>
				<Table.Head>Provider</Table.Head>
				<Table.Head class="text-right">Credits/call</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each models.data?.models ?? [] as row (row.model)}
				<Table.Row>
					<Table.Cell class="font-mono text-xs">{row.model}</Table.Cell>
					<Table.Cell class="text-muted-foreground text-xs">
						{providerLabel(row.provider)}
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{row.credits}</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
{/if}
