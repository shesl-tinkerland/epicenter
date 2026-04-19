import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Env } from './app';
import { challenge, ledger, participant, user } from './db';

const betchaRoutes = new Hono<Env>();

// ── Validation schemas ───────────────────────────────────────────────────

const createChallengeSchema = type({
	title: 'string > 0',
	'description?': 'string',
	amount: 'string.numeric',
	'currency?': 'string',
	deadline: 'string',
	participantUserIds: 'string[] >= 1',
});

const participantStatusSchema = type({
	status: "'done' | 'missed'",
});

const paymentSchema = type({
	toUserId: 'string',
	amount: 'string.numeric',
	currency: 'string',
});

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeNegativeAmount(value: string) {
	return value.startsWith('-') ? value : `-${value}`;
}

async function getChallengeParticipants(
	db: Env['Variables']['db'],
	challengeId: string,
) {
	return db
		.select({
			id: participant.id,
			challengeId: participant.challengeId,
			userId: participant.userId,
			status: participant.status,
			statusAt: participant.statusAt,
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

/**
 * Determine who receives the ledger entry when a participant is marked missed.
 * Prefers the challenge creator; falls back to another participant.
 */
function getLedgerRecipientUserId(params: {
	challengeRow: typeof challenge.$inferSelect;
	participantRows: Array<typeof participant.$inferSelect>;
	targetUserId: string;
}) {
	const { challengeRow, participantRows, targetUserId } = params;

	if (challengeRow.createdBy && challengeRow.createdBy !== targetUserId) {
		return challengeRow.createdBy;
	}

	return (
		participantRows.find((row) => row.userId !== targetUserId)?.userId ?? null
	);
}

// ── Challenge CRUD ───────────────────────────────────────────────────────

/**
 * POST /challenges
 *
 * Create a draft challenge and attach the creator plus invited participants.
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

		const invitedUserIds = [...new Set(data.participantUserIds)].filter(
			(participantUserId) => participantUserId !== userId,
		);

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

		await db.insert(participant).values([
			{ challengeId: createdChallenge.id, userId },
			...invitedUserIds.map((participantUserId) => ({
				challengeId: createdChallenge.id,
				userId: participantUserId,
			})),
		]);

		const participants = await getChallengeParticipants(
			db,
			createdChallenge.id,
		);

		return c.json({ ...createdChallenge, participants }, 201);
	},
);

/**
 * GET /challenges
 *
 * List every challenge the current user participates in, newest first.
 */
betchaRoutes.get('/challenges', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const challengeIdRows = await db
		.select({ challengeId: participant.challengeId })
		.from(participant)
		.where(eq(participant.userId, userId));

	if (challengeIdRows.length === 0) {
		return c.json([]);
	}

	const challengeIds = challengeIdRows.map((row) => row.challengeId);
	const challengeRows = await db
		.select()
		.from(challenge)
		.where(inArray(challenge.id, challengeIds))
		.orderBy(desc(challenge.createdAt));

	const participantRows = await db
		.select({
			id: participant.id,
			challengeId: participant.challengeId,
			userId: participant.userId,
			status: participant.status,
			statusAt: participant.statusAt,
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

	const participantsByChallenge = new Map<string, typeof participantRows>();
	for (const participantRow of participantRows) {
		const existingRows =
			participantsByChallenge.get(participantRow.challengeId) ?? [];
		existingRows.push(participantRow);
		participantsByChallenge.set(participantRow.challengeId, existingRows);
	}

	return c.json(
		challengeRows.map((challengeRow) => ({
			...challengeRow,
			participants: participantsByChallenge.get(challengeRow.id) ?? [],
		})),
	);
});

/**
 * GET /challenges/:id
 *
 * Get one challenge with its participants and ledger history.
 */
betchaRoutes.get('/challenges/:id', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const challengeId = c.req.param('id');
	const [challengeRow] = await db
		.select()
		.from(challenge)
		.innerJoin(participant, eq(participant.challengeId, challenge.id))
		.where(and(eq(challenge.id, challengeId), eq(participant.userId, userId)))
		.limit(1);

	if (!challengeRow) {
		return c.json({ message: 'Challenge not found.' }, 404);
	}

	const participants = await getChallengeParticipants(db, challengeId);

	// Inline — single call site, simple query
	const ledgerHistory = await db
		.select()
		.from(ledger)
		.where(eq(ledger.challengeId, challengeId))
		.orderBy(desc(ledger.createdAt));

	return c.json({
		...challengeRow.challenge,
		participants,
		ledgerHistory,
	});
});

// ── Challenge lifecycle ──────────────────────────────────────────────────

/**
 * POST /challenges/:id/submit
 *
 * Move a challenge from draft to pending.
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
			{ message: 'Only the creator can submit this challenge.' },
			403,
		);
	}

	if (challengeRow.status !== 'draft') {
		return c.json({ message: 'Only draft challenges can be submitted.' }, 400);
	}

	const [updatedChallenge] = await db
		.update(challenge)
		.set({ status: 'pending' })
		.where(eq(challenge.id, challengeId))
		.returning();

	return c.json(updatedChallenge);
});

/**
 * POST /challenges/:id/accept
 *
 * Placeholder accept route for future invite flows.
 */
betchaRoutes.post('/challenges/:id/accept', async (c) => {
	const db = c.var.db;
	const userId = c.var.user.id;
	const challengeId = c.req.param('id');
	const [participantRow] = await db
		.select()
		.from(participant)
		.where(
			and(
				eq(participant.challengeId, challengeId),
				eq(participant.userId, userId),
			),
		)
		.limit(1);

	if (!participantRow) {
		return c.json({ message: 'You are not part of this challenge.' }, 404);
	}

	return c.json(participantRow);
});

/**
 * POST /challenges/:id/activate
 *
 * Move a challenge from pending to active.
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
			{ message: 'Only the creator can activate this challenge.' },
			403,
		);
	}

	if (challengeRow.status !== 'pending') {
		return c.json(
			{ message: 'Only pending challenges can be activated.' },
			400,
		);
	}

	const [participantCountRow] = await db
		.select({ count: sql<number>`count(*)` })
		.from(participant)
		.where(eq(participant.challengeId, challengeId));

	if (!participantCountRow || participantCountRow.count === 0) {
		return c.json(
			{ message: 'Add participants before you activate this challenge.' },
			400,
		);
	}

	const [updatedChallenge] = await db
		.update(challenge)
		.set({ status: 'active' })
		.where(eq(challenge.id, challengeId))
		.returning();

	return c.json(updatedChallenge);
});

/**
 * POST /challenges/:id/cancel
 *
 * Cancel a draft or pending challenge.
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
			{ message: 'Only the creator can cancel this challenge.' },
			403,
		);
	}

	if (challengeRow.status !== 'draft' && challengeRow.status !== 'pending') {
		return c.json(
			{ message: 'Only draft or pending challenges can be cancelled.' },
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

// ── Participant status ───────────────────────────────────────────────────

/**
 * POST /challenges/:id/participants/:participantId/status
 *
 * Update one participant's status and write the matching ledger record
 * in the same transaction.
 */
betchaRoutes.post(
	'/challenges/:id/participants/:participantId/status',
	sValidator('json', participantStatusSchema),
	async (c) => {
		const db = c.var.db;
		const actorUserId = c.var.user.id;
		const challengeId = c.req.param('id');
		const participantId = c.req.param('participantId');
		const data = c.req.valid('json');

		// Validate outside the transaction — reads don't need tx isolation
		const [challengeRow] = await db
			.select()
			.from(challenge)
			.where(eq(challenge.id, challengeId))
			.limit(1);

		if (!challengeRow) {
			return c.json({ message: 'Challenge not found.' }, 404);
		}

		const [actorParticipantRow] = await db
			.select()
			.from(participant)
			.where(
				and(
					eq(participant.challengeId, challengeId),
					eq(participant.userId, actorUserId),
				),
			)
			.limit(1);

		if (!actorParticipantRow) {
			return c.json(
				{ message: 'Only participants can change challenge status.' },
				403,
			);
		}

		const [targetParticipantRow] = await db
			.select()
			.from(participant)
			.where(
				and(
					eq(participant.id, participantId),
					eq(participant.challengeId, challengeId),
				),
			)
			.limit(1);

		if (!targetParticipantRow) {
			return c.json({ message: 'Participant not found.' }, 404);
		}

		// No-op if status hasn't changed
		if (targetParticipantRow.status === data.status) {
			return c.json({ participant: targetParticipantRow, ledgerEntry: null });
		}

		// Mutation in transaction — participant update + ledger insert are atomic
		const result = await db.transaction(async (tx) => {
			const allParticipantRows = await tx
				.select()
				.from(participant)
				.where(eq(participant.challengeId, challengeId));

			const recipientUserId = getLedgerRecipientUserId({
				challengeRow,
				participantRows: allParticipantRows,
				targetUserId: targetParticipantRow.userId,
			});

			const [updatedParticipant] = await tx
				.update(participant)
				.set({ status: data.status, statusAt: new Date() })
				.where(eq(participant.id, participantId))
				.returning();

			let ledgerEntry: typeof ledger.$inferSelect | null = null;

			if (recipientUserId && recipientUserId !== targetParticipantRow.userId) {
				const isMarkingMissed = data.status === 'missed';
				const isReversingMissed = targetParticipantRow.status === 'missed';

				if (isMarkingMissed || isReversingMissed) {
					const [entry] = await tx
						.insert(ledger)
						.values({
							challengeId,
							fromUserId: targetParticipantRow.userId,
							toUserId: recipientUserId,
							actorUserId,
							amount: isMarkingMissed
								? challengeRow.amount
								: normalizeNegativeAmount(challengeRow.amount),
							currency: challengeRow.currency,
							type: isMarkingMissed
								? 'participant_status'
								: 'participant_status_reversal',
						})
						.returning();
					ledgerEntry = entry ?? null;
				}
			}

			return { participant: updatedParticipant, ledgerEntry };
		});

		return c.json(result);
	},
);

// ── Balances & payments ──────────────────────────────────────────────────

/**
 * GET /balances
 *
 * Return current friend balances for the authenticated user.
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
			amount: normalizeNegativeAmount(data.amount),
			currency: data.currency,
			type: 'payment',
		})
		.returning();

	return c.json(paymentEntry, 201);
});

export { betchaRoutes };
