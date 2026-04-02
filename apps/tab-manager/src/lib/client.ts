/**
 * Workspace client — browser-specific wiring and AI-callable actions.
 *
 * Imports the definition from `definition.ts` and adds IndexedDB persistence,
 * BroadcastChannel sync, WebSocket sync, encryption, and action handlers
 * that call Chrome extension APIs.
 *
 * Live browser state (tabs, windows, tab groups) is NOT stored here—Chrome is
 * the sole authority for ephemeral browser state. See `browser-state.svelte.ts`.
 */

import { actionsToClientTools, toToolDefinitions } from '@epicenter/ai';
import { createAuth } from '@epicenter/svelte/auth';
import {
	defineMutation,
	iterateActions,
} from '@epicenter/workspace';
import { createSyncExtension, toWsUrl } from '@epicenter/workspace/extensions/sync/websocket';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import Type from 'typebox';
import { Ok, tryAsync } from 'wellcrafted/result';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import { authSession, getGoogleCredentials } from '$lib/state/auth';
import { userKeyStore } from '$lib/state/key-store';
import { remoteServerUrl, serverUrl } from '$lib/state/settings.svelte';
import { generateBookmarkId, generateSavedTabId } from './workspace/definition';
import { createTabManagerWorkspace } from './workspace/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Singleton
// ─────────────────────────────────────────────────────────────────────────────

export const workspace = buildWorkspaceClient();
export const auth = createAuth({
	baseURL: () => remoteServerUrl.current,
	session: authSession,
	socialTokenProvider: async () => {
		const { idToken, nonce } = await getGoogleCredentials();
		return { provider: 'google', idToken, nonce };
	},
	onLogin(session) {
		workspace.unlockWithKeys(session.encryptionKeys);
		workspace.extensions.sync.reconnect();
	},
	onLogout() {
		workspace.clearLocalData();
		workspace.extensions.sync.reconnect();
	},
});

export const workspaceTools = actionsToClientTools(workspace.actions);
export const workspaceDefinitions = toToolDefinitions(workspaceTools);

export type WorkspaceTools = typeof workspaceTools;
export type WorkspaceActionName = WorkspaceTools[number]['name'];

/**
 * Lookup map from tool name to human-readable title.
 *
 * Used by `ToolCallPart.svelte` to display action titles instead of
 * deriving names from underscore-separated tool names.
 */
export const workspaceToolTitles: Record<string, string> = Object.fromEntries(
	[...iterateActions(workspace.actions)]
		.filter(([action]) => action.title !== undefined)
		.map(([action, path]) => [path.join('_'), action.title!]),
);

/**
 * Register this browser installation as a device in the workspace.
 *
 * Upserts the device row—preserves existing name if present, otherwise
 * generates a default. Called once from App.svelte after workspace is ready.
 */
