<script lang="ts">
	import { AuthForm } from '@epicenter/svelte/auth-form';
	import { auth } from '$lib/auth';
</script>

<div class="flex h-dvh items-center justify-center">
	<AuthForm
		{auth}
		syncNoun="entries"
		onSocialSignIn={() =>
			auth.signInWithSocialRedirect({
				provider: 'google',
				callbackURL: window.location.origin,
			})}
	/>
</div>
