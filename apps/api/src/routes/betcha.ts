import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../app';
import { ledger, user, wager, witness } from '../db';

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
	WitnessNotFound: () => ({
		message: 'You are not a witness on this wager.',
	}),
	OnlyCommitter: ({ action }: { action: string }) => ({
		message: `Only the committer can ${action} this wager.`,
		action,
	}),
	OutcomeForbidden: () => ({
		message: 'Only the committer or an accepted witness can flip the outcome.',
	}),
	InvalidStatus: ({
		allowed,
		action,
	}: {
		allowed: readonly string[];
		action: string;
	}) => ({
		message: `Only ${allowed.join(' or ')} wagers can be ${action}.`,
		allowed: [...allowed],
		action,
	}),
	NotLive: () => ({ message: 'Only live wagers have an outcome.' }),
	NoAcceptedWitnesses: () => ({
		message: 'At least one witness must accept before activation.',
	}),
	NoSplitRecipients: () => ({
		message: 'No accepted witnesses to split the pot with.',
	}),
	InvalidDeadline: () => ({ message: 'Deadline must be a valid date.' }),
	InvalidAmount: () => ({ message: 'Amount must be greater than 0.' }),
	NoUsableWitnesses: () => ({
		message: 'Add at least one witness who is not yourself.',
	}),
	InsertFailed: () => ({ message: 'Could not create the wager.' }),
	SelfPayment: () => ({ message: "You can't pay yourself." }),
});
type WagerError = InferErrors<typeof WagerError>;

/**
 * Map a business-domain error to its HTTP status. Keeps HTTP concerns out of
 * the transaction/service layer — the tx returns `Result<T, WagerError>` and
 * the handler routes each variant to a status code here.
 */
