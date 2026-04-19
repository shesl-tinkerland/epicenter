# Server-Authoritative Apps: Betcha + The Ark

**Date**: 2026-04-13
**Last Updated**: 2026-04-19 (Betcha lifecycle simplification: create-live, friends-as-witnesses, no acceptance)
**Status**: Phase 0 + Phase 1 Implemented; Phase 1 schema redesigned 2026-04-19; lifecycle simplified 2026-04-19
**Author**: AI-assisted (Sisyphus)

> **Readers**: the two "Review" sections at the bottom describe the live implementation. The earlier "Schema Redesign" review (draft → sent → live) is historical — superseded by the later "Lifecycle Simplification" review. When they conflict, the later review wins.

## Overview

Add two new server-authoritative apps to Epicenter—**Betcha** (betcha.so), a Splitwise-inspired accountability/wager app, and **The Ark** (theark.so), a social media platform—sharing a single PlanetScale Postgres database (EU region) with all tables in the `public` schema via Cloudflare Hyperdrive. Both reuse Better Auth for identity and the existing OAuth provider infrastructure, but store domain data in dedicated Postgres tables (organized by file) rather than Yjs/workspace CRDTs.

This spec also defines the **platform architecture** for how first-party Epicenter apps get privileged database access while third-party apps use "Sign in with Epicenter" via OAuth 2.1.

## Motivation

### Current State

Epicenter's existing apps (Whispering, Opensidian, Tab Manager, Honeycrisp) are all **local-first** via `@epicenter/workspace` + Yjs CRDTs. The sync server is a relay—it applies CRDT updates but has zero business logic authority. Auth lives in Postgres via Hyperdrive with Drizzle ORM.

This creates a gap:

1. **Challenges involve two parties agreeing on terms, money, and statuses.** CRDTs auto-merge conflicts—if two users simultaneously mark a challenge as `done` and `missed`, LWW picks one arbitrarily. That's data corruption, not conflict resolution.
2. **Social media needs authoritative feeds, follower counts, and notifications.** Fan-out reads, social graph JOINs, and reliable write ordering are Postgres strengths that SQLite/D1/CRDTs can't match at this layer.
3. **Cross-app integration** (e.g., "show me friends who have active wagers") requires relational JOINs across app boundaries—impossible with separate CRDTs or D1 databases.

### Desired State

Server-authoritative apps live alongside local-first apps in the same monorepo, sharing auth and UI components but using Postgres + TanStack Query instead of workspace CRDTs. The data model supports cross-app queries via standard relational JOINs.

## Research Findings

### Database Strategy

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Yjs/workspace CRDTs | Existing infra, local-first | No server authority, LWW conflicts, no transactions | ❌ Wrong tool |
| Cloudflare D1 per app | Clean isolation, CF-native | Expected transient errors ("not unexpected" per CF team), single-writer bottleneck, 10GB cap, import blocks DB, Drizzle+D1 bugs, vendor lock-in | ❌ Too unreliable |
| Separate Postgres per app | Strong isolation | Operational overhead, no cross-app JOINs, multiple Hyperdrive configs | ❌ Over-engineered |
| **Shared Postgres, single schema, file-per-domain** | Cross-app JOINs, one Hyperdrive, standard `pgTable()` everywhere, no Drizzle schema bugs, shared tables naturally accessible | Shared blast radius (mitigated by query timeouts) | ✅ Best fit |

**Key finding**: Drizzle's multi-file schema support via glob config is sufficient for domain separation. Separate Postgres schemas (`pgSchema()`) add Drizzle tooling friction (bugs #5274, #4969, #5609) without meaningful benefit when all apps are first-party. File-based organization (`betcha-schema.ts`, `ark-schema.ts`) provides clear ownership at the code level. Shared domain concepts (follows, notifications) live as plain `pgTable()` tables accessible to all apps without cross-schema complexity.

### Drizzle Multi-File Schema Organization

Drizzle config accepts a glob or array for multiple schema files:

```typescript
// apps/api/drizzle.config.ts
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/*.ts',  // ← glob picks up all schema files
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL },
});
```

All tables use `pgTable()` — the same API as the existing auth tables. Domain separation is file-based, not schema-based:

```typescript
// Existing auth tables — UNCHANGED
import { pgTable } from 'drizzle-orm/pg-core';
export const user = pgTable('user', { ... });

// New app tables — same API, separate file
// apps/api/src/db/betcha-schema.ts
import { pgTable } from 'drizzle-orm/pg-core';
export const challenge = pgTable('challenge', { ... });
```

FKs and JOINs work naturally — everything is in the same schema:

```typescript
// betcha-schema.ts
export const challenge = pgTable('challenge', {
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  // ↑ FK to user — standard FK, no cross-schema complexity
});
```

```typescript
// Generates: SELECT ... FROM "challenge" INNER JOIN "user" ...
db.select().from(challenge).innerJoin(user, eq(challenge.createdBy, user.id));
```
### Payment Model

| Model | Pros | Cons | Verdict |
|---|---|---|---|
| Virtual points | Simplest, no regulation | Less compelling psychology | Possible future addition |
| Real money via Stripe | Actual stakes | Money transmitter license | ❌ Legal burden |
| **Splitwise model** | Real money, zero regulation, proven | Settlement is self-reported | ✅ Best fit |

**Key finding**: Splitwise explicitly states "Splitwise doesn't actually handle any real money" for Venmo/PayPal settlement. They're a ledger that links to payment apps. This avoids money transmitter status. Splitwise ran this model for years before adding their own bank-integrated "Splitwise Pay" (via a partner bank). The self-report model is the proven MVP.

**Betcha is a ledger.** Bets change balances between friends. Payments reduce balances. These are independent operations. The app never knows if a payment actually happened—it knows when the sender says "I paid" and the recipient says "I received."

### International Payment Methods

Venmo is US-only. Global support requires multiple methods:

| Region | Primary App | Deep Link | Amount Pre-fill |
|---|---|---|---|
| US | Venmo | `venmo://paycharge?txn=pay&recipients=USER&amount=AMT&note=NOTE` | ✅ |
| Global | PayPal | `https://paypal.me/USER/AMT` | ✅ |
| UK/EU | Revolut | `https://revolut.me/USER` | ❌ |
| India | UPI | `upi://pay?pa=USER&am=AMT&cu=INR&tn=NOTE` | ✅ |
| Global | Wise | `https://wise.com/pay/USER` | ❌ |
| Everywhere | Manual | N/A — "I paid outside the app" | N/A |

The **recipient** chooses how they get paid (stored in their payment preferences). The **sender** sees a deep link for the recipient's preferred method. PayPal is the universal fallback (web + mobile, 200+ countries).

### Region Strategy

| Option | Latency (US) | Latency (EU) | GDPR | Verdict |
|---|---|---|---|---|
| US (us-east-1) | ~10ms | ~100ms | Requires legal mechanisms | ⚠️ |
| **EU (eu-west-1)** | ~80-100ms | ~10ms | Compliant by default | ✅ |