export async function registerDevice(): Promise<void> {
	await workspace.whenReady;
	const id = await getDeviceId();
	const existing = workspace.tables.devices.get(id);
	const existingName = existing.status === 'valid' ? existing.row.name : null;
	workspace.tables.devices.set({
		id,
		name: existingName ?? (await generateDefaultDeviceName()),
		lastSeen: new Date().toISOString(),
		browser: getBrowserName(),
		_v: 1,
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation (hoisted — function declarations below are available above)
// ─────────────────────────────────────────────────────────────────────────────

function buildWorkspaceClient() {
	return createTabManagerWorkspace()
		.withEncryption({ userKeyStore })
		.withExtension('persistence', indexeddbPersistence)
		.withExtension('broadcast', broadcastChannelSync)
		.withExtension(
			'sync',
			createSyncExtension({
				url: (workspaceId) => toWsUrl(`${serverUrl.current}/workspaces/${workspaceId}`),
				getToken: async () => authSession.current?.token ?? null,
			}),
		)
		.withActions(({ tables, batch }) => ({
			tabs: {
				close: defineMutation({
					title: 'Close Tabs',
					description: 'Close one or more tabs by their IDs.',
					input: Type.Object({
						tabIds: Type.Array(Type.Number()),
					}),
					handler: async ({ tabIds }) => {
						await tryAsync({
							try: () => browser.tabs.remove(tabIds),
							catch: () => Ok(undefined),
						});
						return { closedCount: tabIds.length };
					},
				}),

				open: defineMutation({
					title: 'Open Tab',
					description:
						'Open a new tab with the given URL on the current device.',
					input: Type.Object({
						url: Type.String(),
					}),
					handler: async ({ url }) => {
						const { data: tab, error } = await tryAsync({
							try: () => browser.tabs.create({ url }),
							catch: () => Ok(undefined),
						});
						if (error || !tab) return { tabId: -1 };
						return { tabId: tab.id ?? -1 };
					},
				}),

				activate: defineMutation({
					title: 'Activate Tab',
					description: 'Activate (focus) a specific tab by its ID.',
					input: Type.Object({
						tabId: Type.Number(),
					}),
					handler: async ({ tabId }) => {
						const { error } = await tryAsync({
							try: () => browser.tabs.update(tabId, { active: true }),
							catch: () => Ok(undefined),
						});
						return { activated: !error };
					},
				}),

				save: defineMutation({
					title: 'Save Tabs',
					description:
						'Save tabs for later. Optionally close them after saving.',
					input: Type.Object({
						tabIds: Type.Array(Type.Number()),
						close: Type.Optional(Type.Boolean()),
					}),
					handler: async ({ tabIds, close }) => {
						const deviceId = await getDeviceId();

						// Fetch all tabs in parallel
						const results = await Promise.allSettled(
							tabIds.map((id) => browser.tabs.get(id)),
						);

						const validTabs = results.flatMap((r) => {
							if (r.status !== 'fulfilled' || !r.value.url) return [];
							return [{ ...r.value, url: r.value.url }];
						});

						// Sync writes to Y.Doc
						for (const tab of validTabs) {
							tables.savedTabs.set({
								id: generateSavedTabId(),
								url: tab.url,
								title: tab.title || 'Untitled',
								favIconUrl: tab.favIconUrl,
								pinned: tab.pinned ?? false,
								sourceDeviceId: deviceId,
								savedAt: Date.now(),
								_v: 1,
							});
						}

						// Batch close if requested
						if (close) {
							const idsToClose = validTabs
								.map((t) => t.id)
								.filter((id) => id !== undefined);
							await tryAsync({
								try: () => browser.tabs.remove(idsToClose),
								catch: () => Ok(undefined),
							});
						}

						return { savedCount: validTabs.length };
					},
				}),

				group: defineMutation({
					title: 'Group Tabs',
					description: 'Group tabs together with an optional title and color.',
					input: Type.Object({
						tabIds: Type.Array(Type.Number()),
						title: Type.Optional(Type.String()),
						color: Type.Optional(Type.String()),
					}),
					handler: async ({ tabIds, title, color }) => {
						const { data: groupId, error: groupError } = await tryAsync({
							try: () =>
								browser.tabs.group({
									tabIds: tabIds as [number, ...number[]],
								}),
							catch: () => Ok(undefined),
						});
						if (groupError || groupId === undefined) return { groupId: -1 };

						if (title || color) {
							const updateProps: Browser.tabGroups.UpdateProperties = {};
							if (title) updateProps.title = title;
							if (color)
								updateProps.color = color as `${Browser.tabGroups.Color}`;
							await tryAsync({
								try: () =>
									browser.tabGroups.update(groupId as number, updateProps),
								catch: () => Ok(undefined),
							});
						}

						return { groupId: groupId as number };
					},
				}),

				pin: defineMutation({
					title: 'Pin Tabs',
					description: 'Pin or unpin tabs.',
					input: Type.Object({
						tabIds: Type.Array(Type.Number()),
						pinned: Type.Boolean(),
					}),
					handler: async ({ tabIds, pinned }) => {
						const results = await Promise.allSettled(
							tabIds.map((id) => browser.tabs.update(id, { pinned })),
						);
						return {
							pinnedCount: results.filter((r) => r.status === 'fulfilled')
								.length,
						};
					},
				}),

				mute: defineMutation({
					title: 'Mute Tabs',
					description: 'Mute or unmute tabs.',
					input: Type.Object({
						tabIds: Type.Array(Type.Number()),
						muted: Type.Boolean(),
					}),
					handler: async ({ tabIds, muted }) => {
						const results = await Promise.allSettled(
							tabIds.map((id) => browser.tabs.update(id, { muted })),
						);
						return {
							mutedCount: results.filter((r) => r.status === 'fulfilled')
								.length,
						};
					},
				}),

				reload: defineMutation({
					title: 'Reload Tabs',
					description: 'Reload one or more tabs.',
					input: Type.Object({
						tabIds: Type.Array(Type.Number()),
					}),
					handler: async ({ tabIds }) => {
						const results = await Promise.allSettled(
							tabIds.map((id) => browser.tabs.reload(id)),
						);
						return {
							reloadedCount: results.filter((r) => r.status === 'fulfilled')
								.length,
						};
					},
				}),
			},
			savedTabs: {
				/**
				 * Save a single tab by its metadata—snapshot to Y.Doc and close the browser tab.
				 *
				 * Used by the UI where the BrowserTab object is already available.
				 * Silently no-ops for tabs without a URL.
				 */
				save: defineMutation({
					title: 'Save Tab',
					description: 'Save a tab for later by its metadata, then close it.',
					input: Type.Object({
						browserTabId: Type.Number(),
						url: Type.String(),
						title: Type.String(),
						favIconUrl: Type.Optional(Type.String()),
						pinned: Type.Boolean(),
					}),
					handler: async ({ browserTabId, url, title, favIconUrl, pinned }) => {
						const deviceId = await getDeviceId();
						tables.savedTabs.set({
							id: generateSavedTabId(),
							url,
							title,
							favIconUrl,
							pinned,
							sourceDeviceId: deviceId,
							savedAt: Date.now(),
							_v: 1,
						});
						await tryAsync({
							try: () => browser.tabs.remove(browserTabId),
							catch: () => Ok(undefined),
						});
						return { saved: true };
					},
				}),

				/**
				 * Restore a saved tab—re-open in browser and delete the record.
				 *
				 * Preserves the tab's pinned state.
				 */
				restore: defineMutation({
					title: 'Restore Saved Tab',
					description: 'Re-open a saved tab in the browser and delete the record.',
					input: Type.Object({
						id: Type.String(),
						url: Type.String(),
						pinned: Type.Boolean(),
					}),
					handler: async ({ id, url, pinned }) => {
						await tryAsync({
							try: () => browser.tabs.create({ url, pinned }),
							catch: () => Ok(undefined),
						});
						tables.savedTabs.delete(id);
						return { restored: true };
					},
				}),

				/**
				 * Restore all saved tabs at once.
				 *
				 * Fires all tab creations in parallel and batch-deletes from
				 * Y.Doc in a single transaction.
				 */
				restoreAll: defineMutation({
					title: 'Restore All Saved Tabs',
					description: 'Re-open all saved tabs and delete their records.',
					input: Type.Object({}),
					handler: async () => {
						const all = tables.savedTabs.getAllValid();
						if (!all.length) return { restoredCount: 0 };
						const createPromises = all.map((tab) =>
							browser.tabs.create({ url: tab.url, pinned: tab.pinned }),
						);
						batch(() => {
							for (const tab of all) {
								tables.savedTabs.delete(tab.id);
							}
						});
						await Promise.allSettled(createPromises);
						return { restoredCount: all.length };
					},
				}),

				/** Remove a saved tab without restoring it. */
				remove: defineMutation({
					title: 'Remove Saved Tab',
					description: 'Delete a saved tab without restoring it.',
					input: Type.Object({ id: Type.String() }),
					handler: ({ id }) => {
						tables.savedTabs.delete(id);
						return { removed: true };
					},
				}),

				/**
				 * Delete all saved tabs without restoring.
				 *
				 * Wrapped in a Y.Doc transaction so the observer fires once.
				 */
				removeAll: defineMutation({
					title: 'Remove All Saved Tabs',
					description: 'Delete all saved tabs without restoring them.',
					input: Type.Object({}),
					handler: () => {
						const all = tables.savedTabs.getAllValid();
						batch(() => {
							for (const tab of all) {
								tables.savedTabs.delete(tab.id);
							}
						});
						return { removedCount: all.length };
					},
				}),
			},
			bookmarks: {
				/**
				 * Toggle a bookmark for a URL—add if not bookmarked, remove all matches if already bookmarked.
				 *
				 * Deduplicates by URL. Removes ALL matching bookmarks for the URL (not just the first)
				 * to clean up duplicates from earlier versions that didn't deduplicate.
				 */
				toggle: defineMutation({
					title: 'Toggle Bookmark',
					description: 'Add or remove a bookmark for a URL. If the URL is already bookmarked, removes all matching bookmarks; otherwise creates a new bookmark.',
					input: Type.Object({
						url: Type.String(),
						title: Type.String(),
						favIconUrl: Type.Optional(Type.String()),
					}),
					handler: async ({ url, title, favIconUrl }) => {
						const allMatching = tables.bookmarks
							.getAllValid()
							.filter((b) => b.url === url);
						if (allMatching.length > 0) {
							for (const match of allMatching) {
								tables.bookmarks.delete(match.id);
							}
							return { action: 'removed' as const, removedCount: allMatching.length };
						}
						const deviceId = await getDeviceId();
						const id = generateBookmarkId();
						tables.bookmarks.set({
							id,
							url,
							title,
							favIconUrl,
							description: undefined,
							sourceDeviceId: deviceId,
							createdAt: Date.now(),
							_v: 1,
						});
						return { action: 'added' as const, removedCount: 0 };
					},
				}),

				/**
				 * Open a bookmark in a new browser tab without removing the bookmark.
				 *
				 * Unlike saved tab restore, the bookmark record persists after opening.
				 */
				open: defineMutation({
					title: 'Open Bookmark',
					description: 'Open a bookmarked URL in a new browser tab. The bookmark is not deleted.',
					input: Type.Object({
						url: Type.String(),
					}),
					handler: async ({ url }) => {
						const { data: tab, error } = await tryAsync({
							try: () => browser.tabs.create({ url }),
							catch: () => Ok(undefined),
						});
						return { tabId: error || !tab ? -1 : (tab.id ?? -1) };
					},
				}),

				/** Remove a single bookmark by ID. */
				remove: defineMutation({
					title: 'Remove Bookmark',
					description: 'Delete a bookmark by its ID.',
					input: Type.Object({
						id: Type.String(),
					}),
					handler: ({ id }) => {
						tables.bookmarks.delete(id);
						return { removed: true };
					},
				}),

				/**
				 * Remove all bookmarks in a single Y.Doc transaction.
				 *
				 * Deletes every bookmark row from the table.
				 */
				removeAll: defineMutation({
					title: 'Remove All Bookmarks',
					description: 'Delete every bookmark.',
					input: Type.Object({}),
					handler: () => {
						const all = tables.bookmarks.getAllValid();
						batch(() => {
							for (const bookmark of all) {
								tables.bookmarks.delete(bookmark.id);
							}
						});
						return { removedCount: all.length };
					},
				}),
			},
		}));
}
