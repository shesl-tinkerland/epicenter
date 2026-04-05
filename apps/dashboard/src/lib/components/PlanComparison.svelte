<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { api } from '$lib/api';
	import { balanceQueryOptions, plansQueryOptions } from '$lib/query/billing';
	import { queryClient } from '$lib/query/client';

	/** Visible plan IDs in display order. Free is NOT shown as a card. */
	const VISIBLE_PLAN_IDS = {
		monthly: ['pro', 'ultra', 'max'] as const,
		annual: ['pro_annual', 'ultra_annual', 'max_annual'] as const,
	};

	const PLAN_DISPLAY = {
		pro: {
			name: 'Pro',
			price: '$20/mo',
			annualPrice: '$17/mo',
			credits: '2,500',
			overage: '$1/100',
			rollover: false,
		},
		ultra: {
			name: 'Ultra',
			price: '$60/mo',
			annualPrice: '$50/mo',
			credits: '10,000',
			overage: '$0.75/100',
			rollover: true,
			isRecommended: true,
		},
		max: {
			name: 'Max',
			price: '$200/mo',
			annualPrice: '$167/mo',
			credits: '50,000',
			overage: '$0.50/100',
			rollover: true,
		},
		pro_annual: {
			name: 'Pro',
			price: '$200/yr',
			annualPrice: '$200/yr',
			credits: '2,500',
			overage: '$1/100',
			rollover: false,
		},
		ultra_annual: {
			name: 'Ultra',
			price: '$600/yr',
			annualPrice: '$600/yr',
			credits: '10,000',
			overage: '$0.75/100',
			rollover: true,
			isRecommended: true,
		},
		max_annual: {
			name: 'Max',
			price: '$2,000/yr',
			annualPrice: '$2,000/yr',
			credits: '50,000',
			overage: '$0.50/100',
			rollover: true,
		},
	} as const;

	let isAnnual = $state(false);
	let confirmDialog = $state<{ planId: string; planName: string } | null>(null);
	let previewData = $state<{
		prorationAmount?: number;
		currency?: string;
	} | null>(null);

	const balance = createQuery(() => balanceQueryOptions());
	const plans = createQuery(() => plansQueryOptions());

	const currentPlanId = $derived(
		balance.data?.subscriptions?.find((s: { addOn?: boolean }) => !s.addOn)
			?.planId ?? 'free',
	);

	const visiblePlanIds = $derived(
		isAnnual ? VISIBLE_PLAN_IDS.annual : VISIBLE_PLAN_IDS.monthly,
	);

	const eligibilityMap = $derived(
		new Map(
			(plans.data?.list ?? []).map(
				(p: { id: string; customerEligibility?: { attachAction: string } }) => [
					p.id,
					p.customerEligibility?.attachAction,
				],
			),
		),
	);

	const previewUpgrade = createMutation(() => ({
		mutationFn: async (planId: string) => {
			const res = await api.api.billing.preview.$post({ json: { planId } });
			if (!res.ok) throw new Error('Failed to preview upgrade');
			return res.json();
		},
	}));

	const attachPlan = createMutation(() => ({
		mutationFn: async (planId: string) => {
			const res = await api.api.billing.upgrade.$post({
				json: { planId, successUrl: window.location.href },
			});
			if (!res.ok) throw new Error('Failed to upgrade');
			return res.json();
		},
		onSuccess: (result: { paymentUrl?: string }) => {
			if (result.paymentUrl) {
				window.location.href = result.paymentUrl;
			} else {
				toast.success('Plan updated successfully');
				confirmDialog = null;
				queryClient.invalidateQueries({ queryKey: ['billing'] });
			}
		},
		onError: () => {
			toast.error('Upgrade failed. Please try again.');
		},
	}));

	async function handleUpgradeClick(planId: string, planName: string) {
		confirmDialog = { planId, planName };
		previewData = null;
		previewUpgrade.mutate(planId, {
			onSuccess: (data) => {
				previewData = data as { prorationAmount?: number; currency?: string };
			},
		});
	}
