import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { and, desc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../app';
import { follow, ledger, wager, witness } from '../db';

const betchaRoutes = new Hono<Env>();

// ── Validation schemas ───────────────────────────────────────────────────

const createWagerSchema = type({
	title: 'string > 0',
	'description?': 'string',
	amount: 'string.numeric',
	'currency?': 'string',
	deadline: 'string',
	witnessUserIds: 'string[] >= 1',
});

const outcomeSchema = type({
	outcome: "'done' | 'missed'",
});

const paymentSchema = type({
	toUserId: 'string',
	amount: 'string.numeric',
	currency: 'string',
});

// ── Errors ───────────────────────────────────────────────────────────────

const WagerError = defineErrors({
	NotFound: () => ({ message: 'Wager not found.' }),
	OnlyCommitter: ({ action }: { action: string }) => ({
		message: `Only the committer can ${action} this wager.`,
		action,
	}),
	OutcomeForbidden: () => ({
		message: 'Only the committer or a witness can flip the outcome.',
	}),
	AlreadyResolved: ({ action }: { action: string }) => ({
		message: `Cannot ${action} a wager that already has an outcome or is cancelled.`,
		action,
	}),
	InvalidDeadline: () => ({ message: 'Deadline must be a valid date.' }),
	InvalidAmount: () => ({ message: 'Amount must be greater than 0.' }),
	NoUsableWitnesses: () => ({
		message: 'Add at least one witness who is not yourself.',
	}),
	WitnessesMustBeFriends: ({ userIds }: { userIds: string[] }) => ({
		message:
			'Every witness must be a mutual follow (friend) of yours. Add them as friends first.',
		userIds: [...userIds],
	}),
	SelfPayment: () => ({ message: "You can't pay yourself." }),
});
type WagerError = InferErrors<typeof WagerError>;

/**
 * HTTP status per `WagerError` variant. Typed as `Record<variant, status>` so
 * adding a new variant without a mapping is a compile error.
 */
const WagerErrorHttpStatus: Record<WagerError['name'], ContentfulStatusCode> = {
	NotFound: 404,
	OnlyCommitter: 403,
	OutcomeForbidden: 403,
	AlreadyResolved: 400,
	InvalidDeadline: 400,
	InvalidAmount: 400,
	NoUsableWitnesses: 400,
	WitnessesMustBeFriends: 400,
	SelfPayment: 400,
};

// ── Derived state ────────────────────────────────────────────────────────

/**
 * Derive the wager's display state from stored columns. The DB has no
 * `status` column — it's computed here so clients don't duplicate the logic.
 */
function deriveState(w: {
	outcome: string | null;
	cancelledAt: Date | null;
	deadline: Date;
}): 'cancelled' | 'done' | 'missed' | 'awaiting_verdict' | 'live' {
	if (w.cancelledAt) return 'cancelled';
	if (w.outcome === 'done' || w.outcome === 'missed') return w.outcome;
	if (w.deadline.getTime() < Date.now()) return 'awaiting_verdict';
	return 'live';
}

// ── Wager CRUD ───────────────────────────────────────────────────────────

/**
 * POST /wagers
 *
 * Create a live wager. No draft/submit/activate ceremony — the wager is
 * immediately accepting outcome flips the moment this returns.
 *
 * Every `witnessUserIds[i]` must be a mutual follow (friend) of the
 * committer at this instant, or the whole request is rejected.
 */
betchaRoutes.post(
	'/wagers',
	sValidator('json', createWagerSchema),
	async (c) => {
		const data = c.req.valid('json');
		const db = c.var.db;
		const userId = c.var.user.id;
		const deadline = new Date(data.deadline);

		if (Number.isNaN(deadline.getTime())) {
			return c.json(WagerError.InvalidDeadline(), 400);
		}

		if (Number(data.amount) <= 0) {
			return c.json(WagerError.InvalidAmount(), 400);
		}

		const witnessUserIds = [...new Set(data.witnessUserIds)].filter(
			(witnessUserId) => witnessUserId !== userId,
		);

		if (witnessUserIds.length === 0) {
			return c.json(WagerError.NoUsableWitnesses(), 400);
		}

		// Mutual-follow check: for each requested witness W, require both rows
		// (userId→W) and (W→userId) to exist in `follow`. Single self-join
		// restricted to the candidate set.
		const f2 = alias(follow, 'f2');
		const mutuals = await db
			.select({ friendId: follow.followingId })
			.from(follow)
			.innerJoin(
				f2,
				and(
					eq(follow.followingId, f2.followerId),
					eq(follow.followerId, f2.followingId),
				),
			)
			.where(
				and(
					eq(follow.followerId, userId),
					inArray(follow.followingId, witnessUserIds),
				),
			);

		const friendSet = new Set(mutuals.map((row) => row.friendId));
		const nonFriends = witnessUserIds.filter((id) => !friendSet.has(id));
		if (nonFriends.length > 0) {
			return c.json(WagerError.WitnessesMustBeFriends({ userIds: nonFriends }), 400);
		}

		const [createdWager] = await db
			.insert(wager)
			.values({
				title: data.title,
				description: data.description,
				amount: data.amount,
				currency: data.currency ?? 'USD',
				deadline,
				committerId: userId,
			})
			.returning();

		// `.returning()` on a successful single-row INSERT always yields one row;
		// any failure would have thrown. Assertion documents that invariant.
		const wagerRow = createdWager!;

		await db.insert(witness).values(
			witnessUserIds.map((witnessUserId) => ({
				wagerId: wagerRow.id,
				userId: witnessUserId,
				addedBy: userId,
			})),
		);

		const witnesses = await db.query.witness.findMany({
			where: eq(witness.wagerId, wagerRow.id),
			with: { user: { columns: { id: true, name: true, image: true } } },
			orderBy: witness.joinedAt,
		});

		return c.json(
			{ ...wagerRow, witnesses, state: deriveState(wagerRow) },
			201,
		);
	},
);

/**
 * GET /wagers
 *
 * List every wager the current user is part of (as committer or witness),
 * newest first.
 */
betchaRoutes.get('/wagers', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;

	const wagers = await db.query.wager.findMany({
		where: or(
			eq(wager.committerId, userId),
			exists(
				db
					.select({ one: sql`1` })
					.from(witness)
					.where(
						and(
							eq(witness.wagerId, wager.id),
							eq(witness.userId, userId),
						),
					),
			),
		),
		with: {
			witnesses: {
				with: { user: { columns: { id: true, name: true, image: true } } },
				orderBy: witness.joinedAt,
			},
		},
		orderBy: desc(wager.createdAt),
	});

	return c.json(wagers.map((w) => ({ ...w, state: deriveState(w) })));
});

