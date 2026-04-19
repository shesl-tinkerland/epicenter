import {
	check,
	index,
	pgTable,
	text,
	timestamp,
	unique,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { user } from './auth';

/** 15-char alphanumeric ID — matches generateGuid in @epicenter/workspace. */
const generateId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15);

/**
 * Directional follow relationship between two users.
 *
 * A single row means "follower follows following." Mutual follows (both
 * directions exist) = friends. This model serves both Betcha (friends for
 * challenges) and The Ark (feed subscriptions).
 *
 * To find mutual friends:
 * ```sql
 * SELECT f1.following_id AS friend_id
 * FROM follow f1
 * INNER JOIN follow f2 ON f1.follower_id = f2.following_id
 *                     AND f1.following_id = f2.follower_id
 * WHERE f1.follower_id = :userId
 * ```
 */
export const follow = pgTable(
	'follow',
	{
		id: text('id').primaryKey().$defaultFn(generateId),
		followerId: text('follower_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		followingId: text('following_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		check('follow_no_self_follow', sql`follower_id <> following_id`),
		// UNIQUE(follower_id, following_id) — also the prefix index for lookups
		// by follower_id alone, so no separate follower_id index.
		unique().on(t.followerId, t.followingId),
		index('follow_following_id_idx').on(t.followingId),
	],
);

export const followRelations = relations(follow, ({ one }) => ({
	follower: one(user, {
		fields: [follow.followerId],
		references: [user.id],
		relationName: 'follow_follower',
	}),
	following: one(user, {
		fields: [follow.followingId],
		references: [user.id],
		relationName: 'follow_following',
	}),
}));