Host in EU from day one. US has no data localization laws for consumer apps—storing US data in EU is fine. Hyperdrive caches reads globally, KV caches auth sessions globally, and writes are infrequent. The latency penalty is negligible.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| App name (wager) | **Betcha** (bet + chance) | Self-improvement through accountability. Domain: betcha.so |
| App name (social) | **The Ark** | theark.so |
| Database | PlanetScale Postgres (EU region) via Hyperdrive | Battle-tested (Cash App, Intercom), NVMe Metal upgrade path ($50/mo), Cloudflare partnership |
| Data isolation | File-per-domain in `public` schema | All first-party apps, shared domain concepts (follows, notifications), no Drizzle `pgSchema()` bugs, standard `pgTable()` everywhere |
| Auth tables | All tables in `public` schema | Single schema, file-based organization provides code-level namespacing |
| Wager model (redesigned 2026-04-19) | Unidirectional commitment: one committer stakes, N witnesses observe | The committer is the ONLY stakeholder. Witnesses stake nothing — they observe, judge, and collect a share of the pot only if the committer misses. Renamed from `challenge`/`participant` because "participant" implied stakeholder. |
| Wager lifecycle (simplified 2026-04-19) | **Create-live, no acceptance, no activation.** `POST /wagers` produces a live wager instantly. | Acceptance/activation exists to solve consent; friendship solves it upstream. See "Betcha Lifecycle Simplification" review for full rationale. |
| Witness eligibility (added 2026-04-19) | **Must be a mutual follow (friend) of the committer at create time.** | Friendship = standing consent to be a witness. No per-wager opt-in. Rejected wagers cite `WagerError.WitnessesMustBeFriends`. |
| Outcome model | Editable ledger — no verification ceremony | Committer OR any witness can flip `outcome` between `done` and `missed` at any time. Every flip writes compensating delta rows to the append-only ledger. History visible through `ledger.actorUserId`. |
| Deadline handling | **Lazy.** Past the deadline without an outcome, UI shows `awaiting_verdict`. No auto-miss cron. | Zero ops cost; add a worker only if the product demands it. |
| Payment model | Running balance + settle-up (Splitwise model) | Failed challenges accumulate a balance between friends. Pay whenever. App never touches money. Challenges change balances; payments reduce balances. Per-user payment methods are deferred to Phase 2. |
| Disputes | No dispute system—just edit the participant status | "Dispute" = someone changes the status. The ledger history shows who changed what. If you're in a flip-flop war, that's a friendship problem, not a software problem. |
| Group challenges | Same flow as 1v1, scales naturally | Each participant has their own status row. Anyone in the challenge can mark anyone's status. No majority voting in v1—add later if edit wars emerge. |
| Local-first layer | None—TanStack Query with optimistic updates | Challenges are social (need counterparty), offline-first creation is a weird UX |
| App framework | SvelteKit + Vite (same as Fuji/Honeycrisp) | Existing pattern, shares `@epicenter/ui` and `@epicenter/svelte` |
| API routes | New route modules in `apps/api` | Shared Postgres connection, shared auth middleware |
| Cross-app FKs | All tables FK to `user` directly | Same schema — standard FKs, no cross-schema complexity. Shared tables (follow, notification) accessible to all apps naturally. |
| Media storage | R2 (existing `ASSETS_BUCKET`) | Only metadata in Postgres |
| Third-party apps | OAuth 2.1 + PKCE via existing `oauthProvider` | "Sign in with Epicenter" already works. Third-party apps never touch schemas. |

## Philosophy: Why This Is a Ledger, Not a Court

Betcha is a shared ledger between friends. This single insight drives every design decision.

### The Deadline Does ONE Thing

When the deadline passes, any participant still marked `pending` auto-converts to `missed` and the balance adjusts immediately. That's it. No verification ceremony. No partner prompts. No waiting states. The system assumes failure on inaction—this is what makes it a commitment device.

Before the deadline, anyone in the challenge can mark a participant as `done`. After the deadline, anyone can flip any status (`done` ↔ `missed`). Every change creates a compensating ledger record. No history is rewritten—only appended.

### No Disputes, No Verification, No Windows

Traditional wager apps (StickK, Beeminder) have verification ceremonies: self-report → referee confirms → dispute window → resolution. This makes sense when the app charges your credit card and needs to be "right" before taking money.

Betcha never touches money. It's a ledger. If the status is wrong, you change it and the balance adjusts. "Dispute" is just "edit the status." The ledger history shows who changed what—social friction replaces enforcement.

This works because:
- **You're doing this with friends.** You can text them. You can see them. The app doesn't need to adjudicate your friendship.
- **The balance is always adjustable.** Marked as failed but you actually did it? Your friend flips it. Balance corrects.
- **Visible history is the accountability.** Every change is logged. Lying to your friend's face in a shared ledger history is harder than it sounds.
- **Payments are voluntary anyway.** Since settlement is self-reported (Splitwise model), getting the verdict "right" before settlement is ceremony—you can always adjust after.

### Why This Still Works as a Commitment Device

The default is **loss on inaction**. Miss the deadline and your balance worsens immediately. You feel it. That's the behavioral economics mechanism that makes StickK and Beeminder effective—the sting of losing money. The difference is that Betcha makes it trivially easy to correct mistakes, because correctness comes from the relationship, not the software.

### Same Flow for 1v1 and Groups

There's no separate "group verification" flow. Every challenge has participants. Each participant has their own status. Anyone in the challenge can mark anyone's status. For 1v1, that's 2 people. For a group of 5, that's 5 people. The interaction is identical: tap a person's row, mark `done` or `missed`.

If group challenges turn into edit wars (unlikely among friends), voting can be layered on later—the ledger history already records who marked what, so majority-wins is just a query on existing data. No schema change needed.

### Future: Optional Voting for Groups

If edit wars become a pattern, add opt-in majority voting:
- Each participant's `marked_done` / `marked_missed` action counts as a vote
- Majority wins; ties default to `missed`
- This is ~50 lines of API logic on top of the editable ledger—no schema changes
- Don't build it until you see the problem in the wild
## Architecture

### Platform Architecture: First-Party vs Third-Party

