<script lang="ts">
	import type { InstanceSetting, SyncAuthClient } from '@epicenter/auth';
	import { cn } from '@epicenter/ui/utils';
	import InstanceSettingsModal from './instance-settings-modal.svelte';
	import SignInPanel from './sign-in-panel.svelte';

	let {
		appName,
		tagline,
		auth,
		setting,
		class: className = 'h-dvh',
	}: {
		/** The app's display name, shown in the hosted sign-in heading. */
		appName: string;
		/** One-line hosted sign-in subheading (e.g. "Sync your notes across devices."). */
		tagline: string;
		/** The app's auth client; its `startSignIn` drives the button. */
		auth: SyncAuthClient;
		/** The shared instance setting handle this app injected. */
		setting: InstanceSetting;
		/**
		 * Container sizing/background classes. Defaults to a full-viewport page
		 * gate; an extension side panel injects its own height chain and
		 * background (e.g. "h-full bg-background").
		 */
		class?: string;
	} = $props();

	let modalOpen = $state(false);
	// SignInPanel owns the hosted/self-host heading flip; this wrapper owns the
	// centered page shell and the settings modal lifetime.
</script>

<div
	class={cn(
		'flex flex-col items-center justify-center gap-3 px-6 text-center',
		className,
	)}
>
	<SignInPanel
		{auth}
		title={`Sign in to ${appName}`}
		description={tagline}
		instance={{ setting, onConfigure: () => (modalOpen = true) }}
		class="w-full max-w-xs"
	/>
</div>

<InstanceSettingsModal bind:open={modalOpen} {appName} {setting} />
