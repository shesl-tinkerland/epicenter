import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Env } from './app';
import { follow, user } from './db';

const sharedRoutes = new Hono<Env>();

// ── Validation schemas ───────────────────────────────────────────────────

const followSchema = type({
	userId: 'string',
});

// ── Follow / Friends ─────────────────────────────────────────────────────

/**
 * POST /follow
 *
 * Follow another user.
 */
sharedRoutes.post('/follow', sValidator('json', followSchema), async (c) => {
	const data = c.req.valid('json');
	const db = c.var.db;
	const userId = c.var.user.id;

	if (data.userId === userId) {
		return c.json({ message: "You can't follow yourself." }, 400);
	}

	await db
		.insert(follow)
		.values({ followerId: userId, followingId: data.userId })
		.onConflictDoNothing();

	return c.json({ ok: true }, 201);
});

/**
 * DELETE /follow/:userId
 *
 * Unfollow a user.
 */
sharedRoutes.delete('/follow/:userId', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const followingUserId = c.req.param('userId');

	await db
		.delete(follow)
		.where(
			and(
				eq(follow.followerId, userId),
				eq(follow.followingId, followingUserId),
			),
		);

	return c.body(null, 204);
});

/**
 * GET /friends
 *
 * List mutual follows for the current user.
 */
sharedRoutes.get('/friends', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const friendRows = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			createdAt: follow.createdAt,
		})
		.from(follow)
		.innerJoin(user, eq(user.id, follow.followingId))
		.where(
			and(
				eq(follow.followerId, userId),
				sql`exists (
					select 1
					from "follow" as reverse_follow
					where reverse_follow.follower_id = ${follow.followingId}
						and reverse_follow.following_id = ${follow.followerId}
				)`,
			),
		)
		.orderBy(desc(follow.createdAt));

	return c.json(friendRows);
});

/**
 * GET /followers
 *
 * List people who follow the current user.
 */
sharedRoutes.get('/followers', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const followerRows = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			createdAt: follow.createdAt,
		})
		.from(follow)
		.innerJoin(user, eq(user.id, follow.followerId))
		.where(eq(follow.followingId, userId))
		.orderBy(desc(follow.createdAt));

	return c.json(followerRows);
});

/**
 * GET /following
 *
 * List people the current user follows.
 */
sharedRoutes.get('/following', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const followingRows = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			createdAt: follow.createdAt,
		})
		.from(follow)
		.innerJoin(user, eq(user.id, follow.followingId))
		.where(eq(follow.followerId, userId))
		.orderBy(desc(follow.createdAt));

	return c.json(followingRows);
});

export { sharedRoutes };
