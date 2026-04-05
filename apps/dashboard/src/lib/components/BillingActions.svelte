<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { api } from '$lib/api';
	import { queryClient } from '$lib/query/client';

	const topUp = createMutation(() => ({
		mutationFn: async () => {
			const res = await api.api.billing['top-up'].$post({
				json: { successUrl: window.location.href },
			});
			if (!res.ok) throw new Error('Top-up failed');
			return res.json();
		},
		onSuccess: (result: { paymentUrl?: string }) => {
			if (result.paymentUrl) {
				window.location.href = result.paymentUrl;
			} else {
				toast.success('Credits added to your account');
				queryClient.invalidateQueries({ queryKey: ['billing'] });
			}
		},
		onError: () => {
			toast.error('Top-up failed. Please try again.');
		},
	}));

	async function openPortal() {
		const res = await api.api.billing.portal.$get();
		if (!res.ok) {
			toast.error('Could not open billing portal.');
			return;
		}
		const data = await res.json();
		if (data.url) {
			window.location.href = data.url;
		}
	}
</script>

<section class="flex flex-wrap gap-3">
	<Button
		variant="outline"
		onclick={() => topUp.mutate()}
		disabled={topUp.isPending}
	>
		{#if topUp.isPending}
			<Spinner class="size-3.5" />
		{:else}
			Buy 500 credits — $5
		{/if}
	</Button>

	<Button variant="outline" onclick={openPortal}> Manage billing </Button>
</section>
