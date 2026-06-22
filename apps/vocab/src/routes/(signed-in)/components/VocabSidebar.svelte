<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import type { Conversation, ConversationId } from '@epicenter/vocab';
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
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					size="lg"
					onclick={() => onCreate()}
					tooltipContent="New conversation"
					aria-label="New conversation"
				>
					<MessageSquarePlusIcon class="size-4" />
					<span>New Conversation</span>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Conversations</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each conversations as conv (conv.id)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={conv.id === activeConversationId}
								onclick={() => onSwitch(conv.id)}
								tooltipContent={conv.title}
							>
								<MessageSquareTextIcon class="size-4" />
								<span>{conv.title}</span>
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
