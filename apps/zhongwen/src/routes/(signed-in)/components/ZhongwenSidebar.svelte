<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import type { Conversation, ConversationId } from '@epicenter/zhongwen';
	import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus';
	import MessageSquareTextIcon from '@lucide/svelte/icons/message-square-text';
	import TrashIcon from '@lucide/svelte/icons/trash';

	let {
		conversations,
		activeConversationId,
		onCreate,
		onSwitch,
		onDelete,
	}: {
		conversations: Conversation[];
		activeConversationId: ConversationId | undefined;
		onCreate: () => void;
		onSwitch: (conversationId: ConversationId) => void;
		onDelete: (conversationId: ConversationId) => void;
	} = $props();
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header class="border-b p-2">
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					size="lg"
					class="group-data-[collapsible=icon]:justify-center"
					onclick={onCreate}
					tooltipContent="New conversation"
					aria-label="New conversation"
				>
					<MessageSquarePlusIcon class="size-4" />
					<span class="group-data-[collapsible=icon]:hidden">
						New Conversation
					</span>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Recent Chats</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each conversations as conv (conv.id)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={conv.id === activeConversationId}
								class="group-data-[collapsible=icon]:justify-center"
								onclick={() => onSwitch(conv.id)}
								tooltipContent={conv.title}
								aria-label={conv.title}
							>
								<MessageSquareTextIcon class="size-4" />
								<span class="group-data-[collapsible=icon]:hidden">
									{conv.title}
								</span>
							</Sidebar.MenuButton>
							<Sidebar.MenuAction
								showOnHover
								aria-label="Delete conversation"
								onclick={() => onDelete(conv.id)}
							>
								<TrashIcon class="size-3.5" />
							</Sidebar.MenuAction>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
