<script lang="ts">
	import * as Accordion from '@epicenter/ui/accordion';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Select from '@epicenter/ui/select';
	import { Separator } from '@epicenter/ui/separator';
	import { Switch } from '@epicenter/ui/switch';
	import { Textarea } from '@epicenter/ui/textarea';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { slide } from 'svelte/transition';
	import { ProviderConfigFields } from '$lib/components/settings';
	import {
		hasModelSelect,
		INFERENCE,
		INFERENCE_PROVIDER_OPTIONS,
		type InferenceProviderId,
	} from '$lib/constants/inference';
	import { getProviderConfigKeys } from '$lib/operations/transform';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { secrets } from '$lib/state/secrets.svelte';
	import { createDefaultPrompt } from '$lib/state/transformations.svelte';
	import type {
		Replacement,
		Transformation,
		TransformationPrompt,
	} from '$lib/workspace';

	let {
		transformation = $bindable(),
	}: {
		transformation: Transformation;
	} = $props();

	type ReplacementPhase = 'preReplacements' | 'postReplacements';

	const providerLabel = (provider: string) =>
		INFERENCE[provider as InferenceProviderId]?.label;

	function updatePrompt(patch: Partial<TransformationPrompt>) {
		if (!transformation.prompt) return;
		transformation = {
			...transformation,
			prompt: { ...transformation.prompt, ...patch },
		};
	}

	/** Switching provider clears the model: there is no per-provider memory. */
	function updateProvider(provider: InferenceProviderId) {
		updatePrompt({ inferenceProvider: provider, model: '' });
	}

	function setPromptEnabled(enabled: boolean) {
		if (enabled) {
			transformation = {
				...transformation,
				prompt: transformation.prompt ?? createDefaultPrompt(),
			};
			return;
		}
		// Without a prompt, pre and post are just one sequential pass: collapse them
		// into a single replacements list so nothing is hidden or orphaned.
		transformation = {
			...transformation,
			prompt: null,
			preReplacements: [
				...transformation.preReplacements,
				...transformation.postReplacements,
			],
			postReplacements: [],
		};
	}

	function updateReplacement(
		phase: ReplacementPhase,
		index: number,
		patch: Partial<Replacement>,
	) {
		transformation = {
			...transformation,
			[phase]: transformation[phase].map((r, i) =>
				i === index ? { ...r, ...patch } : r,
			),
		};
	}

	function addReplacement(phase: ReplacementPhase) {
		transformation = {
			...transformation,
			[phase]: [
				...transformation[phase],
				{ find: '', replace: '', useRegex: false },
			],
		};
	}

	function removeReplacement(phase: ReplacementPhase, index: number) {
		transformation = {
			...transformation,
			[phase]: transformation[phase].filter((_, i) => i !== index),
		};
	}
</script>

