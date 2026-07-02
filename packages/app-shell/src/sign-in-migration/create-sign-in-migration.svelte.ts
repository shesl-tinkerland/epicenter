/**
 * First-sign-in migration: move this device's signed-out local doc into the
 * signed-in, owner-partitioned synced doc (ADR-0088).
 *
 * Flag-free: the local data itself is the state. On each signed-in boot the
 * app probes the local doc for any migratable rows; a non-empty table opens
 * the dialog, which nags again next boot until the user picks Add or Delete.
 * "Add" copies local rows into the owner doc (idempotent by id) then deletes
 * the plaintext local copy, so the deletion both removes the lingering
 * plaintext duplicate AND is why no "migrated" flag is needed (the tables
 * drop to 0).
 *
 * The local source is opened only momentarily (probe, then each action
 * re-opens), so nothing is held across the dialog's lifetime and a dismissed
 * dialog leaks nothing.
 */

import type { AuthClient } from '@epicenter/auth';
import { toastOnError } from '@epicenter/ui/sonner';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';

/** Row type of a migratable table, inferred from its `scan()` shape. */
type TableRows<T> = T extends { scan(): { rows: Array<infer R> } } ? R : never;

/** Per-table row counts measured from the local source at probe time. */
export type MigrationCounts = Record<string, number>;

/** The surface `SignInMigrationDialog` binds to. */
export type SignInMigrationState = {
	open: boolean;
	/** Human phrase for what is staged locally (the app's `describe`). */
	readonly summary: string;
	/** Optional extra dialog line (the app's `note`), e.g. where audio files live. */
	readonly note: string | undefined;
	readonly phase: 'idle' | 'adding' | 'deleting';
	readonly isBusy: boolean;
	check(): Promise<void>;
	addToAccount(): Promise<void>;
	deleteFromDevice(): Promise<void>;
	keepForNow(): void;
};

/** Upsert every valid row from one table into another; idempotent by id. */
function copyTable<TRow extends { id: string }>(
	from: { scan(): { rows: TRow[] } },
	to: { set(row: TRow): { error: unknown } },
): void {
	for (const row of from.scan().rows) {
		const { error } = to.set(row);
		if (error) throw error;
	}
}

/**
 * Build the flag-free sign-in migration state for one app.
 *
 * The app supplies the two doc handles and the words; the copy mechanics,
 * probe, and dialog phases are shared:
 *
 * - `openLocalSource()` opens the app's BARE doc (plain `attachIndexedDb`
 *   under the doc guid) as a throwaway second instance. It never collides
 *   with the active owner-partitioned doc, whose storage key is owner-scoped.
 * - `target` is the live signed-in workspace singleton.
 *
 * Every table on the source is copied; a source table missing from the
 * target throws loudly rather than dropping data silently (unreachable when
 * both sides come from the same app factory, which is the contract).
 */
export function createSignInMigration<
	TTables extends Record<string, { scan(): { rows: Array<{ id: string }> } }>,
