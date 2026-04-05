<script lang="ts">
	import * as Tabs from '@epicenter/ui/tabs';
	import CreditBalance from '$lib/components/CreditBalance.svelte';
	import UsageChart from '$lib/components/UsageChart.svelte';
	import TopModels from '$lib/components/TopModels.svelte';
	import ModelCostGuide from '$lib/components/ModelCostGuide.svelte';
	import ActivityFeed from '$lib/components/ActivityFeed.svelte';
	import PlanComparison from '$lib/components/PlanComparison.svelte';
	import BillingActions from '$lib/components/BillingActions.svelte';
</script>

<CreditBalance />

<Tabs.Root value="overview">
	<Tabs.List>
		<Tabs.Trigger value="overview">Overview</Tabs.Trigger>
		<Tabs.Trigger value="models">Models</Tabs.Trigger>
		<Tabs.Trigger value="activity">Activity</Tabs.Trigger>
	</Tabs.List>

	<Tabs.Content value="overview" class="pt-6">
		<UsageChart />
		<TopModels />
	</Tabs.Content>

	<Tabs.Content value="models" class="pt-6">
		<ModelCostGuide />
	</Tabs.Content>

	<Tabs.Content value="activity" class="pt-6">
		<ActivityFeed />
	</Tabs.Content>
</Tabs.Root>

<PlanComparison />
<BillingActions />
