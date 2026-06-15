<script lang="ts">
	import { fromKv, fromTable } from '@epicenter/svelte';
	import {
		type Conversation,
		type ConversationId,
		generateConversationId,
	} from '@epicenter/zhongwen';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { toast } from '@epicenter/ui/sonner';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import { onDestroy } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { requireZhongwen } from '$lib/session';
	import { auth } from '$platform/auth';
	import ConversationView from './components/ConversationView.svelte';
	import ZhongwenSidebar from './components/ZhongwenSidebar.svelte';

	const zhongwen = requireZhongwen();
	const showPinyin = fromKv(zhongwen.kv, 'showPinyin');
	const highlightVocab = fromKv(zhongwen.kv, 'highlightVocab');
	const conversationsMap = fromTable(zhongwen.tables.conversations);

	/**
	 * Read the current table map directly. Startup and delete paths call this
	 * before Svelte necessarily re-materializes the derived `conversations` list.
	 */
	function readSortedConversations(): Conversation[] {
		return [...conversationsMap.values()].sort(
			(a, b) => b.updatedAt - a.updatedAt,
		);
	}

	const conversations = $derived(readSortedConversations());

	let activeConversationId = $state<ConversationId | undefined>();

	/**
	 * Write only the cheap list row. The transcript child doc is opened lazily by
	 * `ConversationView`, keyed by the row id. The model is an app constant
	 * (`ZHONGWEN_MODEL`), so it is not stored per conversation.
	 */
	function createConversationRow(): ConversationId {
		const id = generateConversationId();
		const timestamp = Date.now();
		zhongwen.tables.conversations.set({
			id,
			title: 'New Chat',
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		return id;
	}

	/**
	 * Keep one row active after startup or deletion. `skip` avoids re-selecting a
	 * row that was deleted in the same call stack before Svelte re-materializes
	 * the derived list.
	 */
	function ensureDefaultConversation(skip?: ConversationId): ConversationId {
		const first = readSortedConversations().find(
			(conversation) => conversation.id !== skip,
		);
		return first?.id ?? createConversationRow();
	}

	function createConversation(): ConversationId {
		const id = createConversationRow();
		activeConversationId = id;
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		const wasActive = activeConversationId === conversationId;
		zhongwen.tables.conversations.delete(conversationId);
		if (wasActive) {
			activeConversationId = ensureDefaultConversation(conversationId);
		}
	}

	const unobserveConversations = zhongwen.tables.conversations.observe(() => {
		if (activeConversationId && !conversationsMap.has(activeConversationId)) {
			activeConversationId = ensureDefaultConversation();
		}
	});

	let isDestroyed = false;
	void zhongwen.idb.whenLoaded.then(() => {
		if (!isDestroyed) {
			activeConversationId ??= ensureDefaultConversation();
		}
	});

	onDestroy(() => {
		isDestroyed = true;
		unobserveConversations();
		conversationsMap[Symbol.dispose]();
	});

	/**
	 * Keep the destructive device-local wipe out of the template: the dialog owns
	 * confirmation, then the handler wipes local storage and signs out.
	 */
	function openForgetDeviceDialog() {
		confirmationDialog.open({
			title: 'Forget this device?',
			description:
				'This deletes local Zhongwen data on this device. Account data on the server stays in your account.',
			confirm: { text: 'Forget device', variant: 'destructive' },
			onConfirm: async () => {
				try {
					await zhongwen.wipe();
					await auth.signOut();
				} catch (error) {
					toast.error('Failed to forget this device', {
						description: extractErrorMessage(error),
					});
				}
			},
		});
	}
</script>

<Sidebar.Provider>
	<ZhongwenSidebar
		{conversations}
		{activeConversationId}
		onCreate={createConversation}
		onSwitch={(conversationId) => (activeConversationId = conversationId)}
		onDelete={deleteConversation}
	/>

	<main class="flex h-dvh flex-1 flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">中文 Zhongwen</h1>
				<Button
					variant="ghost"
					size="icon"
					href="/words"
					tooltip="Your words"
				>
					<BookOpenIcon />
				</Button>
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant={showPinyin.current ? 'default' : 'outline'}
					size="sm"
					onclick={() => (showPinyin.current = !showPinyin.current)}
					aria-pressed={showPinyin.current}
					aria-label="Toggle pinyin annotations"
				>
					{showPinyin.current ? 'Hide Pinyin' : 'Show Pinyin'}
				</Button>

				<Button
					variant={highlightVocab.current ? 'default' : 'outline'}
					size="sm"
					onclick={() => (highlightVocab.current = !highlightVocab.current)}
					aria-pressed={highlightVocab.current}
					aria-label="Toggle vocabulary highlights"
				>
					{highlightVocab.current ? 'Hide Words' : 'Show Words'}
				</Button>

				<Button variant="ghost" size="sm" onclick={openForgetDeviceDialog}>
					Forget device
				</Button>
			</div>
		</header>

		{#if activeConversationId}
			{#key activeConversationId}
				<ConversationView
					conversationId={activeConversationId}
					showPinyin={showPinyin.current}
					highlightVocab={highlightVocab.current}
				/>
			{/key}
		{/if}
	</main>
</Sidebar.Provider>