>({
	auth,
	openLocalSource,
	target,
	describe,
	note,
	errorNoun = 'local data',
}: {
	/** The app's auth client; only the boot status gates the probe. */
	auth: AuthClient;
	/** Open a throwaway handle to the signed-out plaintext local doc. */
	openLocalSource: () => {
		tables: TTables;
		whenLoaded: Promise<unknown>;
		clearLocal(): Promise<void>;
		dispose(): void;
	};
	/** The live owner-doc workspace singleton the rows migrate into. */
	target: {
		whenReady: Promise<unknown>;
		ydoc: { transact(fn: () => void): void };
		tables: {
			[K in keyof TTables]: {
				set(row: TableRows<TTables[K]>): { error: unknown };
			};
		};
	};
	/** Human phrase for what is staged locally, from per-table counts. */
	describe: (counts: MigrationCounts) => string;
	/** Optional extra dialog line, from per-table counts. */
	note?: (counts: MigrationCounts) => string | undefined;
	/** Noun for the error toasts, e.g. "recordings". */
	errorNoun?: string;
}): SignInMigrationState {
	const MigrationError = defineErrors({
		AddFailed: ({ cause }: { cause: unknown }) => ({
			message: `Could not add your ${errorNoun} to this account: ${extractErrorMessage(cause)}`,
			cause,
		}),
		DeleteFailed: ({ cause }: { cause: unknown }) => ({
			message: `Could not remove the local ${errorNoun}: ${extractErrorMessage(cause)}`,
			cause,
		}),
	});
	type MigrationError = InferErrors<typeof MigrationError>;

	/**
	 * Copy the whole local doc into the owner doc in one transaction (one
	 * observer fire, one relay batch), then delete the plaintext local copy.
	 * Yjs does not roll back a `transact()` callback on throw, so a mid-loop
	 * failure can leave partial rows already committed to the owner doc; the
	 * safety net is that `copyTable` is idempotent by id, not that the
	 * transaction is atomic. Either way `clearLocal` only runs after the whole
	 * copy resolves without throwing, so a failure leaves the local copy
	 * intact and the next attempt re-runs safely over whatever partial state
	 * exists.
	 */
	async function addLocalToOwner(
		source: ReturnType<typeof openLocalSource>,
	): Promise<void> {
		await target.whenReady;
		target.ydoc.transact(() => {
			for (const name of Object.keys(source.tables)) {
				const to = target.tables[name];
				if (!to) {
					throw new Error(
						`[sign-in-migration] target workspace has no table "${name}"`,
					);
				}
				copyTable(
					source.tables[name] as { scan(): { rows: { id: string }[] } },
					to,
				);
			}
		});
		await source.clearLocal();
	}

	let open = $state(false);
	let summary = $state('');
	let noteText = $state<string | undefined>(undefined);
	let phase = $state<'idle' | 'adding' | 'deleting'>('idle');
	let hasChecked = false;

	return {
		get open() {
			return open;
		},
		set open(value: boolean) {
			// Ignore Escape/outside-click while a copy or delete is in flight; the
			// buttons are already disabled, so the dialog's own close path is the
			// one spot this guard would otherwise miss.
			if (phase !== 'idle') return;
			open = value;
		},
		get summary() {
			return summary;
		},
		get note() {
			return noteText;
		},
		get phase() {
			return phase;
		},
		get isBusy() {
			return phase !== 'idle';
		},

		/**
		 * Probe once per boot. When signed in, open the local doc, count every
		 * table `addLocalToOwner` will copy, and dispose it. Any non-empty table
		 * opens the dialog. No flag: the presence of local rows is the state, so
		 * the prompt returns next signed-in boot until resolved.
		 *
		 * Gates on every table, not one headline table: a signed-out user can
		 * build rows in a secondary table without ever touching the primary one,
		 * and the "Add" path copies all of them. Probing one table alone would
		 * strand the rest in the bare local doc, invisible under the partitioned
		 * signed-in doc, which is the exact loss this migration prevents.
		 */
		async check(): Promise<void> {
			if (hasChecked) return;
			hasChecked = true;
			if (auth.state.status === 'signed-out') return;

			const source = openLocalSource();
			const counts: MigrationCounts = {};
			try {
				await source.whenLoaded;
				for (const [name, table] of Object.entries(source.tables)) {
					counts[name] = table.scan().rows.length;
				}
			} finally {
				source.dispose();
			}
			const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
			if (total === 0) return;
			summary = describe(counts);
			noteText = note?.(counts);
			open = true;
		},

		/** Copy local data into the owner doc, then delete the plaintext local copy. */
		async addToAccount(): Promise<void> {
			if (phase !== 'idle') return;
			phase = 'adding';
			const { error } = await tryAsync({
				try: async () => {
					const source = openLocalSource();
					try {
						await source.whenLoaded;
						await addLocalToOwner(source);
					} finally {
						source.dispose();
					}
				},
				catch: (cause) => MigrationError.AddFailed({ cause }),
			});
			phase = 'idle';
			if (error) {
				// Local copy is untouched on failure; the dialog stays open to retry.
				toastOnError(error, error.message);
				return;
			}
			open = false;
		},

		/** Delete the plaintext local copy without copying it into the account. */
		async deleteFromDevice(): Promise<void> {
			if (phase !== 'idle') return;
			phase = 'deleting';
			const { error } = await tryAsync({
				try: async () => {
					const source = openLocalSource();
					try {
						await source.whenLoaded;
						await source.clearLocal();
					} finally {
						source.dispose();
					}
				},
				catch: (cause) => MigrationError.DeleteFailed({ cause }),
			});
			phase = 'idle';
			if (error) {
				toastOnError(error, error.message);
				return;
			}
			open = false;
		},

		/** Defer: close the dialog. The next signed-in boot re-probes and nags. */
		keepForNow(): void {
			if (phase !== 'idle') return;
			open = false;
		},
	};
}
