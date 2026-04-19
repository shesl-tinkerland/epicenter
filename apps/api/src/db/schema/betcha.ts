import {
	check,
	index,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { user } from './core';

/** 15-char alphanumeric ID — matches generateGuid in @epicenter/workspace. */
const generateId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15);

/**
 * Core challenge record. The container for one or more participants.
 *
 * 1v1: creator stakes money and invites one partner.
 * Group: N participants stake money on the same goal. Winners split losers' stakes.
 *
 * Stored states: draft → pending → active → cancelled.
 * Completion is derived from participant statuses, not stored on the challenge row.
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
		status: text('status').notNull().default('draft'),
		createdBy: text('created_by').references(() => user.id, {
			onDelete: 'set null',
		}),
		createdAt: timestamp('created_at', { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		index('challenge_created_by_idx').on(t.createdBy),
		index('challenge_status_idx').on(t.status),
		index('challenge_deadline_idx').on(t.deadline),
	],
);

/**
 * One person's participant row within a challenge.
 *
 * Each participant has their own status: pending, done, or missed.
 * Anyone in the challenge can change anyone's status at any time.
 * The deadline auto-converts `pending` to `missed`.
 *
 * The challenge creator is the committer. Additional rows represent the invited
 * partner(s) or group members attached to the same challenge.
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
		status: text('status').notNull().default('pending'),
		statusAt: timestamp('status_at', { withTimezone: true }),
		joinedAt: timestamp('joined_at', { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		unique().on(t.challengeId, t.userId),
		index('participant_user_id_idx').on(t.userId),
		index('participant_challenge_id_idx').on(t.challengeId),
	],
);

/**
 * Append-only ledger of balance changes between friends.
 *
 * Every status change (done → missed, missed → done, or auto-expiry)
 * creates a ledger record. Running balance = SUM(amount) grouped by
 * (fromUserId, toUserId) pair.
 *
 * Positive amount = fromUser owes toUser.
 * Payments (Venmo, PayPal, cash) also create entries with negative amounts
 * to reduce the balance.
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
		type: text('type').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		check('ledger_no_self_transfer', sql`from_user_id <> to_user_id`),
		index('ledger_from_user_idx').on(t.fromUserId),
		index('ledger_to_user_idx').on(t.toUserId),
		index('ledger_challenge_id_idx').on(t.challengeId),
	],
);
