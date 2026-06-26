<script lang="ts">
	import { normalizeInstanceUrl } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import type { InstanceSetting } from './instance-setting.js';

	let {
		open = $bindable(false),
		setting,
		appName,
	}: {
		open?: boolean;
		/** The app's bound instance setting (its storage key + hosted default). */
		setting: InstanceSetting;
		/** The app's display name, woven into the description copy. */
		appName: string;
	} = $props();

	// Read once when the component mounts; saving reloads the app, so there is no
	// live value to track.
	const instance = setting.readInstance();
	const hasOverride = !setting.isDefaultInstance(instance);

	let urlInput = $state(hasOverride ? instance.baseURL : '');
	let tokenInput = $state(instance.token ?? '');
	let urlError = $state<string | null>(null);

	// No pre-save connection test: saving reloads, and the signed-out gate then
	// reports connected-or-failed (with a "Retry connection") from the auth
	// client's own boot check. One surface verifies the credential, not two.
	function save() {
		const { data: baseURL, error } = normalizeInstanceUrl(urlInput);
		if (error) {
			urlError = error.message;
			return;
		}
		setting.writeInstance({ baseURL, token: tokenInput.trim() || undefined });
		location.reload();
	}

	function useHosted() {
		setting.clearInstance();
		location.reload();
	}
</script>

<Modal.Root bind:open>
	<Modal.Content class="sm:max-w-md">
		<Modal.Header>
			<Modal.Title>Connect to a self-hosted instance</Modal.Title>
			<Modal.Description>
				Point {appName} at your own Epicenter star. Your data and token go only to
				this origin; the hosted cloud is never an endpoint.
			</Modal.Description>
		</Modal.Header>
		<div class="flex flex-col gap-4">
			<div class="space-y-1.5">
				<Label for="instance-url">Instance URL</Label>
				<Input
					id="instance-url"
					bind:value={urlInput}
					placeholder="http://localhost:8788"
					autocomplete="off"
					autocapitalize="off"
					spellcheck={false}
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="instance-token">Instance token</Label>
				<Input
					id="instance-token"
					type="password"
					bind:value={tokenInput}
					placeholder="Paste the token your instance printed"
					autocomplete="off"
				/>
				<p class="text-xs text-muted-foreground">
					Leave blank to sign in with Epicenter OAuth against this origin
					instead.
				</p>
			</div>
			{#if urlError}
				<p class="text-xs text-destructive">{urlError}</p>
			{/if}
		</div>
		<Modal.Footer class="flex-col gap-2 sm:flex-row sm:justify-between">
			{#if hasOverride}
				<Button variant="ghost" type="button" onclick={useHosted}>
					Use hosted Epicenter
				</Button>
			{/if}
			<Button class="sm:ml-auto" type="button" onclick={save}>
				Save and reload
			</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
