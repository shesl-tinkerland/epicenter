<script lang="ts">
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import {
		type AgentId,
		type Conversation,
		type ConversationId,
		DEFAULT_AGENT_ID,
		VOCAB_AGENTS,
	} from '@epicenter/vocab';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
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
		onCreate: (agent: AgentId) => void;
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
					onclick={() => onCreate(DEFAULT_AGENT_ID)}
					tooltipContent="New conversation"
					aria-label="New conversation"
				>
					<MessageSquarePlusIcon class="size-4" />
					<span>New Conversation</span>
				</Sidebar.MenuButton>
				<!--
				 The primary click starts a chat with the default agent; the caret
				 picks a specific one. The bound agent is fixed for the conversation's
				 life (ADR-0025), so this choice is made once, here, at creation.
				-->
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuAction {...props} aria-label="Start a chat with a specific agent">
								<ChevronDownIcon class="size-4" />
							</Sidebar.MenuAction>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" side="right" class="w-44">
						<DropdownMenu.Label>New chat with</DropdownMenu.Label>
						{#each VOCAB_AGENTS as agent (agent.id)}
							<DropdownMenu.Item onclick={() => onCreate(agent.id)}>
								{agent.label}
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
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