/**
 * GET /wagers/:slug
 *
 * Get one wager with its witnesses and ledger history.
 * Caller must be the committer or a witness.
 */
betchaRoutes.get('/wagers/:slug', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const slug = c.req.param('slug');

	const wagerRow = await db.query.wager.findFirst({
		where: eq(wager.slug, slug),
		with: {
			witnesses: {
				with: { user: { columns: { id: true, name: true, image: true } } },
				orderBy: witness.joinedAt,
			},
			ledgerEntries: { orderBy: desc(ledger.createdAt) },
		},
	});

	if (!wagerRow) {
		return c.json(WagerError.NotFound(), 404);
	}

	const isCommitter = wagerRow.committerId === userId;
	const isWitness = wagerRow.witnesses.some((w) => w.userId === userId);
	if (!isCommitter && !isWitness) {
		return c.json(WagerError.NotFound(), 404);
	}

	const { ledgerEntries, ...rest } = wagerRow;
	return c.json({
		...rest,
		ledgerHistory: ledgerEntries,
		state: deriveState(wagerRow),
	});
});

// ── Wager lifecycle ──────────────────────────────────────────────────────

/**
 * POST /wagers/:slug/cancel
 *
 * Cancel a live wager. Committer only; only allowed while `outcome IS NULL`
 * and `cancelledAt IS NULL`. Writes `cancelledAt`/`cancelledBy`; no ledger
 * impact (a cancelled wager never posted any deltas to reconcile).
 */
betchaRoutes.post('/wagers/:slug/cancel', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const slug = c.req.param('slug');

	const [wagerRow] = await db
		.select()
		.from(wager)
		.where(eq(wager.slug, slug))
		.limit(1);

	if (!wagerRow) {
		return c.json(WagerError.NotFound(), 404);
	}

	if (wagerRow.committerId !== userId) {
		return c.json(WagerError.OnlyCommitter({ action: 'cancel' }), 403);
	}

	if (wagerRow.cancelledAt || wagerRow.outcome) {
		return c.json(WagerError.AlreadyResolved({ action: 'cancel' }), 400);
	}

	const [updatedWager] = await db
		.update(wager)
		.set({ cancelledAt: new Date(), cancelledBy: userId })
		.where(eq(wager.id, wagerRow.id))
		.returning();

	return c.json({ ...updatedWager!, state: deriveState(updatedWager!) });
});

// ── Outcome (the committer's verdict) ────────────────────────────────────

