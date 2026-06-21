<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Item from '@epicenter/ui/item';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { outputWritesToCursor } from '$lib/operations/delivery';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';

	// A home banner that fires ONLY when something the user configured is broken,
	// never as a feature pitch. The dictation capability Rust owns already encodes
	// "is anything wrong": the global tap is held (`untrusted`/`broken`, the states
	// `needsAccessibility` covers) only when some configured intent wants the macOS
	// Accessibility grant (a hold-to-talk binding, paste at cursor, or a live
	// capture); with nothing to grant for, the capability settles to
	// `inactive`/`active` and this banner stays silent. Three registers, each a
	// real problem with a fix:
	//   - broken: a stale grant left the global tap dead. A previously-working
	//     shortcut stopped firing, so it is a FAULT: amber glyph, `role="alert"`,
	//     and a primary action.
	//   - untrusted + paste at cursor configured: the paste the user asked for is
	//     silently falling back to the clipboard. A soft fault: amber glyph and a
	//     primary action, but no `role="alert"` (a steady recoverable state, not a
	//     change to announce). The untrusted hold-to-talk gap (no cursor paste) is
	//     surfaced at the shortcut recorder and the dimmed keycap, not here, so the
	//     home banner stays about the non-obvious paste downgrade.
	//   - unsupported (Wayland): a platform FACT, nothing to grant. An info glyph
	//     pointing at the mic that still works; no action.
	// All share one slim outlined `Item` (icon · message · trailing action) at the
	// same size, so backgrounds and padding stay uniform and only the glyph and the
	// action carry the register. None is dismissable: each clears itself when the
	// capability or the cursor toggle flips, and a quiet banner never needs hiding.
	// The detailed steps live in the guide dialog the action opens. The branch order
	// is load-bearing: `broken` is caught before the plain untrusted paste case.
	const cursorPasteNotFiring = $derived(
		dictationCapability.needsAccessibility &&
			!dictationCapability.isStale &&
			outputWritesToCursor(),
	);
</script>

{#if dictationCapability.isStale}
	<Item.Root variant="outline" size="sm" class="w-full" role="alert">
		<Item.Media>
			<TriangleAlertIcon class="text-warning size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Your global shortcut isn't firing</Item.Title>
			<Item.Description>
				Re-granting macOS Accessibility usually fixes it. Until then, transcripts
				go to your clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{:else if cursorPasteNotFiring}
	<Item.Root variant="outline" size="sm" class="w-full">
		<Item.Media>
			<TriangleAlertIcon class="text-warning size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Paste at cursor needs macOS Accessibility</Item.Title>
			<Item.Description>
				You've turned on paste at cursor, but it isn't granted yet. Until you
				grant it, transcripts go to your clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{:else if dictationCapability.isUnsupported}
	<Item.Root variant="outline" size="sm" class="w-full">
		<Item.Media>
			<InfoIcon class="size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Global shortcuts need an X11 session</Item.Title>
			<Item.Description>
				On Wayland, Whispering can't tap your keyboard globally. Click the mic to
				record instead.
			</Item.Description>
		</Item.Content>
	</Item.Root>
{/if}