{#snippet replacementSection(
	phase: ReplacementPhase,
	heading: string,
	help: string,
)}
	<Field.Set class="gap-4">
		<Field.Legend>{heading}</Field.Legend>
		<Field.Description>{help}</Field.Description>

		<div class="space-y-3">
			{#each transformation[phase] as replacement, index (index)}
				<!-- No transition:slide: replacements are values with no stable
				identity, so the index key would animate the wrong row out on
				mid-list removal. -->
				<div class="bg-card flex flex-col gap-3 rounded-lg border p-4">
					<div class="flex items-start gap-3">
						<div class="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2">
							<Field.Field>
								<Field.Label for="{phase}-find-{index}">Find</Field.Label>
								<Input
									id="{phase}-find-{index}"
									value={replacement.find}
									oninput={(e) =>
										updateReplacement(phase, index, {
											find: e.currentTarget.value,
										})}
									placeholder="Text or pattern to search for"
								/>
							</Field.Field>
							<Field.Field>
								<Field.Label for="{phase}-replace-{index}">Replace</Field.Label>
								<Input
									id="{phase}-replace-{index}"
									value={replacement.replace}
									oninput={(e) =>
										updateReplacement(phase, index, {
											replace: e.currentTarget.value,
										})}
									placeholder="Text to use as the replacement"
								/>
							</Field.Field>
						</div>
						<Button
							tooltip="Remove replacement"
							variant="ghost"
							size="icon"
							class="mt-6 size-8 shrink-0"
							onclick={() => removeReplacement(phase, index)}
						>
							<TrashIcon class="size-4" />
						</Button>
					</div>
					<Field.Field orientation="horizontal">
						<Switch
							id="{phase}-regex-{index}"
							checked={replacement.useRegex}
							onCheckedChange={(v) =>
								updateReplacement(phase, index, { useRegex: v })}
						/>
						<Field.Content>
							<Field.Label for="{phase}-regex-{index}">Use regex</Field.Label>
							<Field.Description>
								Match with a regular expression instead of plain text.
							</Field.Description>
						</Field.Content>
					</Field.Field>
				</div>
			{/each}
		</div>

		<Button variant="outline" class="w-full" onclick={() => addReplacement(phase)}>
			<PlusIcon class="size-4" />
			Add replacement
		</Button>
	</Field.Set>
{/snippet}

<div class="flex h-full flex-col gap-6 overflow-y-auto px-2">
	<SectionHeader.Root>
		<SectionHeader.Title>Configuration</SectionHeader.Title>
		<SectionHeader.Description>
			A transformation applies deterministic find/replace and, optionally, sends
			the text through one AI model. With the prompt on, replacements run both
			before and after it.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<Separator />

	<section class="space-y-4">
		<Field.Field>
			<Field.Label for="title">Title</Field.Label>
			<Input
				id="title"
				value={transformation.title}
				oninput={(e) => {
					transformation = {
						...transformation,
						title: e.currentTarget.value,
					};
				}}
				placeholder="e.g., Format Meeting Notes"
			/>
			<Field.Description>
				A clear, concise name that describes what this transformation does.
			</Field.Description>
		</Field.Field>
		<Field.Field>
			<Field.Label for="description">Description</Field.Label>
			<Textarea
				id="description"
				value={transformation.description}
				oninput={(e) => {
					transformation = {
						...transformation,
						description: e.currentTarget.value,
					};
				}}
				placeholder="e.g., Converts meeting transcripts into bullet points and highlights action items"
			/>
			<Field.Description>
				Describe what this transformation does, its purpose, and how it will be
				used.
			</Field.Description>
		</Field.Field>
	</section>

	<Separator />

	{@render replacementSection(
		'preReplacements',
		transformation.prompt ? 'Pre-replacements' : 'Replacements',
		transformation.prompt
			? 'Run before the prompt, offline and with no API key. Useful for stripping filler or expanding spoken cues like "new paragraph".'
			: 'Deterministic find/replace, offline and with no API key. Strip filler, expand spoken cues like "new paragraph", or fix proper nouns.',
	)}

	<Separator />

	<section class="space-y-4">
		<Field.Field orientation="horizontal">
			<Switch
				id="prompt-enabled"
				checked={transformation.prompt !== null}
				onCheckedChange={setPromptEnabled}
			/>
			<Field.Content>
				<Field.Label for="prompt-enabled">AI prompt</Field.Label>
				<Field.Description>
					Send the text through one model. Turn off for a replacements-only
					transformation.
				</Field.Description>
			</Field.Content>
		</Field.Field>

		{#if transformation.prompt}
			{@const prompt = transformation.prompt}
			{@const provider = prompt.inferenceProvider}
			{@const keys = getProviderConfigKeys(provider)}
			{@const isCustom = provider === 'Custom'}
			<!--
				Custom needs an endpoint (a device setting); every other provider needs
				an API key (a secret read through the facade, available only when set and
				unlocked). A null endpoint key means nothing is required.
			-->
			{@const hasCredential = isCustom
				? !keys.endpointConfigKey ||
					String(deviceConfig.get(keys.endpointConfigKey) ?? '').trim().length >
						0
				: secrets.get(keys.apiKeyConfigKey).status === 'available'}
			<div class="space-y-6" transition:slide>
				<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
					<Field.Field>
						<Field.Label for="inferenceProvider">Provider</Field.Label>
						<Select.Root
							type="single"
							bind:value={() => prompt.inferenceProvider,
							(value) => {
								if (value) updateProvider(value);
							}}
						>
							<Select.Trigger id="inferenceProvider" class="w-full">
								{providerLabel(prompt.inferenceProvider) ?? 'Select a provider'}
							</Select.Trigger>
							<Select.Content>
								{#each INFERENCE_PROVIDER_OPTIONS as item (item.value)}
									<Select.Item value={item.value} label={item.label} />
								{/each}
							</Select.Content>
						</Select.Root>
					</Field.Field>

					{#if hasModelSelect(provider)}
						<Field.Field>
							<Field.Label for="model">Model</Field.Label>
							<Select.Root
								type="single"
								bind:value={() => prompt.model,
								(value) => {
									if (value) updatePrompt({ model: value });
								}}
							>
								<Select.Trigger id="model" class="w-full">
									{prompt.model || 'Select a model'}
								</Select.Trigger>
								<Select.Content>
									{#each INFERENCE[provider].models as model (model)}
										<Select.Item value={model} label={model} />
									{/each}
								</Select.Content>
							</Select.Root>
						</Field.Field>
					{:else if provider === 'OpenRouter'}
						<Field.Field>
							<Field.Label for="model">Model</Field.Label>
							<Input
								id="model"
								value={prompt.model}
								oninput={(e) => updatePrompt({ model: e.currentTarget.value })}
								placeholder="Enter model name"
							/>
						</Field.Field>
					{:else if provider === 'Custom'}
						<Field.Field>
							<Field.Label for="model">Model</Field.Label>
							<Input
								id="model"
								value={prompt.model}
								oninput={(e) => updatePrompt({ model: e.currentTarget.value })}
								placeholder="llama3.2"
							/>
							<Field.Description>
								Enter the exact model name as it appears in your local service
								(e.g., run
								<code class="bg-muted rounded px-1">ollama list</code>).
							</Field.Description>
						</Field.Field>
					{/if}
				</div>

				{#if !hasCredential}
					<Field.Error>
						No {providerLabel(provider)}
						{isCustom ? 'endpoint' : 'API key'} set yet. Add it in Advanced Options
						below to run this transformation. Your key stays on this device, no
						sign-in needed.
					</Field.Error>
				{/if}

				<Field.Field>
					<Field.Label for="systemPromptTemplate">
						System prompt template
					</Field.Label>
					<Textarea
						id="systemPromptTemplate"
						value={prompt.systemPromptTemplate}
						oninput={(e) =>
							updatePrompt({ systemPromptTemplate: e.currentTarget.value })}
						placeholder="Define the AI's role and expertise, e.g., 'You are an expert at formatting meeting notes. Structure the text into clear sections with bullet points.'"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="userPromptTemplate">User prompt template</Field.Label>
					<Textarea
						id="userPromptTemplate"
						value={prompt.userPromptTemplate}
						oninput={(e) =>
							updatePrompt({ userPromptTemplate: e.currentTarget.value })}
						placeholder="Tell the AI what to do with your text. Use {'{{input}}'} where you want your text to appear, e.g., 'Format this transcript into clear sections: {'{{input}}'}'"
					/>
					{#if prompt.userPromptTemplate && !prompt.userPromptTemplate.includes('{{input}}')}
						<Field.Error>
							Remember to include {'{{input}}'} in your prompt: this is where
							your text will be inserted.
						</Field.Error>
					{/if}
				</Field.Field>
				<Accordion.Root type="single" class="w-full">
					<Accordion.Item class="border-none" value="advanced">
						<Accordion.Trigger class="text-sm">
							Advanced Options
						</Accordion.Trigger>
						<Accordion.Content>
							<ProviderConfigFields provider={prompt.inferenceProvider} />
						</Accordion.Content>
					</Accordion.Item>
				</Accordion.Root>
			</div>
		{/if}
	</section>

	{#if transformation.prompt}
		<Separator />

		{@render replacementSection(
			'postReplacements',
			'Post-replacements',
			'Run after the prompt, offline and with no API key. Useful for enforcing formatting the prompt cannot guarantee.',
		)}
	{/if}
</div>
