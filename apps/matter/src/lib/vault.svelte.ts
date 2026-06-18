/**
 * A live Vault: one directory of typed markdown Tables, read as one relational unit.
 *
 * This is the layer above {@link createTable}. A Table watches ONE folder's files; a Vault watches
 * the ROOT (`watch_vault`, depth-1) for its table set changing, and composes a `createTable` per
 * table the watcher resolves. `watch_vault` applies the same table-or-vault rule as the CLI loader
 * (`load/fs.ts` `loadPath`), where altitude is pure shape: a folder of folders is a vault of those
 * Tables, while a folder of files (or an empty folder) is itself a single Table on the root, so
 * opening a leaf folder and opening a parent both work. A `matter.json` only types a Table; it never
 * decides altitude. It owns its Tables' lifetimes:
 * dispose the Vault and every Table watch and the root watch stop. The Vault declares nothing
 * itself: it is the live union of its Tables' self-declared contracts, discovered, not configured.
 *
 * Why this exists: references only have meaning across two Tables of the SAME Vault
 * (`adaptations.page -> pages`), so resolution is a Vault-level operation. The Vault holds every
 * Table together, runs `assess` over all of them at once, and exposes ONE live {@link
 * VaultIntegrity} that the grid, the Table switcher, and the integrity panel all select from. The
 * single open table case is just a degenerate Vault of one Table.
 *
 * Desktop-only: it talks to Tauri directly (no platform seam), mirroring {@link createTable}.
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { assess, type VaultIntegrity } from './core/integrity';
import { basename } from './core/path';
import { createTable, type LiveStatus, type TableHandle } from './table.svelte';

/**
 * Open `root` as a live vault. Synchronous and IO-free: the table set starts empty and fills from
 * the first table list once the root watch is armed, so there is no separate initial listing and no
 * list-then-watch gap (the Rust side arms before its seed scan).
 */
export function createVault(root: string) {
	const folderName = basename(root);

	// table folder path -> its live Table. The table list from `watch_vault` reconciles this map;
	// the `tables` getter sorts by name so the switcher and integrity read a stable order
	// regardless of when a folder was added.
	const tables = new SvelteMap<string, TableHandle>();

	/**
	 * Reconcile the live tables against a fresh table list (the whole set `watch_vault` resolved,
	 * which is the child folders, or the root itself when the root is a single table): dispose the
	 * folders that left, compose the folders that arrived, leave the rest untouched so an unrelated
	 * change (a loose file written at the root) churns nothing.
	 */
	function reconcile(paths: string[]): void {
		// A snapshot can still arrive after dispose (the seed, or a debounced batch already in flight
		// when the tab closed): ignore it, or it would arm a fresh per-folder watch with nothing left
		// to dispose it. Mirrors the same `disposed` guard the watch-id path below already honors.
		if (disposed) return;
		const incoming = new Set(paths);
		for (const [path, table] of tables) {
			if (incoming.has(path)) continue;
			table.dispose();
			tables.delete(path);
		}
		for (const path of paths) {
			if (!tables.has(path)) tables.set(path, createTable(path));
		}
	}

	/** The vault's tables, sorted by folder name: the stable order every surface renders in. */
	const orderedTables = $derived(
		[...tables.values()].sort((a, b) =>
			a.folderName.localeCompare(b.folderName),
		),
	);

	/**
	 * The one composed integrity model, recomputed whenever any table's read changes or the table
	 * set changes. Every readable table contributes itself (folder name + classified read) to
	 * `assess`, which resolves references across them; an unreadable folder never reaches here (the
	 * root watch only lists folders it could stat as directories). The grid, the switcher's
	 * per-table badges, and the integrity panel are all pure selectors over this.
	 */
	const integrity = $derived.by(
		(): VaultIntegrity =>
			assess(
				orderedTables.map((table) => ({
					name: table.folderName,
					status: 'readable' as const,
					read: table.read,
				})),
			),
	);

	// Opening a vault IS observing it: arm the root watch now. `watch_vault` seeds the current
	// membership, then streams a snapshot per change, all through `reconcile`. `status` carries
	// readiness as reactive state: the FIRST table list (the seed, always at least one path) flips
	// it to `ready`, so the same signal that fills `tables` is the one that opens the shell, with no
	// window between them where a populated vault reads as empty. The invoke no longer carries
	// readiness; it only captures the id for `dispose` and turns an arming or seed-send failure into
	// `error`.
	let status = $state<LiveStatus>({ kind: 'loading' });
	let watchId: number | undefined;
	let disposed = false;
	const channel = new Channel<string[]>();
	channel.onmessage = (paths) => {
		reconcile(paths);
		if (!disposed && status.kind === 'loading') status = { kind: 'ready' };
	};
	void invoke<number>('watch_vault', { path: root, channel })
		.then((id) => {
			if (disposed) void invoke('unwatch_vault', { id });
			else watchId = id;
		})
		.catch((error: unknown) => {
			if (!disposed)
				status = { kind: 'error', message: extractErrorMessage(error) };
		});

	/** Stop the root watch AND every composed table watch. The keyed route component calls this on teardown. */
	function dispose(): void {
		disposed = true;
		if (watchId !== undefined) void invoke('unwatch_vault', { id: watchId });
		for (const table of tables.values()) table.dispose();
		tables.clear();
	}

	return {
		folderName,
		root,
		dispose,
		/** The vault's readiness: `loading` until the first table list lands, then `ready` (a
		 *  readable root always resolves to at least one table, so `tables` is non-empty here), or
		 *  `error` if the watch could not be armed. Read it reactively; the shell renders on it. */
		get status(): LiveStatus {
			return status;
		},
		/** The vault's live tables, sorted by folder name. A pure read with no side effects. */
		get tables(): TableHandle[] {
			return orderedTables;
		},
		/** The one composed integrity model across every table. Read it reactively. */
		get integrity(): VaultIntegrity {
			return integrity;
		},
	};
}

export type VaultHandle = ReturnType<typeof createVault>;
