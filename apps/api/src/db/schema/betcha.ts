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
	const quoted = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
	return sql.raw(`${column} IN (${quoted})`);
}

/** Stored lifecycle for challenge.status — acceptance/activation state. */
export const challengeStatuses = ['draft', 'sent', 'live', 'cancelled'] as const;
export type ChallengeStatus = (typeof challengeStatuses)[number];

/** The committer's personal outcome. Only one outcome per challenge. */
export const challengeOutcomes = ['pending', 'done', 'missed'] as const;
export type ChallengeOutcome = (typeof challengeOutcomes)[number];

/** Ledger row discriminator. Sign of amount carries direction. */
export const ledgerEntryTypes = ['challenge_outcome', 'payment'] as const;
export type LedgerEntryType = (typeof ledgerEntryTypes)[number];

/**
 * A unidirectional wager.
 *
 * `createdBy` is the committer — the ONLY stakeholder. They put up `amount`.
 * Participants (see `participant` table) are witnesses, not stakeholders.
 *
 * Committer wins (outcome='done') → keeps their stake. No transfers.
 * Committer loses (outcome='missed') → `amount` splits evenly among witnesses.
 * Committer unresolved (outcome='pending') → no transfers.
 *
 * Two orthogonal state machines:
 *   status:   draft → sent → live → cancelled         (acceptance lifecycle)
 *   outcome:  pending → {done | missed}  (flippable)  (committer's verdict)
 *
 * Anyone in the challenge (committer or any accepted witness) can flip the
 * outcome at any time. Every flip writes compensating ledger entries.
 */
export const challenge = pgTable(
	'challenge',
	{
		id: text('id').primaryKey().$defaultFn(generateId),
		title: text('title').notNull(),
		description: text('description'),
		amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
		currency: text('currency').notNull().default('USD'),
		deadline: timestamp('deadline', { withTimezone: true }).notNull(),
		status: text('status', { enum: challengeStatuses })
			.notNull()
			.default('draft'),
		outcome: text('outcome', { enum: challengeOutcomes })
			.notNull()
			.default('pending'),
		outcomeAt: timestamp('outcome_at', { withTimezone: true }),
		outcomeActorId: text('outcome_actor_id').references(() => user.id, {
			onDelete: 'set null',
		}),
		createdBy: text('created_by').references(() => user.id, {
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
		check('challenge_amount_positive', sql`amount > 0`),
		check(
			'challenge_status_valid',
			inValuesCheck('status', challengeStatuses),
		),
		check(
			'challenge_outcome_valid',
			inValuesCheck('outcome', challengeOutcomes),
		),
		index('challenge_created_by_idx').on(t.createdBy),
		index('challenge_status_idx').on(t.status),
		index('challenge_outcome_idx').on(t.outcome),
		index('challenge_deadline_idx').on(t.deadline),
	],
);

/**
 * A witness row — a user invited to observe and judge a challenge.
 *
 * Witnesses do NOT stake money. They're the counterparty who receives a share
 * of the committer's stake if the committer loses, and who can flip the
 * outcome status.
 *
 * Acceptance:
 *   - `acceptedAt = null` → invited, not yet accepted
 *   - `acceptedAt != null` → accepted; counts toward pot-split
 *
 * A challenge can be activated only when at least one witness has accepted.
 * Unaccepted witnesses are excluded from the pot-split math.
 *
 * `invitedBy` records who pulled this user in. Typically the committer, but
 * could be another witness in group flows where witnesses invite more.
 */
export const participant = pgTable(
	'participant',
	{
		id: text('id').primaryKey().$defaultFn(generateId),
		challengeId: text('challenge_id')
			.notNull()
			.references(() => challenge.id, { onDelete: 'cascade' }),
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
		// UNIQUE(challenge_id, user_id) — also serves as the prefix index for
		// lookups by challenge_id alone, so no separate challenge_id index.
		unique().on(t.challengeId, t.userId),
		index('participant_user_id_idx').on(t.userId),
		index('participant_invited_by_idx').on(t.invitedBy),
	],
);

/**
 * Append-only ledger of balance changes between users.
 *
 * Outcome-driven entries always flow committer → witness. Payments can flow
 * any direction between users. Running balance = SUM(amount) grouped by
 * (fromUserId, toUserId) pair.
 *
 * Positive amount = fromUser owes toUser.
 * Reversal of a prior outcome entry = same (from, to) pair with negative amount.
 * Payments (Venmo, PayPal, cash) use negative amounts to reduce balance.
 */
export const ledger = pgTable(
	'ledger',
	{
		id: text('id').primaryKey().$defaultFn(generateId),
		challengeId: text('challenge_id').references(() => challenge.id, {
			onDelete: 'set null',
		}),
		fromUserId: text('from_user_id').references(() => user.id, {
			onDelete: 'set null',
		}),
		toUserId: text('to_user_id').references(() => user.id, {
			onDelete: 'set null',
		}),
		actorUserId: text('actor_user_id').references(() => user.id, {
			onDelete: 'set null',
		}),
		amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
		currency: text('currency').notNull(),
		type: text('type', { enum: ledgerEntryTypes }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		check('ledger_no_self_transfer', sql`from_user_id <> to_user_id`),
		check('ledger_type_valid', inValuesCheck('type', ledgerEntryTypes)),
		index('ledger_from_user_id_idx').on(t.fromUserId),
		index('ledger_to_user_id_idx').on(t.toUserId),
		index('ledger_challenge_id_idx').on(t.challengeId),
	],
);

// ── Relations ────────────────────────────────────────────────────────────
// `relationName` is only needed when 2+ relations connect the same pair of
// tables. Single-FK relations are left unnamed.

export const challengeRelations = relations(challenge, ({ one, many }) => ({
	creator: one(user, {
		fields: [challenge.createdBy],
		references: [user.id],
		relationName: 'challenge_creator',
	}),
	outcomeActor: one(user, {
		fields: [challenge.outcomeActorId],
		references: [user.id],
		relationName: 'challenge_outcome_actor',
	}),
	witnesses: many(participant),
	ledgerEntries: many(ledger),
}));

export const participantRelations = relations(participant, ({ one }) => ({
	challenge: one(challenge, {
		fields: [participant.challengeId],
		references: [challenge.id],
	}),
	user: one(user, {
		fields: [participant.userId],
		references: [user.id],
		relationName: 'participant_user',
	}),
	inviter: one(user, {
		fields: [participant.invitedBy],
		references: [user.id],
		relationName: 'participant_inviter',
	}),
}));

export const ledgerRelations = relations(ledger, ({ one }) => ({
	challenge: one(challenge, {
		fields: [ledger.challengeId],
		references: [challenge.id],
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
