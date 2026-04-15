# Create GitHub Issue: Dev/Prod DB Separation

## Task

Create a GitHub issue on EpicenterHQ/epicenter proposing dev/prod database separation for the user-facing auth database. Use `gh issue create`.

## Context

Contributor John Kim suggested having dev and prod versions of the user database, inspired by Userfront's "test mode" (https://userfront.com/docs/domains/test-mode).

Currently, Epicenter has one Better Auth database (Cloudflare D1) backing `apps/api/`. When contributors test sync, auth, or billing features locally, they hit the production auth database. This means:

- Test users pollute the production user table
- Dev sessions can interfere with real sessions
- No safe way to test auth changes without risking production data
- Contributors need to be careful about what endpoints they hit

The workspace CRDTs are already per-user and local-first, so the main concern is shared server state: auth sessions, encryption keys, sync relay rooms.

### Relevant files

- `apps/api/src/auth/create-auth.ts`—Better Auth config
- `apps/api/wrangler.jsonc`—Cloudflare Workers config with D1 bindings
- `packages/constants/src/apps.ts`—app URLs and ports

### Possible approaches

1. Separate D1 databases per environment (dev vs prod bindings in `wrangler.jsonc`)
2. Environment flag in Better Auth config that prefixes tables or uses a different DB
3. Local SQLite for dev auth (no cloud dependency for local testing)
4. Staging deployment with its own D1 + Durable Objects

## Issue Format

**Title:** `feat: add dev/prod database separation for auth`

Body should include:

- Problem statement (2–3 sentences)
- What Userfront does as inspiration
- Proposed approaches (numbered list, brief)
- Open questions (what scope? just auth DB or also sync DOs?)
- Label: `enhancement`

## MUST DO

- Run: `gh issue create --title "..." --body "..." --label "enhancement"`
- Keep the body concise—this is a proposal, not a spec
- Mention John Kim's suggestion as the origin
- Link to Userfront's test mode docs

## MUST NOT DO

- Do not implement anything
- Do not modify any files
- Do not assign the issue to anyone
- Do not create a milestone or project board entry