function httpStatus(error: WagerError): ContentfulStatusCode {
	switch (error.name) {
		case 'NotFound':
		case 'WitnessNotFound':
			return 404;
		case 'OnlyCommitter':
		case 'OutcomeForbidden':
			return 403;
		case 'InsertFailed':
			return 500;
		case 'InvalidStatus':
		case 'NotLive':
		case 'NoAcceptedWitnesses':
		case 'NoSplitRecipients':
		case 'InvalidDeadline':
		case 'InvalidAmount':
		case 'NoUsableWitnesses':
		case 'SelfPayment':
			return 400;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function getWagerWitnesses(
	db: Env['Variables']['db'],
	wagerId: string,
) {
	return db
		.select({
			id: witness.id,
			wagerId: witness.wagerId,
			userId: witness.userId,
			invitedBy: witness.invitedBy,
			acceptedAt: witness.acceptedAt,
			joinedAt: witness.joinedAt,
			user: {
				id: user.id,
				name: user.name,
				image: user.image,
			},
		})
		.from(witness)
		.innerJoin(user, eq(witness.userId, user.id))
		.where(eq(witness.wagerId, wagerId))
		.orderBy(witness.joinedAt);
}

// ── Wager CRUD ───────────────────────────────────────────────────────────

/**
 * POST /wagers
 *
 * Create a draft wager. The authenticated user is the committer. Invited
 * witnesses are added as witness rows (unaccepted).
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

		const [createdWager] = await db
			.insert(wager)
			.values({
				title: data.title,
				description: data.description,
				amount: data.amount,
				currency: data.currency ?? 'USD',
				deadline,
				status: 'draft',
				committerId: userId,
			})
			.returning();

		if (!createdWager) {
			return c.json(WagerError.InsertFailed(), 500);
		}

		await db.insert(witness).values(
			witnessUserIds.map((witnessUserId) => ({
				wagerId: createdWager.id,
				userId: witnessUserId,
				invitedBy: userId,
			})),
		);

		const witnesses = await getWagerWitnesses(db, createdWager.id);

		return c.json({ ...createdWager, witnesses }, 201);
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

	const asWitnessRows = await db
		.select({ wagerId: witness.wagerId })
		.from(witness)
		.where(eq(witness.userId, userId));

	const asCommitterRows = await db
		.select({ id: wager.id })
		.from(wager)
		.where(eq(wager.committerId, userId));

	const wagerIds = [
		...new Set([
			...asWitnessRows.map((row) => row.wagerId),
			...asCommitterRows.map((row) => row.id),
		]),
	];

	if (wagerIds.length === 0) {
		return c.json([]);
	}

	const wagerRows = await db
		.select()
		.from(wager)
		.where(inArray(wager.id, wagerIds))
		.orderBy(desc(wager.createdAt));

	const witnessRows = await db
		.select({
			id: witness.id,
			wagerId: witness.wagerId,
			userId: witness.userId,
			invitedBy: witness.invitedBy,
			acceptedAt: witness.acceptedAt,
			joinedAt: witness.joinedAt,
			user: {
				id: user.id,
				name: user.name,
				image: user.image,
			},
		})
		.from(witness)
		.innerJoin(user, eq(witness.userId, user.id))
		.where(inArray(witness.wagerId, wagerIds))
		.orderBy(witness.joinedAt);

	const witnessesByWager = new Map<string, typeof witnessRows>();
	for (const row of witnessRows) {
		const existing = witnessesByWager.get(row.wagerId) ?? [];
		existing.push(row);
		witnessesByWager.set(row.wagerId, existing);
	}

	return c.json(
		wagerRows.map((wagerRow) => ({
			...wagerRow,
			witnesses: witnessesByWager.get(wagerRow.id) ?? [],
		})),
	);
});

/**
 * GET /wagers/:id
 *
 * Get one wager with its witnesses and ledger history.
 * Caller must be the committer or a witness.
 */
betchaRoutes.get('/wagers/:id', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const wagerId = c.req.param('id');

	const [wagerRow] = await db
		.select()
		.from(wager)
		.where(eq(wager.id, wagerId))
		.limit(1);

	if (!wagerRow) {
		return c.json(WagerError.NotFound(), 404);
	}

	if (wagerRow.committerId !== userId) {
		const [witnessRow] = await db
			.select({ id: witness.id })
			.from(witness)
			.where(
				and(eq(witness.wagerId, wagerId), eq(witness.userId, userId)),
			)
			.limit(1);

		if (!witnessRow) {
			return c.json(WagerError.NotFound(), 404);
		}
	}

	const witnesses = await getWagerWitnesses(db, wagerId);

	const ledgerHistory = await db
		.select()
		.from(ledger)
		.where(eq(ledger.wagerId, wagerId))
		.orderBy(desc(ledger.createdAt));

	return c.json({
		...wagerRow,
		witnesses,
		ledgerHistory,
	});
});

// ── Wager lifecycle ──────────────────────────────────────────────────────

/**
 * POST /wagers/:id/submit
 *
 * Move a wager from draft to sent (awaiting acceptance).
 */
betchaRoutes.post('/wagers/:id/submit', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const wagerId = c.req.param('id');

	const [wagerRow] = await db
		.select()
		.from(wager)
		.where(eq(wager.id, wagerId))
		.limit(1);

	if (!wagerRow) {
		return c.json(WagerError.NotFound(), 404);
	}

	if (wagerRow.committerId !== userId) {
		return c.json(WagerError.OnlyCommitter({ action: 'submit' }), 403);
	}

	if (wagerRow.status !== 'draft') {
		return c.json(
			WagerError.InvalidStatus({ allowed: ['draft'], action: 'submitted' }),
			400,
		);
	}

	const [updatedWager] = await db
		.update(wager)
		.set({ status: 'sent' })
		.where(eq(wager.id, wagerId))
		.returning();

	return c.json(updatedWager);
});

/**
 * POST /wagers/:id/accept
 *
 * Witness accepts the invitation. Idempotent.
 */
betchaRoutes.post('/wagers/:id/accept', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const wagerId = c.req.param('id');

	const [witnessRow] = await db
		.select()
		.from(witness)
		.where(and(eq(witness.wagerId, wagerId), eq(witness.userId, userId)))
		.limit(1);

	if (!witnessRow) {
		return c.json(WagerError.WitnessNotFound(), 404);
	}

	if (witnessRow.acceptedAt) {
		return c.json(witnessRow);
	}

	const [updatedWitness] = await db
		.update(witness)
		.set({ acceptedAt: new Date() })
		.where(eq(witness.id, witnessRow.id))
		.returning();

	return c.json(updatedWitness);
});

/**
 * POST /wagers/:id/activate
 *
 * Move a wager from sent to live. Requires at least one accepted witness.
 */
