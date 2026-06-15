<script module lang="ts">
	import { createAiChatFetch, fromTable } from '@epicenter/svelte';
	import { auth } from '$platform/auth';

	// auth is a module singleton, so the wrapped fetch is built once and shared
	// across every mounted ConversationView.
	const aiChatFetch = createAiChatFetch(auth.fetch);

	/**
	 * How long after the last doc update a finish-less trailing assistant
	 * message still counts as live. Past this it derives as interrupted.
	 */
	const STREAM_GRACE_MS = 3000;
</script>

<script lang="ts">
	import {
		AiChatHttpError,
		type AiChatError,
	} from '@epicenter/constants/ai-chat-errors';
	import { API_ROUTES } from '@epicenter/constants/api-routes';
	import { APP_URLS } from '@epicenter/constants/vite';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { toast } from '@epicenter/ui/sonner';
	import XIcon from '@lucide/svelte/icons/x';
	import { generateId } from '@epicenter/workspace';
	import {
		appendUserMessage,
		findActiveChatDocGeneration,
		type ChatDocMessage,
		observeChatDocMessages,
		readChatDocMessages,
	} from '@epicenter/workspace/ai';
	import {
		type ConversationId,
		generateTermId,
		type TermId,
		type Vocabulary,
		ZHONGWEN_DEFAULT_MODEL,
		ZHONGWEN_DEFAULT_PROVIDER,
	} from '@epicenter/zhongwen';
	import { CalendarDateString, InstantString } from '@epicenter/field';
	import { onDestroy } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { requireZhongwen } from '$lib/session';
	import { reviewQueue } from '$lib/review';
	import { reflectionRoster, type ReflectionRoster } from '$lib/reflection';
	import {
		buildVocabularySystemPrompt,
		ZHONGWEN_SYSTEM_PROMPT,
	} from '../chat/system-prompt';
	import ChatInput from './ChatInput.svelte';
	import ChatMessage from './ChatMessage.svelte';
	import ReflectionSheet from './ReflectionSheet.svelte';
	import SelectionSource from './SelectionSource.svelte';
	import WordPopover from './WordPopover.svelte';

	let {
		conversationId,
		showPinyin,
		highlightVocab,
	}: {
		conversationId: ConversationId;
		showPinyin: boolean;
		highlightVocab: boolean;
	} = $props();

	const zhongwen = requireZhongwen();

	// The lens reads the live dictionary to paint tracked words onto every message,
	// the AI's and the learner's. Reactive so bumping a word's comfort recolors it.
	const vocabularyMap = fromTable(zhongwen.tables.vocabulary);
	const vocabularyWords = $derived([...vocabularyMap.values()]);

	type SendError = {
		message: string;
		name?: AiChatError['name'];
	};

	// The durable conversation row (provider/model/title) is read at action
	// time inside the send/kickoff handlers, never in the template (the header
	// owns its reactive display), so a plain read suffices here.
	function readRow() {
		return zhongwen.tables.conversations.get(conversationId).data;
	}

	// The component is keyed on conversationId, so it mounts fresh per
	// conversation: open the transcript doc synchronously and dispose it (and
	// the observer + ticker) on unmount. The cache's grace window absorbs quick
	// back-and-forth switching. conversationId is the keyed identity and never
	// changes within one instance, so a one-time read is intentional.
	// svelte-ignore state_referenced_locally
	const docHandle = zhongwen.conversationDocs.open(conversationId);

	const initialMessages = readChatDocMessages(docHandle.ydoc);
	const mountedAt = Date.now();
	const initialActiveGeneration = findActiveChatDocGeneration(
		initialMessages,
		mountedAt,
	);
	let messages = $state.raw<ChatDocMessage[]>(initialMessages);
	let lastDocChangeAt = $state(initialActiveGeneration ? mountedAt : 0);
	const unobserve = observeChatDocMessages(docHandle.ydoc, () => {
		messages = readChatDocMessages(docHandle.ydoc);
		lastDocChangeAt = Date.now();
	});

	// 1s ticker so recency-derived liveness advances past the grace window
	// even when no doc events arrive.
	let now = $state(Date.now());
	const ticker = setInterval(() => {
		now = Date.now();
	}, 1000);

	onDestroy(() => {
		clearInterval(ticker);
		unobserve();
		docHandle[Symbol.dispose]();
		vocabularyMap[Symbol.dispose]();
	});

	let kickoffController = $state.raw<AbortController | null>(null);
	let sendError = $state<SendError | null>(null);
	let dismissedError = $state(false);
	let inputValue = $state('');

	// The reflection sheet, opened from Finish. The roster is snapshotted at open
	// (so bumping a word does not reshuffle the buckets mid-review); the sheet
	// reads each row's live mastery from `vocabularyWords` for the toggle value.
	let showReflection = $state(false);
	let roster = $state.raw<ReflectionRoster | null>(null);

	/** Today's steering targets, the same query that feeds the system prompt. */
	function inPlayToday(): Vocabulary[] {
		return reviewQueue(zhongwen.tables.vocabulary.scan().rows, {
			today: CalendarDateString.today(),
			newWordsPerDay: zhongwen.kv.get('newWordsPerDay'),
		});
	}

	const trailing = $derived(messages.at(-1));
	const activeGeneration = $derived(
		findActiveChatDocGeneration(messages, now),
	);
	const isRemoteLive = $derived(
		activeGeneration !== undefined && now - lastDocChangeAt < STREAM_GRACE_MS,
	);
	const isGenerating = $derived(kickoffController !== null || isRemoteLive);
	const isThinking = $derived(
		isGenerating &&
			(activeGeneration?.text.length === 0 ||
				(activeGeneration === undefined && trailing?.role !== 'assistant')),
	);
	const isInterrupted = $derived(
		trailing?.role === 'assistant' &&
			trailing.finish === undefined &&
			!isGenerating,
	);
	const failure = $derived(
		trailing?.finish?.kind === 'failed' ? trailing.finish : undefined,
	);
	const error = $derived(sendError?.message ?? failure?.message ?? null);
	const canRetry = $derived(
		sendError?.name === 'GenerationInProgress'
			? activeGeneration === undefined
			: true,
	);

	/**
	 * Preserve the structured server-blocking error. A generic Retry button is a
	 * trap while the server still sees a recent unfinished assistant message.
	 */
	function toSendError(error: unknown): SendError {
		if (
			error instanceof AiChatHttpError &&
			error.detail.name === 'GenerationInProgress'
		) {
			return {
				name: error.detail.name,
				message: 'Previous response is still settling. Try again shortly.',
			};
		}

		return { message: extractErrorMessage(error) };
	}

	/**
	 * Start one server actor for this transcript doc. The AbortController is local
	 * UI state; durable progress and terminal outcome stay in the Yjs doc.
	 */
	async function kickoffGeneration() {
		if (kickoffController) return;
		const controller = new AbortController();
		kickoffController = controller;
		sendError = null;
		dismissedError = false;
		const row = readRow();
		// Steer the AI toward today's words. Recomputed each kickoff so marking a
		// word Known mid-conversation drops it from the next turn's targets. Empty
		// queue → no block, and the chat runs on the base prompt alone.
		const vocabularyPrompt = buildVocabularySystemPrompt(inPlayToday());
		try {
			await aiChatFetch(API_ROUTES.ai.chatDoc.url(APP_URLS.API), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					guid: docHandle.ydoc.guid,
					generationId: generateId(),
					data: {
						provider: row?.provider ?? ZHONGWEN_DEFAULT_PROVIDER,
						model: row?.model ?? ZHONGWEN_DEFAULT_MODEL,
						systemPrompts: vocabularyPrompt
							? [ZHONGWEN_SYSTEM_PROMPT, vocabularyPrompt]
							: [ZHONGWEN_SYSTEM_PROMPT],
					},
				}),
				signal: controller.signal,
			});
			// The kickoff resolving (200) IS the finish signal for the requester.
			// The server cannot write the per-value-encrypted conversations table,
			// and a completed reply only lands while this requester is alive, so
			// the requester owns the list-recency bump on completion.
			zhongwen.tables.conversations.update(conversationId, {
				updatedAt: Date.now(),
			});
		} catch (err) {
			if (!controller.signal.aborted) {
				sendError = toSendError(err);
			}
		} finally {
			if (kickoffController === controller) kickoffController = null;
		}
	}

	/**
	 * A send is one durable transcript write plus one control-plane kickoff. There
	 * is no second message table to reconcile.
	 */
	function sendMessage(content: string) {
		const text = content.trim();
		if (!text || isGenerating) return;
		appendUserMessage(docHandle.ydoc, {
			id: generateId(),
			content: text,
			createdAt: Date.now(),
		});
		const title = readRow()?.title;
		zhongwen.tables.conversations.update(conversationId, {
			title: title === 'New Chat' ? text.slice(0, 50) : title,
			updatedAt: Date.now(),
		});
		void kickoffGeneration();
	}

	function retry() {
		sendError = null;
		dismissedError = false;
		void kickoffGeneration();
	}

	/**
	 * Finish: snapshot which words actually appeared in this transcript (the
	 * matcher run over every message, the learner's and the AI's) against today's
	 * steering targets, then open the reflection sheet. Skippable by construction:
	 * this attaches only to the explicit Finish action, never to navigating away
	 * or deleting.
	 */
	function openReflection() {
		const words = [...vocabularyWords].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		);
		roster = reflectionRoster({ messages, words, inPlay: inPlayToday() });
		showReflection = true;
	}

	function bumpMastery(id: TermId, mastery: Vocabulary['mastery']) {
		zhongwen.tables.vocabulary.update(id, { mastery });
	}

	// The scroll container holding the messages; SelectionSource scopes its
	// text-selection listener to it so selecting in the input or header is ignored.
	let chatListEl = $state.raw<HTMLDivElement | null>(null);

	/**
	 * Capture a selected word into the dictionary at mastery 0, due today, the same
	 * entry shape the Words screen's single-add uses. Re-adding an existing word is
	 * a no-op (dedup on exact text), matching that screen's behavior.
	 */
	function captureWord(text: string) {
		if (vocabularyWords.some((word) => word.text === text)) {
			toast.info(`"${text}" is already in your words`);
			return;
		}
		zhongwen.tables.vocabulary.set({
			id: generateTermId(),
			text,
			mastery: 0,
			dueAt: CalendarDateString.today(),
			createdAt: InstantString.now(),
		});
		toast.success(`Added "${text}"`);
	}

	// One anchored popover serves both entry points: a tap on a lens-highlighted
	// word and a free selection. The phase is owned here (single source of truth):
	// a tap opens 'meaning', a selection opens 'actions', and "What's this?" walks
	// it to 'meaning'. Tap (click) and selection (drag) never collide, since a
	// click leaves the selection collapsed so SelectionSource stays quiet.
	let popover = $state<{
		text: string;
		context: string;
		provider: string;
		model: string;
		phase: 'actions' | 'meaning';
		x: number;
		top: number;
		bottom: number;
	} | null>(null);

	/** The raw text of a message by id: the sentence a gloss reads for context. */
	function contextFor(messageId: string | null): string {
		if (!messageId) return '';
		return messages.find((message) => message.id === messageId)?.text ?? '';
	}

	function openPopover(at: {
		text: string;
		messageId: string | null;
		phase: 'actions' | 'meaning';
		x: number;
		top: number;
		bottom: number;
	}) {
		const row = readRow();
		popover = {
			text: at.text,
			context: contextFor(at.messageId),
			provider: row?.provider ?? ZHONGWEN_DEFAULT_PROVIDER,
			model: row?.model ?? ZHONGWEN_DEFAULT_MODEL,
			phase: at.phase,
			x: at.x,
			top: at.top,
			bottom: at.bottom,
		};
	}

	/** Tap on a highlighted word: open straight to the meaning. Delegated on the
	 * list because the lens spans live inside {@html} message bodies. */
	function openFromTap(event: MouseEvent) {
		const span = (event.target as HTMLElement).closest('[data-vocab]');
		if (!span) return;
		const text = span.getAttribute('data-vocab');
		if (!text) return;
		const messageId =
			span.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
		const rect = span.getBoundingClientRect();
		openPopover({
			text,
			messageId,
			phase: 'meaning',
			x: rect.left + rect.width / 2,
			top: rect.top,
			bottom: rect.bottom,
		});
	}

	function addFromPopover() {
		if (!popover) return;
		captureWord(popover.text);
		popover = null;
	}
