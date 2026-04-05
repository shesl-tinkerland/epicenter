<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { ModeWatcher } from 'mode-watcher';
	import { queryClient } from '$lib/query/client';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><title>Billing — Epicenter</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<div class="min-h-screen bg-background text-foreground">
		<div class="mx-auto max-w-5xl px-6 py-12">
			<header class="mb-10">
				<h1 class="text-2xl font-semibold tracking-tight">Billing</h1>
				<p class="mt-1 text-sm text-muted-foreground">
					Manage your plan, credits, and usage.
				</p>
			</header>
			{@render children()}
		</div>
	</div>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<SvelteQueryDevtools client={queryClient} buttonPosition="bottom-right" />