```
┌──────────────────────────────────────────────────────────────┐
│                     Epicenter Platform                        │
│                                                              │
│  FIRST-PARTY APPS (direct schema access)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Betcha   │ │ The Ark  │ │Whispering│ │Opensidian│       │
│  │(betcha.so)│ │(theark.so│ │  (Tauri) │ │(SvelteKit│       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘       │
│       │             │            │             │              │
│  Postgres schemas   │       Yjs/workspace CRDTs              │
│  Postgres (public schema)   │       Yjs/workspace CRDTs              │
│  (server-authority)         │       (local-first)                    │
│       ▼             ▼            ▼             ▼              │
│  ┌──────────────────────────────────────────────────┐       │
│  │  PlanetScale Postgres (EU) │ Durable Objects     │       │
│  │  PlanetScale Postgres (EU) │ Durable Objects     │       │
│  │  public.* (all tables)     │ (Yjs sync relay)    │       │
│                                                              │
│  ══════════════ API BOUNDARY ════════════════                │
│                                                              │
│  THIRD-PARTY APPS (OAuth + API only)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│  │ Fitness  │ │ Journal  │ │ Any app  │                     │
│  │ app      │ │ app      │ │          │                     │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘                    │
│       │             │            │                            │
│       ▼             ▼            ▼                            │
│  ┌──────────────────────────────────────────────────┐       │
│  │  OAuth 2.1 + PKCE: "Sign in with Epicenter"     │       │
│  │  Rate-limited public API endpoints               │       │
│  │  OIDC tokens (id_token with sub, name, email)    │       │
│  └──────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

This is the standard platform pattern used by Google (Gmail vs third-party apps), GitHub (Issues vs OAuth Apps), and Apple (iMessage vs Sign in with Apple). First-party apps get privileged infrastructure access. Third-party apps get a stable, documented API behind an OAuth boundary.

### OAuth Provider (Already Configured)

Better Auth is already configured as an OAuth 2.1 Authorization Server in `apps/api/src/auth/create-auth.ts`:

```typescript
oauthProvider({
  loginPage: '/sign-in',
  consentPage: '/consent',
  requirePKCE: true,
  allowDynamicClientRegistration: false,  // flip when ready for third-party devs
  trustedClients: [
    { clientId: 'epicenter-desktop', type: 'native', ... },
    { clientId: 'epicenter-mobile', type: 'native', ... },
    { clientId: 'epicenter-cli', type: 'native', ... },
  ],
})
```

**Supported flows**: Authorization Code + PKCE, Client Credentials, Refresh Tokens, Device Code (separate plugin). **OIDC**: id_token + `/oauth2/userinfo` when `openid` scope requested. **Custom scopes**: Supported (e.g., `read:post`, `write:post`).

**Third-party registration strategy**:
- **Now**: Manual—add clients via `auth.api.createOAuthClient()` or `trustedClients` config
- **Later (3-5 apps)**: PR-based registration to a config file
- **Eventually (10+ apps)**: Developer portal at `developers.epicenter.so` backed by `/oauth2/register`

No new tables needed—`oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent` already exist.

### Database Schema Layout

```
PlanetScale Postgres (eu-west-1) via Hyperdrive
│
└── public (all tables)
    │
    │  AUTH (Better Auth — unchanged)
    ├── user, session, account, verification, jwks
    ├── device_code, oauth_client, oauth_refresh_token
    ├── oauth_access_token, oauth_consent
    │
    │  PLATFORM
    ├── durable_object_instance, asset
    │
    │  BETCHA (apps/api/src/db/schema/betcha.ts) — redesigned 2026-04-19
    ├── wager                  ← The committer's stake + orthogonal status/outcome state machines
    ├── witness                ← Users invited to observe; accepted witnesses collect on miss
    ├── ledger                 ← Append-only deltas; wagerId NULL = manual payment, NOT NULL = outcome split
    │
    │  THE ARK (apps/api/src/db/ark-schema.ts)
    ├── profile, post, comment, reaction
    │
    │  SHARED (apps/api/src/db/shared-schema.ts)
    ├── follow                 ← Social graph: unidirectional; mutual = friends (used by Betcha + The Ark)
    │
    │  SHARED — FUTURE
    ├── notification           ← Activity notifications (deferred — delivery mechanism TBD)
    ├── community, community_member
```

### FK Dependency Graph

```
wager ──────────────FK──▶ user (committer: cascade; outcomeActor: set null)
witness ────────────FK──▶ user (userId: cascade; invitedBy: set null) + wager (cascade)
ledger ─────────────FK──▶ user (from/to: RESTRICT; actor: set null) + wager (set null)

profile ────────────FK──▶ user
post ───────────────FK──▶ user
follow ─────────────FK──▶ user (follower + following)
comment ────────────FK──▶ user + post

