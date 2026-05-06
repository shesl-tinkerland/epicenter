<script lang="ts">
	import { fromTable } from '@epicenter/svelte';
	import { onDestroy, type Snippet } from 'svelte';
	import type { FujiSignedIn } from '$lib/session.svelte';
	import { setSignedInSession } from '$lib/signed-in-session';

	let {
		signedIn,
		children,
	}: {
		signedIn: FujiSignedIn;
		children: Snippet;
	} = $props();

	// Plain const capture: read the prop exactly once at mount. Everything
	// below reads `captured`, never `signedIn`. This sidesteps Svelte's
	// teardown semantics: descendants reading getSignedInSession() during
	// the unmount frame walk a closure over plain JS, not a prop signal.
	// svelte-ignore state_referenced_locally
	const captured = signedIn;

	const entriesMap = fromTable(captured.fuji.tables.entries);
	const entriesActive = $derived(
		[...entriesMap.values()].filter((e) => e.deletedAt === undefined),
	);
	const entriesDeleted = $derived(
		[...entriesMap.values()].filter((e) => e.deletedAt !== undefined),
	);

	setSignedInSession({
		...captured,
		entries: {
			get: (id) => entriesMap.get(id),
			get active() {
				return entriesActive;
			},
			get deleted() {
				return entriesDeleted;
			},
		},
	});

	onDestroy(() => entriesMap[Symbol.dispose]());
</script>

{@render children()}