/**
 * POST /wagers/:slug/outcome
 *
 * Flip the committer's outcome. Any witness OR the committer can call this.
 * The pot-split ledger is reconciled inside the transaction via per-witness
 * deltas, so the operation is idempotent and append-only.
 *
 * Algorithm (inside tx, with FOR UPDATE on the wager row):
 *   1. Lock wager. Reject if cancelled. If outcome already matches, no-op.
 *   2. Load witnesses, ordered by joinedAt.
 *   3. Compute per-witness expected cents under new outcome:
 *        missed → floor(amount_cents / N); first `remainder` witnesses get +1
 *        done   → 0
 *   4. Single grouped query: current cents per witness from prior ledger rows
 *      (committer → *, this wager). Loop witnesses in memory; insert a delta
 *      row where expected - current != 0.
 *   5. Update wager.outcome, outcomeAt, outcomeActorId.
 */
betchaRoutes.post(
	'/wagers/:slug/outcome',
	sValidator('json', outcomeSchema),
	async (c) => {
		const db = c.var.db;
		const actorUserId = c.var.user.id;
		const slug = c.req.param('slug');
		const data = c.req.valid('json');

		type OutcomeSuccess = {
			wager: typeof wager.$inferSelect;
			entries: (typeof ledger.$inferSelect)[];
		};

		const result: Result<OutcomeSuccess, WagerError> = await db.transaction(
			async (tx) => {
				const [wagerRow] = await tx
					.select()
					.from(wager)
					.where(eq(wager.slug, slug))
					.for('update')
					.limit(1);

				if (!wagerRow) return WagerError.NotFound();

				const wagerId = wagerRow.id;

				if (wagerRow.cancelledAt) {
					return WagerError.AlreadyResolved({ action: 'flip outcome on' });
				}

				const isCommitter = wagerRow.committerId === actorUserId;
				if (!isCommitter) {
					const [witnessRow] = await tx
						.select({ id: witness.id })
						.from(witness)
						.where(
							and(
								eq(witness.wagerId, wagerId),
								eq(witness.userId, actorUserId),
							),
						)
						.limit(1);
					if (!witnessRow) {
						return WagerError.OutcomeForbidden();
					}
				}

				// No-op flip: preserve the original outcomeAt / outcomeActorId — the
				// attribution belongs to whoever set the outcome first, not to a
				// subsequent idempotent retry.
				if (wagerRow.outcome === data.outcome) {
					return Ok({ wager: wagerRow, entries: [] });
				}

				const witnesses = await tx
					.select({
						id: witness.id,
						userId: witness.userId,
					})
					.from(witness)
					.where(eq(witness.wagerId, wagerId))
					.orderBy(witness.joinedAt);

				// Should be impossible: POST /wagers rejects empty witness lists.
				// Surface as 500 (thrown, not a domain error) if DB state drifted —
				// this isn't a permission problem and OutcomeForbidden would lie.
				if (witnesses.length === 0) {
					throw new Error(
						`Wager ${wagerId} has no witnesses — DB state is inconsistent.`,
					);
				}

				const committerId = wagerRow.committerId;
				// `Math.round` is load-bearing: `Number("10.01") * 100 = 1000.9999...`
				// in IEEE-754. All numeric(10,2) values round-trip cleanly via round.
				const amountCents = Math.round(Number(wagerRow.amount) * 100);
				const baseCents = Math.floor(amountCents / witnesses.length);
				const remainderCents = amountCents % witnesses.length;
				// Invariant: baseCents * N + remainderCents = amountCents,
				// so Σ shareCents across all witnesses = amountCents exactly.

				// One grouped query for all prior (committer → witness) sums on this
				// wager. `::bigint` returns as string from pg; parse in TS to avoid
				// int4 overflow at 2^31 cents (~$21M aggregated).
				const priorSumRows = await tx
					.select({
						toUserId: ledger.toUserId,
						totalCents: sql<string>`coalesce(sum(${ledger.amount} * 100), 0)::bigint`,
					})
					.from(ledger)
					.where(
						and(
							eq(ledger.wagerId, wagerId),
							eq(ledger.fromUserId, committerId),
						),
					)
					.groupBy(ledger.toUserId);

				const currentCentsByUser = new Map<string, number>();
				for (const row of priorSumRows) {
					currentCentsByUser.set(row.toUserId, Number(row.totalCents));
				}

				const entries: (typeof ledger.$inferSelect)[] = [];

				for (let i = 0; i < witnesses.length; i += 1) {
					const w = witnesses[i]!;
					// First `remainderCents` witnesses get +1 to absorb the rounding
					// penny so all shares sum to amountCents exactly.
					const shareCents = baseCents + (i < remainderCents ? 1 : 0);
					const expectedCents = data.outcome === 'missed' ? shareCents : 0;
					const currentCents = currentCentsByUser.get(w.userId) ?? 0;
					const deltaCents = expectedCents - currentCents;

					if (deltaCents === 0) continue;

					const [entry] = await tx
						.insert(ledger)
						.values({
							wagerId,
							fromUserId: committerId,
							toUserId: w.userId,
							actorUserId,
							amount: (deltaCents / 100).toFixed(2),
							currency: wagerRow.currency,
						})
						.returning();

					if (entry) entries.push(entry);
				}

				// The FOR UPDATE lock at the top of the tx guarantees this row
				// exists and is exclusively ours for the rest of the tx, so
				// `.returning()` cannot come back empty here.
				const [updatedWager] = await tx
					.update(wager)
					.set({
						outcome: data.outcome,
						outcomeAt: new Date(),
						outcomeActorId: actorUserId,
					})
					.where(eq(wager.id, wagerId))
					.returning();

				return Ok({ wager: updatedWager!, entries });
			},
		);

		if (result.error) {
			return c.json(result, WagerErrorHttpStatus[result.error.name]);
		}
		return c.json({
			...result.data,
			wager: { ...result.data.wager, state: deriveState(result.data.wager) },
		});
	},
);