All tables in public schema — standard FKs, no cross-schema complexity.
```

**Ledger FK policy is intentionally `restrict` for `fromUserId`/`toUserId`** (not `set null`): ledger rows are immutable financial records. Allowing a counterparty to go NULL would silently corrupt balance sums across every surviving row. A user with any ledger history can't be hard-deleted without first settling (which writes compensating zero-sum rows). Soft-delete is the mechanism for account closure with outstanding history.

### Shared Drizzle Schema

```typescript
// apps/api/src/db/shared-schema.ts
import { index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { customAlphabet } from 'nanoid';
import { user } from './schema';

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
export const follow = pgTable('follow', {
  id: text('id').primaryKey().$defaultFn(generateId),
  followerId: text('follower_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  followingId: text('following_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique().on(t.followerId, t.followingId),
  index('follow_follower_id_idx').on(t.followerId),
  index('follow_following_id_idx').on(t.followingId),
]);
```
### Betcha Drizzle Schema (redesigned 2026-04-19)

The live schema is in `apps/api/src/db/schema/betcha.ts`. Below is the shape + rationale. Key changes vs. the original Phase 1 design:

| Old name | New name | Why renamed |
|---|---|---|
| `challenge` | `wager` | "Wager" names the staking act directly; "challenge" is generic SaaS-speak |
| `participant` | `witness` | "Participant" implied stakeholder — actively misleading since witnesses stake nothing |
| `challenge.createdBy` (nullable, set-null) | `wager.committerId` (NOT NULL, cascade) | Committer is a structural role, not an audit field. Nullable committer admits a state the code can't handle |
| `ledger.type` enum column | (derived from `wagerId IS NULL`) | One less column; payment vs. outcome is discoverable from the existing FK |
| `participant.status` (per-row) | `wager.outcome` (one value) | Only the committer has an outcome; there's no per-witness status |

**Single derived state on `wager`:**

```
live → {awaiting_verdict | cancelled | done | missed}
```

Derived from `outcome` (nullable), `cancelledAt`, and `deadline`. No stored
`status` column. Committer OR any witness can flip `outcome` between `done`
and `missed` at any time. Every flip writes compensating deltas to the
append-only ledger.

```typescript
// apps/api/src/db/schema/betcha.ts — shape summary (full file in repo)

// Stored tuple + CHECK constraint. Chose text-with-enum over pgEnum because
// removing an enum value via drizzle-kit generates a drop/cast migration that
// fails hard if any row still holds the removed value; CHECK is a one-line
// DROP/ADD.
export const wagerOutcomes = ['done', 'missed'] as const;  // NULL = pending

export const wager = pgTable('wager', {
  id: text('id').primaryKey().$defaultFn(generateId),
  committerId: text('committer_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  currency: text('currency').notNull().default('USD'),
  deadline: timestamp('deadline', { withTimezone: true }).notNull(),
  outcome: text('outcome', { enum: wagerOutcomes }),                     // NULL = no verdict
  outcomeAt: timestamp('outcome_at', { withTimezone: true }),
  outcomeActorId: text('outcome_actor_id').references(() => user.id, { onDelete: 'set null' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: text('cancelled_by').references(() => user.id, { onDelete: 'set null' }),
  // createdAt / updatedAt with $onUpdate
}, (t) => [
  check('wager_amount_positive', sql`amount > 0`),
  check('wager_outcome_valid', sql`outcome IS NULL OR outcome IN ('done', 'missed')`),
  index('wager_committer_idx').on(t.committerId),
]);

export const witness = pgTable('witness', {
  id: text('id').primaryKey().$defaultFn(generateId),
  wagerId: text('wager_id').notNull().references(() => wager.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  // updatedAt with $onUpdate
}, (t) => [
  unique().on(t.wagerId, t.userId),  // also the prefix index for wagerId scans
  index('witness_user_idx').on(t.userId),
]);

export const ledger = pgTable('ledger', {
  id: text('id').primaryKey().$defaultFn(generateId),
  wagerId: text('wager_id').references(() => wager.id, { onDelete: 'set null' }),
  // NOT NULL + restrict: user with ledger history can't be hard-deleted
  // without settling first (which writes compensating zero-sum rows). Allowing
  // NULL counterparties would silently corrupt balance sums.
  fromUserId: text('from_user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  toUserId: text('to_user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
  // no `type` column — wagerId IS NULL → manual payment; NOT NULL → outcome split
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  check('ledger_no_self_transfer', sql`from_user_id <> to_user_id`),
  index('ledger_from_user_idx').on(t.fromUserId),
  index('ledger_to_user_idx').on(t.toUserId),
  index('ledger_wager_idx').on(t.wagerId),
]);

// Phase 2: `user_payment_method` is deferred from the MVP schema.
```

### Pot-Split Arithmetic — Invariants

Implemented in `POST /wagers/:id/outcome` inside `db.transaction(...)` with `SELECT … FOR UPDATE` on the wager row.

Given: `amountCents = Math.round(Number(wager.amount) * 100)`, `N = accepted witnesses`, ordered by `joinedAt ASC`:

```
baseCents      = Math.floor(amountCents / N)
remainderCents = amountCents % N

shareCents(i) = baseCents + (i < remainderCents ? 1 : 0)  // first `remainder` witnesses get +1

expectedCents(i) = data.outcome === 'missed' ? shareCents(i) : 0
currentCents(i)  = SUM(ledger.amount*100) WHERE wagerId=X AND fromUserId=committer AND toUserId=witness_i
deltaCents(i)    = expectedCents(i) - currentCents(i)

If deltaCents(i) ≠ 0: INSERT ledger row with amount=delta/100, currency=wager.currency
Then: UPDATE wager SET outcome, outcomeAt, outcomeActorId
```

**Invariants the implementation proves:**

1. **Share conservation.** Σᵢ shareCents(i) = baseCents·N + remainderCents = amountCents. The rounding penny is always absorbed, never lost.
2. **Idempotence.** Flipping to the current outcome short-circuits before any writes; `outcomeAt`/`outcomeActorId` remain the original flipper's.
3. **Reversibility.** Flipping `missed → done` computes expected=0 for every witness; writes negative deltas that sum to `-amountCents`. Balance for the pair returns to zero.
4. **Append-only.** Ledger rows are never `UPDATE`d or `DELETE`d. Every flip appends; every reversal appends a compensating row.
5. **Race-safety.** `FOR UPDATE` on the wager row serializes concurrent flips. A second flip either short-circuits (same target) or computes a fresh delta against the committed state.
6. **Float safety.** `Math.round` on the cent conversion is load-bearing: `Number("10.01") * 100 = 1000.9999…` in IEEE-754. Round recovers every `numeric(10,2)` value exactly.
7. **Overflow safety.** `numeric(10,2)` caps a single wager at ~$99.99M → ≤10¹⁰ cents, well inside 2^53. Per-pair running sum is SQL-side `bigint`, parsed in TS through `Number(string)`.
8. **Currency conservation.** Every ledger row for a wager inherits `wager.currency`. Mixing currencies within a wager is impossible at write time.

### Error Handling — wellcrafted `defineErrors` + Hono

Route errors use wellcrafted's `defineErrors` namespace pattern (matches `AssetError` in `routes/assets.ts`). Each variant name describes a specific failure mode:

```typescript
const WagerError = defineErrors({
  NotFound: () => ({ message: 'Wager not found.' }),
  OnlyCommitter: ({ action }: { action: string }) => ({
    message: `Only the committer can ${action} this wager.`,
    action,
  }),
  InvalidStatus: ({ allowed, action }: { allowed: readonly string[]; action: string }) => ({
    message: `Only ${allowed.join(' or ')} wagers can be ${action}.`,
    allowed: [...allowed],
    action,
  }),
  // ... 10 more variants
});

// Simple handlers — inline c.json with the variant factory
if (!wagerRow) return c.json(WagerError.NotFound(), 404);
if (wagerRow.committerId !== userId) {
  return c.json(WagerError.OnlyCommitter({ action: 'submit' }), 403);
}

// The outcome-flip transaction returns Result<T, WagerError>. Business-level
// errors are regular returns (so the tx commits with no writes); throws are
// reserved for infrastructure failures (real rollbacks).
const result: Result<OutcomeSuccess, WagerError> = await db.transaction(async (tx) => {
  if (!wagerRow) return WagerError.NotFound();           // commits, no writes
  if (!authorized) return WagerError.OutcomeForbidden();  // commits, no writes
  // ... perform writes ...
  return Ok({ wager: updatedWager, entries });
});

if (result.error) return c.json(result, httpStatus(result.error));
return c.json(result.data);
```

`httpStatus(error: WagerError): ContentfulStatusCode` pattern-matches on `error.name` to route each variant to its code — keeping HTTP concerns out of the tx callback. The wire shape is `{ data: null, error: { name, message, ...fields } }` for errors (wellcrafted `Result` shape, serialized directly by `c.json`) and bare data for successes; matches the rest of the codebase.

### Drizzle Config Change

```typescript
// apps/api/drizzle.config.ts — ONLY CHANGE: schema path
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/*.ts',  // was: './src/db/schema.ts'
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
  },
});
```

### Drizzle Instance — Import All Schemas

```typescript
// apps/api/src/app.ts — expand schema import
import * as publicSchema from './db/schema';
import * as betchaSchema from './db/betcha-schema';
import * as sharedSchema from './db/shared-schema';

const schema = { ...publicSchema, ...betchaSchema, ...sharedSchema };

// Drizzle instance creation (unchanged pattern)
c.set('db', drizzle(client, { schema }));
```

### Wager State (derived, not stored)

The DB stores `outcome`, `cancelledAt`, and `deadline`. State is a pure
function of those three:

```
          ┌──────────┐
          │   live   │  outcome IS NULL, cancelledAt IS NULL, deadline > now()
          └────┬─────┘
               ├──────────────────────────────┐
               │                              │
               ▼ deadline passes, no flip     ▼ committer cancels
     ┌──────────────────┐               ┌──────────┐
     │ awaiting_verdict │               │ cancelled │
     └────────┬─────────┘               └──────────┘
              │
              │ any witness or committer flips
              ▼
      ┌───────────────┐
      │  done | missed │
      └───────────────┘

No draft/sent/activate ceremony. `POST /wagers` produces a live wager
directly. Lazy auto-miss: `awaiting_verdict` persists until someone flips.
```

### Outcome Transitions

```
  NULL ─────────────────┬──────────────────┐
                        │                  │
                        ▼                  ▼
                      done  ◄───────►  missed
                        │    (flip)      │
                        │    (each flip → ledger delta)
                        │                  │
                  no balance change    balance adjusts
                  (success)            (failure)

  Committer OR any witness can flip. Every flip appends compensating
  deltas to the ledger. Flipping to a value that's already set is a
  no-op (preserves original outcomeAt/outcomeActorId). Un-flipping back
  to NULL is not a supported operation — use cancel for that.
```

### UX Flow

**Live wager (before deadline, no outcome set):**
```
┌─────────────────────────────────────┐
│  Run 3x this week                   │
│  Committer: Alice                    │
│  Witnesses: Bob, Carol               │
│  Deadline: Apr 20 • Stake: $20       │
│  State: live                         │
│                                     │
│  [✅ I did it]   [❌ I missed]       │  ← Committer flips own outcome
└─────────────────────────────────────┘
```

**Awaiting verdict (deadline passed, still no outcome):**
```
┌─────────────────────────────────────┐
│  Run 3x this week                   │
│  State: awaiting_verdict             │
│                                     │
│  Deadline passed Apr 20. No one has  │
│  called it yet.                      │
│                                     │
│  [✅ Done]   [❌ Missed]             │  ← Committer OR any witness flips
└─────────────────────────────────────┘
```

**Resolved (outcome set, still flippable):**
```
┌─────────────────────────────────────┐
│  Run 3x this week                   │
│  State: missed • Set by Bob, Apr 20  │
│                                     │
│  Alice owes Bob    $10.00             │
│  Alice owes Carol  $10.00             │
│                                     │
│  [Change to ✅ done]                 │  ← Reversal posts negating deltas
└─────────────────────────────────────┘
```

**Ledger history (social friction via `actorUserId`):**
```
┌─────────────────────────────────────┐
│  History                             │
│                                     │
│  Apr 20  ❌ Bob flipped to missed    │  +$10 to Bob, +$10 to Carol
│  Apr 21  ✅ Alice flipped to done     │  −$10 Bob, −$10 Carol
│  Apr 21  ❌ Carol flipped to missed   │  +$10 Bob, +$10 Carol
│                                     │
│  Every flip is appended. Nothing     │
│  is ever deleted or rewritten.       │
└─────────────────────────────────────┘
```

**Running balance:**
```
┌─────────────────────────────────────┐
│  Balances                            │
│                                     │
│  You owe Bob      $53.33             │  ← accumulated across wagers
│  Carol owes you   $20.00             │
│                                     │
│  [💰 Record payment to Bob]          │  ← Deep-link/payment prefs deferred
└─────────────────────────────────────┘
```

**Group wager (N witnesses, one committer):**
```
┌─────────────────────────────────────┐
│  Run 3x this week                   │
│  Committer: Alice • Stake: $100      │
│  Witnesses: Bob, Carol, Dave, Eve    │
│  State: missed                       │
│                                     │
│  $100 ÷ 4 witnesses = $25 each        │
│                                     │
│  Ledger entries (committer → each):  │
│  Alice → Bob:   $25.00                │
│  Alice → Carol: $25.00                │
│  Alice → Dave:  $25.00                │
│  Alice → Eve:   $25.00                │
│                                     │
│  If flipped to done: four negating   │
│  −$25 rows are appended; balances    │
│  return to zero.                     │
└─────────────────────────────────────┘
```

> The old "participants staking against each other" mockup (everyone's status
> is their own, losers pay winners) is not how Betcha works. Only the
> committer stakes. Witnesses never owe anything — they only collect on miss.

### App Structure

```
apps/
├── betcha/                          ← NEW: SvelteKit app (betcha.so)
│   ├── src/
│   │   ├── routes/
│   │   │   ├── +layout.svelte       ← Auth gate via @epicenter/svelte
│   │   │   ├── +page.svelte         ← Dashboard (active challenges, history)
│   │   │   ├── challenges/
│   │   │   │   ├── new/+page.svelte  ← Create challenge
│   │   │   │   └── [id]/+page.svelte ← Challenge detail + actions
│   │   │   └── settle/[id]/+page.svelte ← Settlement flow
│   │   └── lib/
│   │       ├── queries.ts            ← TanStack Query hooks → API
│   │       └── deep-links.ts         ← Payment deep link generation
│   └── ...
│
├── theark/                           ← NEW: SvelteKit app (theark.so)
│   ├── src/
│   │   ├── routes/
│   │   │   ├── +layout.svelte
│   │   │   ├── +page.svelte          ← Feed (reverse-chronological)
│   │   │   ├── [username]/+page.svelte
│   │   │   ├── post/[id]/+page.svelte
│   │   │   └── communities/+page.svelte
│   │   └── lib/
│   │       └── queries.ts
│   └── ...
│
├── api/                              ← EXISTING: add route modules
│   ├── src/
│   │   ├── db/
│   │   │   ├── schema.ts            ← UNCHANGED (public schema tables)
│   │   │   ├── betcha-schema.ts     ← NEW: pgTable() tables for Betcha
│   │   │   ├── shared-schema.ts     ← NEW: pgTable() shared tables (follow)
│   │   │   └── ark-schema.ts        ← NEW: pgTable() tables for The Ark (future)
│   │   ├── betcha-routes.ts         ← NEW: challenge CRUD + state machine
│   │   ├── ark-routes.ts            ← NEW: social CRUD + feed (future)
│   │   └── app.ts                   ← Mount new routes, expand schema import
│   └── drizzle.config.ts            ← Update: schema: './src/db/*.ts'
```

### Data Flow

```
SvelteKit App (betcha.so / theark.so)
    │
    │ TanStack Query (optimistic updates, staleTime caching)
    │
    ▼
apps/api (Cloudflare Worker)
    │
    │ Hono routes → Drizzle ORM queries
    │ Auth: Bearer token validation via Better Auth
    │
    ▼
PlanetScale Postgres (eu-west-1)
    │
    │ Hyperdrive (connection pooling + read caching)
    │
└── all tables in public schema
```

## Implementation Plan

### Phase 0: Database Infrastructure

- [ ] **0.1** Confirm Postgres provider supports EU region, or migrate to PlanetScale Postgres (eu-west-1)
- [x] **0.2** Update `apps/api/drizzle.config.ts`: change `schema` to `'./src/db/*.ts'`
- [x] **0.3** Verify `drizzle-kit generate` produces correct DDL
- [x] **0.4** Expand schema import in `apps/api/src/app.ts` to include all schema files (publicSchema + betchaSchema + sharedSchema)

### Phase 1: Betcha — API Layer

- [x] **1.1** Create `apps/api/src/db/betcha-schema.ts` with `pgTable()` tables (challenge, participant, ledger)
- [x] **1.2** Create `apps/api/src/db/shared-schema.ts` with `pgTable()` table (follow) — enables friend selection for challenges
- [x] **1.3** Generate and run Drizzle migration for new tables
- [x] **1.4** Create `apps/api/src/betcha-routes.ts` — Hono routes:
  - CRUD: create challenge, get challenge, list user's challenges
  - Challenge lifecycle: submit, accept, decline, cancel
  - Participant statuses: mark done, mark missed (creates ledger record with `actorUserId`)
  - Deadline: cron/scheduled handler to auto-expire pending participants (deferred — requires wrangler.jsonc changes)
  - Balances: get running balance per friend pair
  - Payment recording only for MVP (`user_payment_method` deferred to Phase 2)
  - Follow/friend routes: follow user, unfollow, list friends (mutual follows), list followers
- [x] **1.5** Auth middleware: reuse existing `authGuard` from `app.ts` — already validates Bearer token and extracts user ID
- [x] **1.6** Wire betcha + shared routes into `apps/api/src/app.ts`
- [x] **1.7** Verify FK and JOIN work in practice
  > **Note**: Verified via type-check and LSP diagnostics. Cross-table JOINs confirmed working in route implementations (e.g., participant + user JOIN in challenge detail).

### Phase 2: Betcha — Frontend

- [ ] **2.1** Scaffold `apps/betcha/` SvelteKit app (copy Fuji/Honeycrisp skeleton)
- [ ] **2.2** Auth gate via `@epicenter/svelte`
- [ ] **2.3** TanStack Query hooks for challenge CRUD + participant status changes + balances
- [ ] **2.4** Pages: dashboard, create challenge, challenge detail + ledger history, balances + settle-up
- [ ] **2.5** Deep link generation / saved payment methods (Venmo, PayPal, Revolut, UPI, Wise, manual) — Phase 2 because `user_payment_method` is deferred from MVP
- [ ] **2.6** Deploy to Cloudflare Pages (betcha.so)

### Phase 3: Betcha — Group Challenges

- [ ] **3.1** Group challenge creation UI (invite N participants)
- [ ] **3.2** Pot-split ledger calculation (loser→winner pairs)
- [ ] **3.3** Group challenge detail page showing N participant statuses
- [ ] **3.4** Optional: majority voting layer if edit wars emerge

### Phase 4: The Ark — API Layer

- [ ] **4.1** Create `apps/api/src/db/ark-schema.ts` with `pgTable()` tables
- [ ] **4.2** Generate and run migration for social schema
- [ ] **4.3** Create `apps/api/src/ark-routes.ts` — Hono routes: profiles, posts, feed, follows, communities
- [ ] **4.4** Feed: reverse-chronological, followers only

### Phase 5: The Ark — Frontend

- [ ] **5.1** Scaffold `apps/theark/` SvelteKit app
- [ ] **5.2** Pages: feed, profile, post detail, communities
- [ ] **5.3** Media upload via R2 (existing asset infrastructure)
- [ ] **5.4** Deploy to Cloudflare Pages (theark.so)

### Phase 6: Cross-App Integration

- [ ] **6.1** API endpoint: "friends with active challenges" (JOIN: follow + challenge)
- [ ] **6.2** Shared notification system
- [ ] **6.3** Unified user profile showing challenge history + social activity

### Phase 7: Platform (When Demand Exists)

- [ ] **7.1** Flip `allowDynamicClientRegistration: true` in OAuth provider config
- [ ] **7.2** Define public API scopes (e.g., `read:challenges`, `read:profile`)
- [ ] **7.3** Rate limiting on public API endpoints
- [ ] **7.4** Developer registration page at `developers.epicenter.so`

## Edge Cases

### Status Flip-Flops

1. Alice marks Bob as `done`, Bob flips to `missed`, Alice flips back
2. Each flip creates a compensating ledger record (balance swings back and forth)
3. Ledger history makes this visible—social friction discourages it
4. If it becomes a pattern: stop making challenges with that person (product limit, not software limit)
5. Future: optional majority voting for groups to prevent one person overriding consensus

### Simultaneous Status Changes

1. Two people try to mark the same participant at the same time
2. Postgres transaction isolation prevents double-processing
3. Last transaction wins—both changes appear in ledger history

### User Deletes Account

1. Active challenges are auto-cancelled (no ledger records)
2. `createdBy` set to NULL (`onDelete: 'set null'`)—completed challenges remain readable as historical records
3. Ledger entries preserved (amounts and dates remain for audit trail)
4. Social posts/comments are soft-deleted (tombstoned)

### Non-Payment

1. Committer misses challenge, ledger record created (balance owed)
2. Loser doesn't pay → balance stays negative indefinitely
3. App never forces payment (can't—Splitwise model)
4. Social pressure is the enforcement mechanism

### Group Pot-Split Rounding

1. $100 ÷ 3 winners = $33.333...
2. First winner gets the extra cent: $33.34, others get $33.33
3. Total: $33.34 + $33.33 + $33.33 = $100.00 exactly

### Schema Extraction (Future)

If any app outgrows the shared Postgres:
1. Cross-schema FKs to `public.user` break (replace with JWT validation + app-level consistency)
2. Cross-schema JOINs break (replace with API calls)
3. Transactions across schemas break (replace with saga patterns)
4. This is real work, not a rename—but the schema boundary makes the cut line clear

## Open Questions

1. **Domain**: resolved — `betcha.so`.

2. **PlanetScale vs current provider**: resolved — PlanetScale Postgres with EU region, confirmed.

3. **theark.so encrypted messaging**: Defer to V2. Requires E2E encryption, key exchange, real-time transport—separate spec.

4. **Notification delivery**: Push notifications (FCM/APNs), email, or in-app only? Affects infrastructure.

5. **Drizzle `push` vs `generate` + `migrate`**: Use `generate` + `migrate` for safety — `push` can have unexpected behavior with multi-file schemas. The specific `pgSchema` bugs (#4969, #5609) are no longer relevant since all tables use `pgTable()`, but `generate` + `migrate` remains the preferred workflow.

## Success Criteria

- [ ] `challenge`, `participant`, `ledger`, `follow` tables exist in `public` schema with FKs to `user`
- [ ] Challenge lifecycle works: draft → pending → active → cancelled
- [ ] Deadline auto-converts pending participants to missed with ledger records
- [ ] Anyone in a challenge can flip participant statuses; each flip creates a compensating ledger record
- [ ] Running balance correct: SUM(ledger.amount) grouped by (from, to) pair
- [ ] `ledger.actorUserId` preserves who triggered each logged change
- [ ] Same flow works for 1v1 and group challenges
- [ ] JOIN works (e.g., follow + challenge for "friends with active challenges")
- [ ] Both apps authenticate via existing Better Auth
- [ ] Drizzle migrations generate and apply correctly with multi-file schema config
- [ ] No regressions to existing public schema tables (auth, OAuth provider, platform)
## References

- `apps/api/src/db/schema.ts` — Current Drizzle schema (public, all `pgTable()`)
- `apps/api/src/auth/create-auth.ts` — Better Auth config with OAuth provider already running
- `apps/api/drizzle.config.ts` — Current Drizzle config (single schema file → glob)
- `apps/api/src/app.ts` — Hono app + Drizzle instance creation via Hyperdrive
- `apps/fuji/` — Reference SvelteKit app skeleton
- `apps/honeycrisp/` — Reference SvelteKit app skeleton
- [Drizzle `pgSchema` docs](https://orm.drizzle.team/docs/schemas) — Multi-schema API
- [Drizzle issue #5274](https://github.com/drizzle-team/drizzle-orm/issues/5274) — `CREATE SCHEMA` without `IF NOT EXISTS`
- [Drizzle issue #4969](https://github.com/drizzle-team/drizzle-orm/issues/4969) — Sequence alterations in non-default schemas
- [PlanetScale Postgres](https://planetscale.com/metal) — Metal NVMe offering, Cloudflare partnership
- [Better Auth OAuth Provider docs](https://better-auth.com/docs/plugins/oauth-provider) — OAuth 2.1 provider plugin

## Review — Phase 0 + Phase 1

**Completed**: 2026-04-17

### Summary

Implemented the database infrastructure (Phase 0) and Betcha API layer (Phase 1) for server-authoritative apps. Four tables created across two schema files (`betcha-schema.ts` and `shared-schema.ts`), all in the public schema using standard `pgTable()`. A comprehensive Hono route module handles challenge CRUD, lifecycle state machine, participant status changes with transactional ledger records, balance queries, payment recording, and follow/friend management.

### Deviations from Original Spec

- **Dropped `pgSchema()` in favor of `pgTable()` in public schema.** Separate Postgres schemas added Drizzle tooling friction (bugs #5274, #4969, #5609) without benefit for first-party apps. File-based organization provides sufficient namespacing.
- **Added `follow` table to Phase 1.** Originally planned for Phase 6, but friend selection is essential for the core challenge creation UX.
- **Added `shared-schema.ts`** as a new file for cross-app tables (follow). The original spec had no shared schema concept.
- **No table name prefixes.** Names like `challenge`, `participant`, `ledger`, `follow` are naturally unambiguous.
- **Deadline cron handler deferred.** Requires `wrangler.jsonc` changes — will be a separate task.
- **Ledger recipient logic uses simple fallback.** Currently pays the challenge creator; group pot-split math is Phase 3.

### Follow-up Work

- Deadline auto-expiry cron handler (requires wrangler.jsonc scheduled trigger config)
- Betcha frontend (Phase 2) — must track the wire-format rename (`challenge` → `wager`, `participant` → `witness`, `challengeId` → `wagerId`, and `WagerError` result-shape responses for non-2xx)
- The Ark schema + routes (Phase 4)

## Review — Betcha Lifecycle Simplification

**Completed**: 2026-04-19 (design locked; implementation pending)

### Summary

Collapse the wager lifecycle from two state machines (`status` × `outcome`, 4 + 3 states) into a **single derivable state** driven by three stored fields (`outcome`, `cancelledAt`, `deadline`). Witnesses become first-class by virtue of being added — no acceptance step — and must be **mutual follows** (friends) of the committer. Three endpoints (`/submit`, `/accept`, `/activate`) are deleted. A wager is live the instant it is created.

This is a behavioral simplification driven by one observation: the ceremony we built (draft → submit → witness accepts → committer activates) exists to solve consent problems we already solve upstream if "witnesses must be friends" is a hard invariant. Once two users are mutual follows, they have already consented to be on the hook for each other's commitments.

### Design Decisions

| Question | Answer | Rationale |
|---|---|---|
| Can any user be added as a witness? | **No — must be a mutual follow (friend) of the committer** at create time. | Consent happens once at the friendship layer, not per-wager. Matches Venmo/Strava social model. |
| Does a witness accept individual wagers? | **No.** Being added IS being a witness. | Friendship = standing consent to observe commitments. Friction-free by default. |
| Is there a draft / sent / activated phase? | **No.** `POST /wagers` creates a live wager. | The draft/sent/activate ceremony only made sense when acceptance existed. |
| Who can flip outcome to `done`? | Committer OR any witness. | Unchanged from current: symmetric authority. |
| Who can flip outcome to `missed`? | Committer OR any witness. | Unchanged: symmetric authority, trust the relationship. |
| What happens at the deadline? | **Lazy.** UI shows "awaiting verdict" until someone flips. No cron. | Zero ops cost. Defer auto-miss worker until the product needs it. |
| Can a committer cancel? | Yes, before any outcome is set. Writes `cancelledAt` + `cancelledBy`. | Replaces "cancel" on status machine. |
| Can a witness be removed after create? | Out of scope for v1. If wrong witnesses were added, cancel and recreate. | Avoids an entire "witness removal writes compensating ledger deltas" subsystem. |

### Derived State (not stored)

One column (`outcome`) plus two timestamps replace the four-value `status` enum entirely:

| Condition | Derived state |
|---|---|
| `cancelledAt IS NOT NULL` | `cancelled` |
| `outcome = 'missed'` | `missed` |
| `outcome = 'done'` | `done` |
| `outcome IS NULL AND deadline < now()` | `awaiting_verdict` |
| otherwise | `live` |

### Schema Changes

**`wager` table:**

```diff
  export const wager = pgTable('wager', {
    id, committerId, title, description, amount, currency, deadline,
-   status: text('status', { enum: wagerStatuses }).notNull().default('draft'),
-   outcome: text('outcome', { enum: wagerOutcomes }).notNull().default('pending'),
+   // outcome is nullable — NULL means "no verdict yet" (replaces 'pending' literal).
+   outcome: text('outcome', { enum: ['done', 'missed'] }),
    outcomeAt, outcomeActorId,
+   cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
+   cancelledBy: text('cancelled_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt, updatedAt,
  });
```

Drop `wagerStatuses` tuple + CHECK entirely. `wagerOutcomes` loses `'pending'`:

```diff
- export const wagerStatuses = ['draft', 'sent', 'live', 'cancelled'] as const;
- export const wagerOutcomes = ['pending', 'done', 'missed'] as const;
+ export const wagerOutcomes = ['done', 'missed'] as const;  // NULL = pending
```

**`witness` table:**

```diff
  export const witness = pgTable('witness', {
    id, wagerId, userId,
-   invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
-   acceptedAt: timestamp('accepted_at', { withTimezone: true }),
+   addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
    joinedAt, updatedAt,
  });
```

`acceptedAt` disappears. `invitedBy` → `addedBy` (still useful audit — who put this person on the hook).

**`ledger`:** unchanged. Pot-split math already iterates witnesses ordered by `joinedAt`; dropping `acceptedAt` just means the filter `WHERE acceptedAt IS NOT NULL` goes away. Every witness counts.

### Endpoint Changes

| Endpoint | Change |
|---|---|
| `POST /wagers` | Wager is created with status=`live` implicitly. Validates every `witnessUserIds[i]` is a mutual follow of committer at this instant — reject the whole request if any witness isn't a friend. |
| `POST /wagers/:id/submit` | **Deleted.** |
| `POST /wagers/:id/accept` | **Deleted.** |
| `POST /wagers/:id/activate` | **Deleted.** |
| `POST /wagers/:id/outcome` | Unchanged logic. Drops the `status === 'live'` guard (replaced by `cancelledAt IS NULL`). Drops the `WHERE acceptedAt IS NOT NULL` filter when loading witnesses. |
| `POST /wagers/:id/cancel` | Writes `cancelledAt = now()`, `cancelledBy = userId`. Only allowed when `outcome IS NULL`. Committer only. |
| `GET /wagers/:id` | Returns derived state on the wire (see table above) so clients don't duplicate derivation logic. |

### Friendship Validation at Create

Pseudocode inside `POST /wagers`:

```typescript
// Both-directions-exist = mutual follow = friend
const friendIds = await db.select({ id: follow.followingId })
  .from(follow)
  .innerJoin(
    alias(follow, 'f2'),
    and(
      eq(follow.followingId, f2.followerId),
      eq(follow.followerId, f2.followingId),
    ),
  )
  .where(eq(follow.followerId, committerId));

const friendSet = new Set(friendIds.map((r) => r.id));
const nonFriends = witnessUserIds.filter((id) => !friendSet.has(id));
if (nonFriends.length > 0) return WagerError.WitnessesMustBeFriends({ userIds: nonFriends });
```

New error variant: `WagerError.WitnessesMustBeFriends` → 400.

### Edge Cases

- **Committer unfriends a witness mid-wager.** Wager is unaffected — friendship is only checked at create time. Rationale: the witness consented by being friends *at the moment the commitment was made*. Retroactively invalidating live commitments would be a UX disaster.
- **Witness blocks committer mid-wager.** Same — out of scope for v1. Add a `hiddenFromFeed` flag on `witness` in Phase 2 if real users complain.
- **Auto-miss.** Lazy only. The `/wagers/:id/outcome` endpoint is the sole writer; cron worker is not implemented. UI displays `awaiting_verdict` past deadline.
- **Cancel after outcome set.** Rejected (`InvalidStatus`). Use the outcome flip to reverse effects, then cancel if needed — keeps ledger semantics clean (cancel is never reconciled against ledger rows).

### What Doesn't Change

- Ledger is still append-only with delta reconciliation on every outcome flip.
- Pot-split arithmetic, `FOR UPDATE` locking, integer-cent math, bigint aggregation — all identical.
- Payment endpoint, balance query, currency semantics — identical.

### Migration Notes

On the running DB (if any wagers exist):

1. Drop `wager.status` column + CHECK.
2. Alter `wager.outcome` to nullable; migrate rows where `outcome='pending'` → NULL.
3. Re-create CHECK on outcome: `outcome IN ('done', 'missed')` (or leave unconstrained via enum list).
4. Add `wager.cancelledAt`, `wager.cancelledBy`.
5. Drop `witness.acceptedAt`.
6. Rename `witness.invitedBy` → `witness.addedBy`.

If the DB is still pre-production, squash into the fresh migration alongside the prior redesign rather than layering a new one.

### Follow-up Work

- Implement the endpoint deletions + handler updates in `apps/api/src/routes/betcha.ts`.
- Update frontend to: remove the accept/activate screens, add friend-picker to create flow, render derived state strings.
- Add `WitnessesMustBeFriends` error variant + HTTP status mapping.
- Document the `friend = mutual follow` invariant somewhere user-facing so the permission denial is explainable.

---

## Review — Betcha Schema Redesign

**Completed**: 2026-04-19

### Summary

Redesigned the Betcha schema to correctly model the product as a **unidirectional accountability wager** rather than a generic group challenge. Only the committer stakes money; witnesses stake nothing and collect on miss. The original `challenge` + `participant` names implied symmetric stakeholding that doesn't exist.

Also collapsed drizzle migrations 0001–0006 (incremental churn on the old schema) into a single fresh migration on top of the applied baseline 0000. Nothing downstream of 0000 had been applied.

### Changes

- Renamed `challenge` → `wager`, `participant` → `witness`
- Dropped `challenge.createdBy` (nullable) in favor of `wager.committerId` NOT NULL with cascade — committer is a structural role, not an audit field
- Added `wager.outcome` + `outcomeAt` + `outcomeActorId` as a second state machine orthogonal to `status`
- Dropped `ledger.type` column; kind is derivable from `wagerId IS NULL` (payment) vs NOT NULL (outcome split)
- Tightened `ledger.fromUserId`/`toUserId` to NOT NULL + `ON DELETE RESTRICT` — ledger rows are immutable financial records; hard-deleting a user with outstanding history would corrupt balance sums
- Collapsed the N+1 per-witness SUM loop in the outcome flip into one grouped query (shrinks `FOR UPDATE` lock hold time)
- Switched ledger aggregations to `::bigint` casts parsed via `Number(string)` (int4 would overflow at 2^31 cents aggregated)
- Replaced ad-hoc `{ message }` error payloads + `{ error: 'literal' as const }` discriminated unions with a single `WagerError` namespace via wellcrafted `defineErrors`, matching `AssetError` in `routes/assets.ts`
- Rewrote `/balances` to query each direction separately so both can use their single-column index; `OR(from=me, to=me) GROUP BY CASE` couldn't use either

### Deviations from Original Spec

- **Group pot-split is now live**, not deferred to Phase 3. The outcome-flip handler splits evenly across accepted witnesses, with rounding-remainder pennies going to the earliest-joining witness first. The "Phase 3" label only applies to group-specific UX.
- **Deadline auto-expiry is still deferred** — requires wrangler.jsonc scheduled trigger config.
- **Status naming drift**: original spec had `draft → pending → active → cancelled`; redesigned schema uses `draft → sent → live → cancelled` to be unambiguous about "sent to witnesses" vs. "live and accepting outcome flips."
