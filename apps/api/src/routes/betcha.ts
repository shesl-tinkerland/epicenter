import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Env } from '../app';
import { challenge, ledger, participant, user } from '../db';

const betchaRoutes = new Hono<Env>();

// ── Validation schemas ───────────────────────────────────────────────────

const createChallengeSchema = type({
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

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a positive amount string to a negative 2-decimal string.
 *
 * Robust against `+5`, whitespace, scientific notation, and invalid input
 * that arktype's `string.numeric` might let through.
 */
function toNegativeAmount(value: string): string {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Expected positive numeric amount, got: ${value}`);
	}
	return (-parsed).toFixed(2);
}

async function getChallengeWitnesses(
	db: Env['Variables']['db'],
	challengeId: string,
) {
	return db
		.select({
			id: participant.id,
			challengeId: participant.challengeId,
			userId: participant.userId,
			invitedBy: participant.invitedBy,
			acceptedAt: participant.acceptedAt,
			joinedAt: participant.joinedAt,
			user: {
				id: user.id,
				name: user.name,
				image: user.image,
			},
		})
		.from(participant)
		.innerJoin(user, eq(participant.userId, user.id))
		.where(eq(participant.challengeId, challengeId))
		.orderBy(participant.joinedAt);
}

// ── Challenge CRUD ───────────────────────────────────────────────────────

/**
 * POST /challenges
 *
 * Create a draft challenge. The authenticated user is the committer. Invited
 * witnesses are added as participant rows (unaccepted).
 */
betchaRoutes.post(
	'/challenges',
	sValidator('json', createChallengeSchema),
	async (c) => {
		const data = c.req.valid('json');
		const db = c.var.db;
		const userId = c.var.user.id;
		const deadline = new Date(data.deadline);

		if (Number.isNaN(deadline.getTime())) {
			return c.json({ message: 'Deadline must be a valid date.' }, 400);
		}

		if (Number(data.amount) <= 0) {
			return c.json({ message: 'Amount must be greater than 0.' }, 400);
		}

		const witnessUserIds = [...new Set(data.witnessUserIds)].filter(
			(witnessUserId) => witnessUserId !== userId,
		);

		if (witnessUserIds.length === 0) {
			return c.json(
				{ message: 'Add at least one witness who is not yourself.' },
				400,
			);
		}

		const [createdChallenge] = await db
			.insert(challenge)
			.values({
				title: data.title,
				description: data.description ?? null,
				amount: data.amount,
				currency: data.currency ?? 'USD',
				deadline,
				status: 'draft',
				createdBy: userId,
			})
			.returning();

		if (!createdChallenge) {
			return c.json({ message: 'Could not create the challenge.' }, 500);
		}

		await db.insert(participant).values(
			witnessUserIds.map((witnessUserId) => ({
				challengeId: createdChallenge.id,
				userId: witnessUserId,
				invitedBy: userId,
			})),
		);

		const witnesses = await getChallengeWitnesses(db, createdChallenge.id);

		return c.json({ ...createdChallenge, witnesses }, 201);
	},
);

/**
 * GET /challenges
 *
 * List every challenge the current user is part of (as committer or witness),
 * newest first.
 */
betchaRoutes.get('/challenges', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;

	const asWitnessRows = await db
		.select({ challengeId: participant.challengeId })
		.from(participant)
		.where(eq(participant.userId, userId));

	const asCommitterRows = await db
		.select({ id: challenge.id })
		.from(challenge)
		.where(eq(challenge.createdBy, userId));

	const challengeIds = [
		...new Set([
			...asWitnessRows.map((row) => row.challengeId),
			...asCommitterRows.map((row) => row.id),
		]),
	];

	if (challengeIds.length === 0) {
		return c.json([]);
	}

	const challengeRows = await db
		.select()
		.from(challenge)
		.where(inArray(challenge.id, challengeIds))
		.orderBy(desc(challenge.createdAt));

	const witnessRows = await db
		.select({
			id: participant.id,
			challengeId: participant.challengeId,
			userId: participant.userId,
			invitedBy: participant.invitedBy,
			acceptedAt: participant.acceptedAt,
			joinedAt: participant.joinedAt,
			user: {
				id: user.id,
				name: user.name,
				image: user.image,
			},
		})
		.from(participant)
		.innerJoin(user, eq(participant.userId, user.id))
		.where(inArray(participant.challengeId, challengeIds))
		.orderBy(participant.joinedAt);

	const witnessesByChallenge = new Map<string, typeof witnessRows>();
	for (const row of witnessRows) {
		const existing = witnessesByChallenge.get(row.challengeId) ?? [];
		existing.push(row);
		witnessesByChallenge.set(row.challengeId, existing);
	}

	return c.json(
		challengeRows.map((challengeRow) => ({
			...challengeRow,
			witnesses: witnessesByChallenge.get(challengeRow.id) ?? [],
		})),
	);
});

/**
 * GET /challenges/:id
 *
 * Get one challenge with its witnesses and ledger history.
 * Caller must be the committer or a witness.
 */
betchaRoutes.get('/challenges/:id', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const challengeId = c.req.param('id');

	const [challengeRow] = await db
		.select()
		.from(challenge)
		.where(eq(challenge.id, challengeId))
		.limit(1);

	if (!challengeRow) {
		return c.json({ message: 'Challenge not found.' }, 404);
	}

	if (challengeRow.createdBy !== userId) {
		const [witnessRow] = await db
			.select({ id: participant.id })
			.from(participant)
			.where(
				and(
					eq(participant.challengeId, challengeId),
					eq(participant.userId, userId),
				),
			)
			.limit(1);

		if (!witnessRow) {
			return c.json({ message: 'Challenge not found.' }, 404);
		}
	}

	const witnesses = await getChallengeWitnesses(db, challengeId);

	const ledgerHistory = await db
		.select()
		.from(ledger)
		.where(eq(ledger.challengeId, challengeId))
		.orderBy(desc(ledger.createdAt));

	return c.json({
		...challengeRow,
		witnesses,
		ledgerHistory,
	});
});

// ── Challenge lifecycle ──────────────────────────────────────────────────

/**
 * POST /challenges/:id/submit
 *
 * Move a challenge from draft to sent (awaiting acceptance).
 */
betchaRoutes.post('/challenges/:id/submit', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const challengeId = c.req.param('id');

	const [challengeRow] = await db
		.select()
		.from(challenge)
		.where(eq(challenge.id, challengeId))
		.limit(1);

	if (!challengeRow) {
		return c.json({ message: 'Challenge not found.' }, 404);
	}

	if (challengeRow.createdBy !== userId) {
		return c.json(
			{ message: 'Only the committer can submit this challenge.' },
			403,
		);
	}

	if (challengeRow.status !== 'draft') {
		return c.json({ message: 'Only draft challenges can be submitted.' }, 400);
	}

	const [updatedChallenge] = await db
		.update(challenge)
		.set({ status: 'sent' })
		.where(eq(challenge.id, challengeId))
		.returning();

	return c.json(updatedChallenge);
});

/**
 * POST /challenges/:id/accept
 *
 * Witness accepts the invitation. Idempotent.
 */
betchaRoutes.post('/challenges/:id/accept', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const challengeId = c.req.param('id');

	const [witnessRow] = await db
		.select()
		.from(participant)
		.where(
			and(
				eq(participant.challengeId, challengeId),
				eq(participant.userId, userId),
			),
		)
		.limit(1);

	if (!witnessRow) {
		return c.json({ message: 'You are not a witness on this challenge.' }, 404);
	}

	if (witnessRow.acceptedAt) {
		return c.json(witnessRow);
	}

	const [updatedWitness] = await db
		.update(participant)
		.set({ acceptedAt: new Date() })
		.where(eq(participant.id, witnessRow.id))
		.returning();

	return c.json(updatedWitness);
});

/**
 * POST /challenges/:id/activate
 *
 * Move a challenge from sent to live. Requires at least one accepted witness.
 */
betchaRoutes.post('/challenges/:id/activate', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const challengeId = c.req.param('id');

	const [challengeRow] = await db
		.select()
		.from(challenge)
		.where(eq(challenge.id, challengeId))
		.limit(1);

	if (!challengeRow) {
		return c.json({ message: 'Challenge not found.' }, 404);
	}

	if (challengeRow.createdBy !== userId) {
		return c.json(
			{ message: 'Only the committer can activate this challenge.' },
			403,
		);
	}

	if (challengeRow.status !== 'sent') {
		return c.json(
			{ message: 'Only sent challenges can be activated.' },
			400,
		);
	}

	const [counts] = await db
		.select({
			accepted: sql<number>`count(*) filter (where ${participant.acceptedAt} is not null)::int`,
		})
		.from(participant)
		.where(eq(participant.challengeId, challengeId));

	if (!counts || counts.accepted === 0) {
		return c.json(
			{ message: 'At least one witness must accept before activation.' },
			400,
		);
	}

	const [updatedChallenge] = await db
		.update(challenge)
		.set({ status: 'live' })
		.where(eq(challenge.id, challengeId))
		.returning();

	return c.json(updatedChallenge);
});

/**
 * POST /challenges/:id/cancel
 *
 * Cancel a draft or sent challenge (committer only, no live challenges).
 */
betchaRoutes.post('/challenges/:id/cancel', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const challengeId = c.req.param('id');

	const [challengeRow] = await db
		.select()
		.from(challenge)
		.where(eq(challenge.id, challengeId))
		.limit(1);

	if (!challengeRow) {
		return c.json({ message: 'Challenge not found.' }, 404);
	}

	if (challengeRow.createdBy !== userId) {
		return c.json(
			{ message: 'Only the committer can cancel this challenge.' },
			403,
		);
	}

	if (challengeRow.status !== 'draft' && challengeRow.status !== 'sent') {
		return c.json(
			{ message: 'Only draft or sent challenges can be cancelled.' },
			400,
		);
	}

	const [updatedChallenge] = await db
		.update(challenge)
		.set({ status: 'cancelled' })
		.where(eq(challenge.id, challengeId))
		.returning();

	return c.json(updatedChallenge);
});

// ── Outcome (the committer's verdict) ────────────────────────────────────

/**
 * POST /challenges/:id/outcome
 *
 * Flip the committer's outcome. Any accepted witness OR the committer can
 * call this. The pot-split ledger is reconciled inside the transaction via
 * per-witness deltas, so the operation is idempotent and append-only.
 *
 * Algorithm (inside tx, with FOR UPDATE on the challenge row):
 *   1. Lock challenge. If outcome already matches, return (no-op).
 *   2. Load accepted witnesses, ordered by joinedAt.
 *   3. Compute per-witness expected cents under new outcome:
 *        missed → floor(amount_cents / N); first `remainder` witnesses get +1
 *        done / pending → 0
 *   4. For each witness:
 *        current = SUM(ledger.amount) for (committer → witness, this challenge,
 *                                          type='challenge_outcome')
 *        delta = expected - current
 *        if delta != 0: insert ledger row with amount = delta
 *   5. Update challenge.outcome, outcomeAt, outcomeActorId.
 */
betchaRoutes.post(
	'/challenges/:id/outcome',
	sValidator('json', outcomeSchema),
	async (c) => {
		const db = c.var.db;
		const actorUserId = c.var.user.id;
		const challengeId = c.req.param('id');
		const data = c.req.valid('json');

		const result = await db.transaction(async (tx) => {
			const [challengeRow] = await tx
				.select()
				.from(challenge)
				.where(eq(challenge.id, challengeId))
				.for('update')
				.limit(1);

			if (!challengeRow) {
				return { error: 'not_found' as const };
			}

			const isCommitter = challengeRow.createdBy === actorUserId;

			if (!isCommitter) {
				const [witnessRow] = await tx
					.select({ acceptedAt: participant.acceptedAt })
					.from(participant)
					.where(
						and(
							eq(participant.challengeId, challengeId),
							eq(participant.userId, actorUserId),
						),
					)
					.limit(1);

				if (!witnessRow || !witnessRow.acceptedAt) {
					return { error: 'forbidden' as const };
				}
			}

			if (challengeRow.status !== 'live') {
				return { error: 'not_live' as const };
			}

			if (!challengeRow.createdBy) {
				return { error: 'committer_missing' as const };
			}

			if (challengeRow.outcome === data.outcome) {
				return { ok: { challenge: challengeRow, entries: [] } };
			}

			const witnesses = await tx
				.select({
					id: participant.id,
					userId: participant.userId,
				})
				.from(participant)
				.where(
					and(
						eq(participant.challengeId, challengeId),
						isNotNull(participant.acceptedAt),
					),
				)
				.orderBy(participant.joinedAt);

			if (witnesses.length === 0) {
				return { error: 'no_witnesses' as const };
			}

			const committerId = challengeRow.createdBy;
			const amountCents = Math.round(Number(challengeRow.amount) * 100);
			const baseCents = Math.floor(amountCents / witnesses.length);
			const remainderCents = amountCents - baseCents * witnesses.length;

			const entries: (typeof ledger.$inferSelect)[] = [];

			for (let i = 0; i < witnesses.length; i += 1) {
				const witness = witnesses[i]!;
				const expectedCents =
					data.outcome === 'missed' ? baseCents + (i < remainderCents ? 1 : 0) : 0;

				const [currentRow] = await tx
					.select({
						totalCents: sql<number>`coalesce(sum(${ledger.amount} * 100), 0)::int`,
					})
					.from(ledger)
					.where(
						and(
							eq(ledger.challengeId, challengeId),
							eq(ledger.fromUserId, committerId),
							eq(ledger.toUserId, witness.userId),
							eq(ledger.type, 'challenge_outcome'),
						),
					);

				const currentCents = currentRow?.totalCents ?? 0;
				const deltaCents = expectedCents - currentCents;

				if (deltaCents === 0) continue;

				const [entry] = await tx
					.insert(ledger)
					.values({
						challengeId,
						fromUserId: committerId,
						toUserId: witness.userId,
						actorUserId,
						amount: (deltaCents / 100).toFixed(2),
						currency: challengeRow.currency,
						type: 'challenge_outcome',
					})
					.returning();

				if (entry) entries.push(entry);
			}

			const [updatedChallenge] = await tx
				.update(challenge)
				.set({
					outcome: data.outcome,
					outcomeAt: new Date(),
					outcomeActorId: actorUserId,
				})
				.where(eq(challenge.id, challengeId))
				.returning();

			return { ok: { challenge: updatedChallenge, entries } };
		});

		if ('error' in result) {
			switch (result.error) {
				case 'not_found':
					return c.json({ message: 'Challenge not found.' }, 404);
				case 'forbidden':
					return c.json(
						{ message: 'Only the committer or an accepted witness can flip the outcome.' },
						403,
					);
				case 'not_live':
					return c.json(
						{ message: 'Only live challenges have an outcome.' },
						400,
					);
				case 'committer_missing':
					return c.json(
						{ message: 'This challenge has no committer (account deleted).' },
						400,
					);
				case 'no_witnesses':
					return c.json(
						{ message: 'No accepted witnesses to split the pot with.' },
						400,
					);
			}
		}

		return c.json(result.ok);
	},
);

// ── Balances & payments ──────────────────────────────────────────────────

/**
 * GET /balances
 *
 * Return current balances for the authenticated user against every
 * counterparty they share a ledger with.
 */
betchaRoutes.get('/balances', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const otherUserIdSql = sql<string>`case
		when ${ledger.fromUserId} = ${userId} then ${ledger.toUserId}
		else ${ledger.fromUserId}
	end`;
	const balanceSql = sql<string>`sum(case
		when ${ledger.toUserId} = ${userId} then ${ledger.amount}
		else -${ledger.amount}
	end)::text`;
	const balanceRows = await db
		.select({
			userId: otherUserIdSql,
			balance: balanceSql,
		})
		.from(ledger)
		.where(or(eq(ledger.fromUserId, userId), eq(ledger.toUserId, userId)))
		.groupBy(otherUserIdSql);

	return c.json(
		balanceRows.filter(
			(row): row is typeof row & { userId: string } => row.userId !== null,
		),
	);
});

/**
 * POST /payments
 *
 * Record a payment that reduces an existing balance.
 */
betchaRoutes.post('/payments', sValidator('json', paymentSchema), async (c) => {
	const data = c.req.valid('json');
	const db = c.var.db;
	const userId = c.var.user.id;

	if (Number(data.amount) <= 0) {
		return c.json({ message: 'Amount must be greater than 0.' }, 400);
	}

	if (data.toUserId === userId) {
		return c.json({ message: "You can't pay yourself." }, 400);
	}

	const [paymentEntry] = await db
		.insert(ledger)
		.values({
			challengeId: null,
			fromUserId: userId,
			toUserId: data.toUserId,
			actorUserId: userId,
			amount: toNegativeAmount(data.amount),
			currency: data.currency,
			type: 'payment',
		})
		.returning();

	return c.json(paymentEntry, 201);
});

export { betchaRoutes };