</script>

<section class="mt-10 mb-8">
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-lg font-semibold">Plans</h2>
		<div class="flex items-center gap-2 rounded-lg bg-muted p-1 text-xs">
			<button
				class="rounded-md px-3 py-1 transition-colors {!isAnnual ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
				onclick={() => (isAnnual = false)}
			>
				Monthly
			</button>
			<button
				class="rounded-md px-3 py-1 transition-colors {isAnnual ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
				onclick={() => (isAnnual = true)}
			>
				Annual
				<span class="ml-1 text-emerald-500">Save ~17%</span>
			</button>
		</div>
	</div>

	{#if plans.isPending}
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{#each Array(3) as _}
				<Skeleton class="h-64" />
			{/each}
		</div>
	{:else}
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{#each visiblePlanIds as planId}
				{@const display = PLAN_DISPLAY[planId]}
				{@const isCurrent = currentPlanId === planId || (isAnnual && currentPlanId === planId.replace('_annual', ''))}
				{@const eligibility = eligibilityMap.get(planId)}
				{@const isRecommended = 'isRecommended' in display && display.isRecommended}

				<Card.Root
					class="{isRecommended ? 'border-primary ring-1 ring-primary' : ''} {isCurrent ? 'border-emerald-700 bg-emerald-950/20' : ''} flex flex-col"
				>
					<Card.Header class="pb-2">
						<div class="flex items-center gap-2">
							<Card.Title>{display.name}</Card.Title>
							{#if isRecommended}
								<Badge variant="default" class="text-xs">Recommended</Badge>
							{/if}
						</div>
						<p class="text-2xl font-bold">
							{isAnnual ? display.annualPrice : display.price}
						</p>
					</Card.Header>
					<Card.Content class="flex-1 space-y-2 text-sm text-muted-foreground">
						<p>{display.credits} credits/mo</p>
						<p>{display.overage} overage</p>
						<p>All AI models</p>
						{#if display.rollover}
							<p class="text-emerald-400">∞ credit rollover</p>
						{:else}
							<p>Credits reset monthly</p>
						{/if}
					</Card.Content>
					<Card.Footer>
						{#if isCurrent}
							<Button variant="outline" class="w-full" disabled>
								Current plan
							</Button>
						{:else}
							<Button
								class="w-full"
								variant={eligibility === 'upgrade' ? 'default' : 'secondary'}
								onclick={() => handleUpgradeClick(planId, display.name)}
							>
								{eligibility === 'upgrade' ? `Upgrade to ${display.name}` : eligibility === 'downgrade' ? `Downgrade to ${display.name}` : `Switch to ${display.name}`}
							</Button>
						{/if}
					</Card.Footer>
				</Card.Root>
			{/each}
		</div>

		<p class="mt-4 text-xs text-muted-foreground text-center">
			Currently on
			{currentPlanId === 'free' ? 'Free (50 credits/mo)' : currentPlanId}. All
			plans include cloud sync, unlimited workspaces, unlimited history, and
			encryption.
		</p>
	{/if}
</section>

<!-- Upgrade confirmation dialog -->
<Dialog.Root
	open={!!confirmDialog}
	onOpenChange={(open) => { if (!open) confirmDialog = null; }}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Upgrade to {confirmDialog?.planName}</Dialog.Title>
			<Dialog.Description>
				{#if previewUpgrade.isPending}
					Calculating cost...
				{:else if previewData?.prorationAmount !== undefined}
					You'll be charged ${(previewData.prorationAmount / 100).toFixed(2)}
					today (prorated).
				{:else}
					Confirm your plan change.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirmDialog = null)}>
				Cancel
			</Button>
			<Button
				onclick={() => { if (confirmDialog) attachPlan.mutate(confirmDialog.planId); }}
				disabled={attachPlan.isPending}
			>
				{#if attachPlan.isPending}
					<Spinner class="size-3.5" />
				{:else}
					Confirm upgrade
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