betchaRoutes.post('/wagers/:id/activate', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const wagerId = c.req.param('id');

	const [wagerRow] = await db
		.select()
		.from(wager)
		.where(eq(wager.id, wagerId))
		.limit(1);

	if (!wagerRow) {
		return c.json(WagerError.NotFound(), 404);
	}

	if (wagerRow.committerId !== userId) {
		return c.json(WagerError.OnlyCommitter({ action: 'activate' }), 403);
	}

	if (wagerRow.status !== 'sent') {
		return c.json(
			WagerError.InvalidStatus({ allowed: ['sent'], action: 'activated' }),
			400,
		);
	}

	const [counts] = await db
		.select({
			accepted: sql<number>`count(*) filter (where ${witness.acceptedAt} is not null)::int`,
		})
		.from(witness)
		.where(eq(witness.wagerId, wagerId));

	if (!counts || counts.accepted === 0) {
		return c.json(WagerError.NoAcceptedWitnesses(), 400);
	}

	const [updatedWager] = await db
		.update(wager)
		.set({ status: 'live' })
		.where(eq(wager.id, wagerId))
		.returning();

	return c.json(updatedWager);
});

/**
 * POST /wagers/:id/cancel
 *
 * Cancel a draft or sent wager (committer only, no live wagers).
 */
betchaRoutes.post('/wagers/:id/cancel', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const wagerId = c.req.param('id');

	const [wagerRow] = await db
		.select()
		.from(wager)
		.where(eq(wager.id, wagerId))
		.limit(1);

	if (!wagerRow) {
		return c.json(WagerError.NotFound(), 404);
	}

	if (wagerRow.committerId !== userId) {
		return c.json(WagerError.OnlyCommitter({ action: 'cancel' }), 403);
	}

	if (wagerRow.status !== 'draft' && wagerRow.status !== 'sent') {
		return c.json(
			WagerError.InvalidStatus({
				allowed: ['draft', 'sent'],
				action: 'cancelled',
			}),
			400,
		);
	}

	const [updatedWager] = await db
		.update(wager)
		.set({ status: 'cancelled' })
		.where(eq(wager.id, wagerId))
		.returning();

	return c.json(updatedWager);
});

// ── Outcome (the committer's verdict) ────────────────────────────────────

/**
 * POST /wagers/:id/outcome
 *
 * Flip the committer's outcome. Any accepted witness OR the committer can
 * call this. The pot-split ledger is reconciled inside the transaction via
 * per-witness deltas, so the operation is idempotent and append-only.
 *
 * Algorithm (inside tx, with FOR UPDATE on the wager row):
 *   1. Lock wager. If outcome already matches, return (no-op).
 *   2. Load accepted witnesses, ordered by joinedAt.
 *   3. Compute per-witness expected cents under new outcome:
 *        missed → floor(amount_cents / N); first `remainder` witnesses get +1
 *        done / pending → 0
 *   4. Single grouped query: current cents per witness from prior ledger rows
 *      (committer → *, this wager). Loop witnesses in memory; insert a delta
 *      row where expected - current != 0.
 *   5. Update wager.outcome, outcomeAt, outcomeActorId.
 */
betchaRoutes.post(
	'/wagers/:id/outcome',
	sValidator('json', outcomeSchema),
	async (c) => {
		const db = c.var.db;
		const actorUserId = c.var.user.id;
		const wagerId = c.req.param('id');
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
					.where(eq(wager.id, wagerId))
					.for('update')
					.limit(1);

				if (!wagerRow) return WagerError.NotFound();

				const isCommitter = wagerRow.committerId === actorUserId;
				if (!isCommitter) {
					const [witnessRow] = await tx
						.select({ acceptedAt: witness.acceptedAt })
						.from(witness)
						.where(
							and(
								eq(witness.wagerId, wagerId),
								eq(witness.userId, actorUserId),
							),
						)
						.limit(1);
					if (!witnessRow || !witnessRow.acceptedAt) {
						return WagerError.OutcomeForbidden();
					}
				}

				if (wagerRow.status !== 'live') return WagerError.NotLive();

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
					.where(
						and(
							eq(witness.wagerId, wagerId),
							isNotNull(witness.acceptedAt),
						),
					)
					.orderBy(witness.joinedAt);

				if (witnesses.length === 0) {
					return WagerError.NoSplitRecipients();
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

				const [updatedWager] = await tx
					.update(wager)
					.set({
						outcome: data.outcome,
						outcomeAt: new Date(),
						outcomeActorId: actorUserId,
					})
					.where(eq(wager.id, wagerId))
					.returning();

				if (!updatedWager) return WagerError.NotFound();
				return Ok({ wager: updatedWager, entries });
			},
		);

		if (result.error) {
			return c.json(result, httpStatus(result.error));
		}
		return c.json(result.data);
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
