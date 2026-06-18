<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import type { Component, Snippet } from 'svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';

	// The caller owns its own state machine, so it picks which icon to show
	// and hands us one `icon`. We only decide presentation: a spinner while
	// pending, and the destructive "filled" treatment while `active`.
	let {
		active = false,
		description,
		footer,
		icon: Icon,
		iconViewTransitionName,
		label,
		onclick,
		pending = false,
		shortcutLabel,
		tooltip,
	}: {
		active?: boolean;
		description: string;
		footer?: Snippet;
		icon: Component<{ class?: string }>;
		/**
		 * When set, names the action glyph for a cross-page view transition while
		 * the card is at rest. Suppressed automatically while `active`, because the
		 * live glyph (a stop square, a waveform) is a different object and must not
		 * morph from the resting mode glyph. Callers pass the name unconditionally;
		 * the card owns the at-rest gate.
		 */
		iconViewTransitionName?: string;
		label: string;
		onclick: () => void;
		pending?: boolean;
		shortcutLabel?: string;
		tooltip: string;
	} = $props();

	const accessibleLabel = $derived(
		shortcutLabel ? `${label} (${shortcutLabel})` : label,
	);
</script>

<div
	class={cn(
		'w-full overflow-hidden rounded-lg border border-border/70 bg-card/60 text-foreground shadow-sm ring-1 ring-foreground/5 transition-[background-color,border-color,box-shadow,color] duration-200 hover:border-primary/55 hover:bg-card/75 hover:shadow-md hover:ring-primary/25',
		active &&
			'border-destructive/45 bg-card/70 hover:border-destructive/60 hover:bg-destructive/10 hover:ring-destructive/25',
	)}
>
	<Button
		aria-label={accessibleLabel}
		aria-pressed={active}
		aria-busy={pending}
		{tooltip}
		disabled={pending}
		{onclick}
		variant="ghost"
		class={cn(
			'min-h-24 w-full justify-start gap-3 rounded-none bg-transparent px-3.5 py-3.5 text-left hover:bg-card/70 sm:gap-4 sm:px-4',
			pending && 'cursor-wait',
		)}
	>
		<span
			aria-hidden="true"
			class={cn(
				'flex size-14 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/70 text-foreground shadow-inner transition-colors duration-200 sm:size-16',
				active && 'border-destructive/45 bg-destructive/10 text-destructive',
			)}
		>
			{#if pending}
				<Spinner class="size-7" />
			{:else}
				<span
					class="inline-flex"
					style:view-transition-name={active ? undefined : iconViewTransitionName}
				>
					<Icon
						class={cn('size-7', active && 'size-6 fill-current stroke-[1.75]')}
					/>
				</span>
			{/if}
		</span>
		<span class="flex min-w-0 flex-1 flex-col gap-1">
			<span class="truncate text-base font-semibold leading-none sm:text-lg">
				{label}
			</span>
			<span class="truncate text-xs font-medium text-muted-foreground sm:text-sm">
				{description}
			</span>
		</span>
		{#if shortcutLabel}
			<!-- On desktop the shortcut is the global rdev tap, which only fires when
			the capability is active. Keep showing the key but dim it whenever the tap
			can't fire (macOS Accessibility ungranted or stale, or Linux Wayland),
			reading the same fact the home-page notice does so the two agree. -->
			<Kbd.Root
				class={cn(
					'h-7 max-w-28 shrink-0 rounded-md bg-muted/75 px-2 text-xs text-muted-foreground shadow-none',
					dictationCapability.isUnavailable && 'opacity-50',
				)}
			>
				{shortcutLabel}
			</Kbd.Root>
		{/if}
	</Button>

	{#if footer}
		<div class="border-t border-border/60 bg-background/20 px-3 py-2">
			{@render footer()}
		</div>
	{/if}
</div>
