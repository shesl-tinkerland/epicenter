<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { SettingSwitch } from '$lib/components/settings';
	import { settings } from '$lib/state/settings.svelte';

	const dictionary = $derived(settings.get('dictionary'));

	let newTerm = $state('');

	function addTerm() {
		const term = newTerm.trim();
		newTerm = '';
		// Injection-only and order-free, so dedupe and ignore blanks; a repeated
		// term would only bloat the prompt block.
		if (!term || dictionary.includes(term)) return;
		settings.set('dictionary', [...dictionary, term]);
	}

	function removeTerm(term: string) {
		settings.set(
			'dictionary',
			dictionary.filter((t) => t !== term),
		);
	}
</script>

<svelte:head> <title>Dictation Settings - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>Dictation</Field.Legend>
	<Field.Description>
		Control how Whispering polishes and spells your transcripts.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Polish</Field.Legend>
			<Field.Description>
				An always-on AI pass that fixes grammar and punctuation while keeping
				your wording. It runs only when an AI key is configured.
			</Field.Description>
			<Field.Group>
				<SettingSwitch
					key="polish.enabled"
					label="Polish transcripts with AI"
					description="Turn off for speed mode: the raw transcript ships instantly, with no AI call."
				/>

				{#if settings.get('polish.enabled')}
					<Collapsible.Root>
						<Collapsible.Trigger
							class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm [&[data-state=open]>svg]:rotate-180"
						>
							<ChevronDownIcon class="size-4 transition-transform" />
							Advanced
						</Collapsible.Trigger>
						<Collapsible.Content class="pt-3">
							<Field.Field>
								<Field.Label for="polish-instructions">
									Polish instructions
								</Field.Label>
								<Textarea
									id="polish-instructions"
									placeholder={settings.getDefault('polish.instructions')}
									bind:value={
										() => settings.get('polish.instructions'),
										(value) => settings.set('polish.instructions', value)
									}
								/>
								<Field.Description>
									What Polish does to every transcript. Keep it
									meaning-preserving; reshaping (email, to-dos) belongs in
									recipes.
								</Field.Description>
							</Field.Field>
						</Collapsible.Content>
					</Collapsible.Root>
				{/if}
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Dictionary</Field.Legend>
			<Field.Description>
				Proper nouns and domain terms Whispering should know: names, jargon,
				product names. The AI keeps these spellings and maps obvious mishearings
				onto them.
			</Field.Description>
			<Field.Group>
				<form
					class="flex gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						addTerm();
					}}
				>
					<Input placeholder="e.g. Kubernetes" bind:value={newTerm} />
					<Button type="submit" variant="outline">
						<PlusIcon class="size-4" /> Add
					</Button>
				</form>

				{#if dictionary.length > 0}
					<ul class="flex flex-wrap gap-2">
						{#each dictionary as term (term)}
							<li
								class="bg-muted/40 flex items-center gap-1 rounded-md border py-1 pr-1 pl-3 text-sm"
							>
								<span>{term}</span>
								<Button
									variant="ghost"
									size="icon"
									class="size-5"
									aria-label="Remove {term}"
									onclick={() => removeTerm(term)}
								>
									<XIcon class="size-3.5" />
								</Button>
							</li>
						{/each}
					</ul>
				{:else}
					<Field.Description>
						No terms yet. Add the names and jargon you dictate often.
					</Field.Description>
				{/if}
			</Field.Group>
		</Field.Set>
	</Field.Group>
</Field.Set>
