import {
	check,
	index,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
} from 'drizzle-orm/pg-core';
import { relations, sql, type SQL } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { user } from './auth';

/** 15-char alphanumeric ID — matches generateGuid in @epicenter/workspace. */
const generateId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15);

/**
 * Build a `col IN (...)` CHECK from a const-tuple. Single source of truth:
 * adding a value to the exported array updates both TS union + SQL CHECK.
 */
function inValuesCheck(column: string, values: readonly string[]): SQL {
	return sql`${sql.identifier(column)} IN (${sql.join(
		values.map((v) => sql`${v}`),
		sql`, `,
	)})`;
}

/** Acceptance lifecycle — whether the wager is active and counting. */
export const wagerStatuses = ['draft', 'sent', 'live', 'cancelled'] as const;
export type WagerStatus = (typeof wagerStatuses)[number];

/** Committer's verdict on themselves — flippable by committer or any accepted witness. */
export const wagerOutcomes = ['pending', 'done', 'missed'] as const;
export type WagerOutcome = (typeof wagerOutcomes)[number];

/**
 * A unidirectional accountability wager.
 *
 * The committer stakes `amount` on themselves doing a thing. Witnesses (see
 * `witness` table) stake nothing — they observe, judge, and collect a share
 * of the stake if the committer misses.
 *
 * Two orthogonal state machines:
 *   status:   draft → sent → live → cancelled           (acceptance lifecycle)
 *   outcome:  pending → {done | missed}   (flippable)   (committer's verdict)
 *
 * `outcomeActorId` records the *most recent* flipper; per-flip attribution
 * lives on each ledger row's `actorUserId`.
 */
export const wager = pgTable(
	'wager',
	{
		id: text('id').primaryKey().$defaultFn(generateId),
		committerId: text('committer_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		description: text('description'),
		amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
		currency: text('currency').notNull().default('USD'),
		deadline: timestamp('deadline', { withTimezone: true }).notNull(),
		status: text('status', { enum: wagerStatuses }).notNull().default('draft'),
		outcome: text('outcome', { enum: wagerOutcomes })
			.notNull()
			.default('pending'),
		outcomeAt: timestamp('outcome_at', { withTimezone: true }),
		outcomeActorId: text('outcome_actor_id').references(() => user.id, {
			onDelete: 'set null',
		}),
		createdAt: timestamp('created_at', { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(t) => [
		check('wager_amount_positive', sql`amount > 0`),
		check('wager_status_valid', inValuesCheck('status', wagerStatuses)),
		check('wager_outcome_valid', inValuesCheck('outcome', wagerOutcomes)),
		index('wager_committer_idx').on(t.committerId),
	],
);

/**
 * A user invited to observe and judge a wager.
 *
 * Witnesses stake nothing. Only accepted witnesses (`acceptedAt IS NOT NULL`)
 * count toward the pot-split and can flip the outcome. Ordered by `joinedAt`
 * for deterministic rounding-remainder assignment.
 */
export const witness = pgTable(
	'witness',
	{
		id: text('id').primaryKey().$defaultFn(generateId),
		wagerId: text('wager_id')
			.notNull()
			.references(() => wager.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		invitedBy: text('invited_by').references(() => user.id, {
			onDelete: 'set null',
		}),
		acceptedAt: timestamp('accepted_at', { withTimezone: true }),
		joinedAt: timestamp('joined_at', { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(t) => [
		// UNIQUE(wager_id, user_id) — also the prefix index for lookups by
		// wager_id alone, so no separate wager_id index.
		unique().on(t.wagerId, t.userId),
		index('witness_user_idx').on(t.userId),
	],
);

/**
 * Append-only ledger of balance changes between two users.
 *
 * Row kind is derived from `wagerId`:
 *   - `wagerId IS NOT NULL` → wager outcome delta (committer → witness)
 *   - `wagerId IS NULL`     → manual payment (any direction)
 *
 * Running balance between any pair = SUM(amount) grouped by (from_user_id, to_user_id).
 * Positive amount = fromUser owes toUser. Reversals and payments use negative amounts.
 *
 * Immutability: never UPDATE or DELETE — always emit a new compensating row.
 * FK policies enforce this: `fromUserId`/`toUserId` are `restrict` so a user
 * with any ledger history can't be hard-deleted without first settling (which
 * writes compensating rows). `wagerId` is `set null` only for the theoretical
 * case of wager deletion; in practice wagers are never deleted.
 */
export const ledger = pgTable(
	'ledger',
	{
		id: text('id').primaryKey().$defaultFn(generateId),
		wagerId: text('wager_id').references(() => wager.id, {
			onDelete: 'set null',
		}),
		fromUserId: text('from_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		toUserId: text('to_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		actorUserId: text('actor_user_id').references(() => user.id, {
			onDelete: 'set null',
		}),
		amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
		currency: text('currency').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		check('ledger_no_self_transfer', sql`from_user_id <> to_user_id`),
		index('ledger_from_user_idx').on(t.fromUserId),
		index('ledger_to_user_idx').on(t.toUserId),
		index('ledger_wager_idx').on(t.wagerId),
	],
);

// ── Relations ────────────────────────────────────────────────────────────
// `relationName` is only needed when 2+ relations connect the same pair of
// tables. Single-FK relations are left unnamed.

export const wagerRelations = relations(wager, ({ one, many }) => ({
	committer: one(user, {
		fields: [wager.committerId],
		references: [user.id],
		relationName: 'wager_committer',
	}),
	outcomeActor: one(user, {
		fields: [wager.outcomeActorId],
		references: [user.id],
		relationName: 'wager_outcome_actor',
	}),
	witnesses: many(witness),
	ledgerEntries: many(ledger),
}));

export const witnessRelations = relations(witness, ({ one }) => ({
	wager: one(wager, {
		fields: [witness.wagerId],
		references: [wager.id],
	}),
	user: one(user, {
		fields: [witness.userId],
		references: [user.id],
		relationName: 'witness_user',
	}),
	inviter: one(user, {
		fields: [witness.invitedBy],
		references: [user.id],
		relationName: 'witness_inviter',
	}),
}));

export const ledgerRelations = relations(ledger, ({ one }) => ({
	wager: one(wager, {
		fields: [ledger.wagerId],
		references: [wager.id],
	}),
	from: one(user, {
		fields: [ledger.fromUserId],
		references: [user.id],
		relationName: 'ledger_from',
	}),
	to: one(user, {
		fields: [ledger.toUserId],
		references: [user.id],
		relationName: 'ledger_to',
	}),
	actor: one(user, {
		fields: [ledger.actorUserId],
		references: [user.id],
		relationName: 'ledger_actor',
	}),
}));
