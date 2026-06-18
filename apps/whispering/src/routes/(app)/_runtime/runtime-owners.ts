import { dictationCapability } from '$lib/state/dictation-capability.svelte';
import { attachAnalytics } from './attach-analytics.svelte';
import { attachAutoPasteGrant } from './attach-auto-paste-grant.svelte';
import { attachDebugCommands } from './attach-debug-commands';
import { attachDeepLinkNavigation } from './attach-deep-link-navigation';
import { attachGlobalShortcuts } from './attach-global-shortcuts';
import { attachLocalModelState } from './attach-local-model-state';
import { attachLocalShortcutListener } from './attach-local-shortcut-listener.svelte';
import { attachRecordingOverlay } from './attach-recording-overlay.svelte';
import { attachRecordingRetention } from './attach-recording-retention.svelte';
import { attachUnloadPolicy } from './attach-unload-policy.svelte';
import { attachUpdateCheck } from './attach-update-check';
import { attachSyncIconWithRecorderState } from './sync-icon-with-recorder-state.svelte';
import type { RuntimeOwner } from './types';

export const runtimeOwners = [
	{ attach: attachDebugCommands },
	{ attach: attachAnalytics },
	{ attach: attachLocalShortcutListener },
	{ attach: attachGlobalShortcuts },
	{ attach: attachSyncIconWithRecorderState },
	{ attach: attachRecordingOverlay },
	{ attach: attachUnloadPolicy },
	{ attach: attachRecordingRetention },
	{ attach: attachUpdateCheck },
	{ attach: attachDeepLinkNavigation },
	{ attach: attachLocalModelState },
	{ attach: attachAutoPasteGrant },
	{ attach: dictationCapability.attach },
] satisfies RuntimeOwner[];
