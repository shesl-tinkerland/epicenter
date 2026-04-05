<script lang="ts">
	import * as Tabs from '@epicenter/ui/tabs';
</script>

<Tabs.Root value="overview">
	<Tabs.List>
		<Tabs.Trigger value="overview">Overview</Tabs.Trigger>
		<Tabs.Trigger value="models">Models</Tabs.Trigger>
		<Tabs.Trigger value="activity">Activity</Tabs.Trigger>
	</Tabs.List>

	<Tabs.Content value="overview">
		<div class="py-6 text-muted-foreground">
			Overview tab — credits, usage chart, top models (Wave 5)
		</div>
	</Tabs.Content>

	<Tabs.Content value="models">
		<div class="py-6 text-muted-foreground">
			Models tab — model cost guide (Wave 5)
		</div>
	</Tabs.Content>

	<Tabs.Content value="activity">
		<div class="py-6 text-muted-foreground">
			Activity tab — event feed (Wave 5)
		</div>
	</Tabs.Content>
</Tabs.Root>