// ── Balances & payments ──────────────────────────────────────────────────

/**
 * GET /balances
 *
 * Return current balances for the authenticated user against every
 * counterparty they share a ledger with.
 *
 * Invariant: each ledger row encodes a directional obligation. Summing
 * `amount` over rows where (from_user_id = X, to_user_id = Y) gives how much
 * X currently owes Y. Payments that settle a debt are written with negative
 * amount in the same (from, to) direction, so the sum drops back to zero.
 *
 * Balance for `userId` against counterparty C, positive = C owes userId:
 *     SUM(amount where from=C, to=userId)    (what C owes userId)
 *   − SUM(amount where from=userId, to=C)    (what userId owes C)
 *
 * Queries each direction separately so both can use their single-column
 * index (`ledger_from_user_idx`, `ledger_to_user_idx`). A combined `OR`
 * filter with a `CASE` in GROUP BY can't use either index cleanly.
 */
betchaRoutes.get('/balances', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;

	const [userOwesOthers, othersOweUser] = await Promise.all([
		db
			.select({
				counterpartyId: ledger.toUserId,
				totalCents: sql<string>`coalesce(sum(${ledger.amount} * 100), 0)::bigint`,
			})
			.from(ledger)
			.where(eq(ledger.fromUserId, userId))
			.groupBy(ledger.toUserId),
		db
			.select({
				counterpartyId: ledger.fromUserId,
				totalCents: sql<string>`coalesce(sum(${ledger.amount} * 100), 0)::bigint`,
			})
			.from(ledger)
			.where(eq(ledger.toUserId, userId))
			.groupBy(ledger.fromUserId),
	]);

	const centsByCounterparty = new Map<string, number>();
	for (const row of othersOweUser) {
		centsByCounterparty.set(row.counterpartyId, Number(row.totalCents));
	}
	for (const row of userOwesOthers) {
		const existing = centsByCounterparty.get(row.counterpartyId) ?? 0;
		centsByCounterparty.set(
			row.counterpartyId,
			existing - Number(row.totalCents),
		);
	}

	return c.json(
		[...centsByCounterparty].map(([counterpartyUserId, cents]) => ({
			userId: counterpartyUserId,
			balance: (cents / 100).toFixed(2),
		})),
	);
});

/**
 * POST /payments
 *
 * Record a payment that reduces an existing balance. Payments have no
 * associated wager (`wagerId` is null).
 */
betchaRoutes.post('/payments', sValidator('json', paymentSchema), async (c) => {
	const data = c.req.valid('json');
	const db = c.var.db;
	const userId = c.var.user.id;

	if (Number(data.amount) <= 0) {
		return c.json(WagerError.InvalidAmount(), 400);
	}

	if (data.toUserId === userId) {
		return c.json(WagerError.SelfPayment(), 400);
	}

	const [paymentEntry] = await db
		.insert(ledger)
		.values({
			wagerId: null,
			fromUserId: userId,
			toUserId: data.toUserId,
			actorUserId: userId,
			amount: (-Number(data.amount)).toFixed(2),
			currency: data.currency,
		})
		.returning();

	return c.json(paymentEntry, 201);
});

export { betchaRoutes };
