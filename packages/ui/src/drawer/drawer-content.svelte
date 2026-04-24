<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import type { WithoutChildrenOrChild } from '#/utils.js';
	import { cn } from '#/utils.js';
	import DrawerOverlay from './drawer-overlay.svelte';
	import DrawerPortal from './drawer-portal.svelte';

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		...restProps
	}: DrawerPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DrawerPortal>>;
	} = $props();
</script>

<DrawerPortal {...portalProps}>
	<DrawerOverlay />
	<!-- TODO: Remove onOpenAutoFocus workaround when vaul-svelte releases a version compatible with bits-ui 2.x.
	     vaul-svelte 1.0.0-next.7 depends on bits-ui ^1.1.0, causing an infinite handleFocus recursion
	     with bits-ui 2.x. See: https://github.com/huntabyte/vaul-svelte/issues/135 -->
	<DrawerPrimitive.Content
		bind:ref
		onOpenAutoFocus={(e) => e.preventDefault()}
		data-slot="drawer-content"
		class={cn(
			"before:bg-popover before:border-border relative flex h-auto flex-col bg-transparent p-4 text-sm before:absolute before:inset-2 before:-z-10 before:rounded-4xl before:border before:shadow-xl data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80vh] data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80vh] data-[vaul-drawer-direction=left]:sm:max-w-sm data-[vaul-drawer-direction=right]:sm:max-w-sm group/drawer-content fixed z-50",
			// Override to z-40 to ensure that alert-dialogs (which are at z-50) are always on top of drawers
			"z-40",
			className,
		)}
		{...restProps}
	>
		<div
			class="bg-muted mx-auto mt-4 hidden h-1.5 w-[100px] shrink-0 rounded-full group-data-[vaul-drawer-direction=bottom]/drawer-content:block"
		></div>
		<!-- Custom: Scrollable content area. flex-1 takes remaining space after drag handle,
		     overflow-y-auto enables vertical scrolling when content exceeds drawer height. -->
		<div class="flex-1 overflow-y-auto">{@render children?.()}</div>
	</DrawerPrimitive.Content>
</DrawerPortal>
