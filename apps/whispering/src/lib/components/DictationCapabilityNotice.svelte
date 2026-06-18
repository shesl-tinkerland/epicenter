<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import {
		accessibilityGuide,
		openSystemSettings,
	} from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { clipboardFallback } from '$lib/components/accessibility-feature-copy';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
</script>

<!-- One declarative view over the dictation capability Rust owns: the matching
panel when the global tap cannot fire, nothing while it works (`active`) or is
still seeding (`unknown`). Each state has its own remediation and only the
capability owner can tell them apart, so we read the value, never infer it. The
branch order is load-bearing: `broken` is caught before the plain untrusted case
(`needsAccessibility` covers both), so the last branch is the never-granted pitch. -->
{#if dictationCapability.isUnsupported}
	<!-- Linux Wayland: the tap can never run, so there is nothing to grant.
	Explain the limit, no settings button. -->
	<Alert.Root class="w-full text-left">
		<TriangleAlertIcon class="size-4" aria-hidden="true" />
		<Alert.Title>Global shortcuts need an X11 session</Alert.Title>
		<Alert.Description>
			On Wayland, Whispering can't read your keyboard globally, so the recording
			shortcut and paste-back stay off. Click the microphone to record, or switch
			to an X11 session to use the shortcut. Either way, transcripts go to your
			clipboard.
		</Alert.Description>
	</Alert.Root>
{:else if dictationCapability.isStale}
	<!-- macOS reports Whispering as trusted, but the global tap is not delivering
	events. The common cause is a grant left stale by an app update, which a
	remove-and-re-add fixes, so the guide leads. We do not assert that as the only
	cause: the tap can also stall for reasons re-granting won't touch, so the copy
	stays honest about what we know (it is not firing) and what usually helps. -->
	<Alert.Root class="w-full text-left">
		<TriangleAlertIcon class="size-4" aria-hidden="true" />
		<Alert.Title>Your global shortcut isn't working</Alert.Title>
		<Alert.Description>
			Whispering appears to have macOS Accessibility, but your global shortcut and
			paste-back aren't firing. Re-granting access (remove Whispering from
			Accessibility, then add it back) usually fixes it. Until then, transcripts
			go to your clipboard.
		</Alert.Description>
		<Alert.Action>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Alert.Action>
	</Alert.Root>
{:else if dictationCapability.needsAccessibility}
	<!-- macOS never granted (broken is handled above): an upgrade pitch, not a
	wall. Dictation already works through the keyboard shortcut and the clipboard;
	this grant unlocks two ergonomics features. Open Settings, toggle on. -->
	<Alert.Root class="w-full text-left">
		<WandSparklesIcon class="size-4" aria-hidden="true" />
		<Alert.Title>Hold a key to talk, paste hands-free</Alert.Title>
		<Alert.Description class="space-y-2">
			<p>
				Dictation already works: your shortcut starts recording and the
				transcript lands on your clipboard. Turn on Whispering in macOS
				Accessibility to add two upgrades:
			</p>
			<ul class="list-disc space-y-1 pl-4">
				<li>Hold a key to talk: press to record, release to stop.</li>
				<li>Paste hands-free: transcripts land where you're typing.</li>
			</ul>
			<p>{clipboardFallback}</p>
			<Button
				variant="link"
				class="h-auto p-0 text-sm font-normal"
				onclick={() => accessibilityGuide.open()}
			>
				Already enabled but not working?
			</Button>
		</Alert.Description>
		<Alert.Action>
			<Button size="sm" onclick={openSystemSettings}>Open Settings</Button>
		</Alert.Action>
	</Alert.Root>
{/if}