</script>

<Chat.List
	bind:ref={chatListEl}
	class="flex-1 overflow-y-auto p-4"
	aria-live="polite"
	onclick={openFromTap}
>
	{#if messages.length === 0}
		<div class="flex flex-1 items-center justify-center text-muted-foreground">
			<p>Ask a question in English and get a response in Chinese and English.</p>
		</div>
	{:else}
		{#each messages as message (message.id)}
			<!-- An empty assistant message is the in-progress turn before its first
				token; the typing bubble below stands in for it. -->
			{#if message.role === 'user' || message.text.length > 0}
				<ChatMessage
					{message}
					{showPinyin}
					{highlightVocab}
					words={vocabularyWords}
				/>
			{/if}
		{/each}
	{/if}

	{#if isThinking}
		<Chat.Bubble variant="received">
			<Chat.BubbleMessage typing />
		</Chat.Bubble>
	{/if}

	{#if error && !dismissedError}
		<div
			class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
		>
			<span class="flex-1">{error}</span>
			{#if canRetry}
				<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
			{/if}
			<Button
				size="sm"
				variant="ghost"
				aria-label="Dismiss"
				onclick={() => (dismissedError = true)}
			>
				<XIcon class="size-3.5" />
			</Button>
		</div>
	{:else if isInterrupted}
		<div
			class="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground"
		>
			<span class="flex-1">This reply was interrupted.</span>
			<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
		</div>
	{/if}
</Chat.List>

{#if messages.length > 0}
	<div class="flex justify-end border-t px-4 py-2">
		<Button variant="outline" size="sm" onclick={openReflection}>
			Finish & review words
		</Button>
	</div>
{/if}

<ChatInput
	bind:value={inputValue}
	{isGenerating}
	onSend={sendMessage}
	onStop={() => kickoffController?.abort()}
/>

<ReflectionSheet
	bind:open={showReflection}
	roster={roster ?? { used: [], met: [], missed: [] }}
	words={vocabularyWords}
	onBump={bumpMastery}
/>

<SelectionSource
	root={chatListEl ?? undefined}
	onSelect={(selection) => openPopover({ ...selection, phase: 'actions' })}
/>

{#if popover}
	<WordPopover
		text={popover.text}
		context={popover.context}
		provider={popover.provider}
		model={popover.model}
		fetchFn={aiChatFetch}
		phase={popover.phase}
		x={popover.x}
		top={popover.top}
		bottom={popover.bottom}
		onAdd={addFromPopover}
		onAskMeaning={() => popover && (popover = { ...popover, phase: 'meaning' })}
		onClose={() => (popover = null)}
	/>
{/if}
