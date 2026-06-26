# Epicenter Self-Hosted Shared Wiki (Reference)

Reference Cloudflare Worker for self-hosting Epicenter as a shared wiki. **Not operated by Epicenter.** Copy this folder, fill in the deployment-owned secrets and bindings, deploy, support yourself.

## What this is

`apps/self-host` is a ~30-line composition of `@epicenter/server` with the `shared({ admit })` ownership rule. Every user your `admit` predicate accepts shares one workspace partition (`SHARED_OWNER_ID = "shared"`). The shipped default admits a fixed email list, but `admit` is a plain callback you own: see [Admission](#admission-who-gets-in).

It ships as two runtimes off the same library: this Cloudflare Worker (shared wiki only), and an off-Cloudflare Bun entry (`server.ts`) that runs a solo single-owner box or the shared wiki, picked by `EPICENTER_MODE`. If you want a homelab box with no Google OAuth app, jump to [Running off Cloudflare](#running-off-cloudflare-the-bun-box).

## What this isn't

This is not Epicenter Cloud. There are:

- No Autumn billing routes
- No dashboard SPA
- No SLA, support contracts, or paid hosting from Epicenter

Community-supported. Issues filed against this folder are accepted as community contributions.

## Trust boundary

The deployer operates the infrastructure. Epicenter never holds or sees the data stored here, so self-hosting is functionally zero-knowledge against Epicenter.

## What to fill in

```txt
wrangler.jsonc
  ALLOWED_MEMBER_EMAILS    comma-separated allowed emails
  GOOGLE_CLIENT_ID         your Google OAuth client id (public)
  HYPERDRIVE.id            your Hyperdrive id

wrangler secret put ...
  BETTER_AUTH_SECRET       openssl rand -base64 32
  GOOGLE_CLIENT_SECRET     your Google OAuth client secret
  OPENAI_API_KEY           optional house key; omit and members BYOK
  GEMINI_API_KEY           optional house key; omit and members BYOK
```

## Deploy

```bash
bun run --cwd apps/self-host typecheck
bun run --cwd apps/self-host deploy
```

`worker-configuration.d.ts` is hand-written: it inherits the library's
binding contract (`ServerBindings`) and declares only deployment-owned
vars, so there is no typegen step. If you add bindings of your own, declare
them there (or regenerate with `bun run typegen` and re-add the `extends`
clause).

## Running off Cloudflare: the Bun box

The same `@epicenter/server` runs as a single Bun process against your own Postgres (`bun server.ts`, or a `bun build --compile` binary), no Cloudflare account required. This is the homelab "own your data on your own machine" path. One launch choice picks its shape.

`EPICENTER_MODE` (`solo` | `shared`, default `solo`) is an explicit declaration, never derived from which secrets you set. The mode IS the data partition, so picking it from mutable credentials would let a secret change silently re-partition a populated box. Instead the configured OAuth providers must agree with the declared mode, checked loudly at boot: a half-configured provider pair, `shared` with no provider, or `solo` carrying OAuth creds or an allowlist each fail boot with a message naming the fix.

### Solo (the default): one owner, no OAuth app

A box for a single owner. It needs only a database and an auth secret:

```bash
DATABASE_URL=postgres://user:pass@host:5432/epicenter \
BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
DATA_DIR=/var/lib/epicenter \
bun server.ts
```

On first boot it mints a single-user bearer, writes it `0600` to `<DATA_DIR>/instance-token`, and names the file (it never echoes the secret to the logs, which are a worse at-rest location than the `0600` file):

```txt
solo mode. Minted a new instance token, saved 0600 to /var/lib/epicenter/instance-token.
Read it once and paste it into the client instance setting:
  cat /var/lib/epicenter/instance-token
```

`cat` it once, paste it into the client's instance setting (`{ baseURL, token }`), and every request authenticates as the box's single owner under `personal()`. Later boots reuse the file. Persist `DATA_DIR`: it holds both the token and the room data, so an ephemeral one re-mints on every boot and invalidates the pasted credential. To inject your own secret instead (12-factor / container secrets), set `INSTANCE_TOKEN` and the box never writes a file.

There is no break-glass here in the other direction either: a shared wiki has no admin bearer over OAuth, so an operator locked out by a bad `ALLOWED_MEMBER_EMAILS` recovers by fixing the allowlist and redeploying, not by a backdoor token.

### Shared: a wiki off Cloudflare

The Bun box can also run the shared wiki, the same OAuth + allowlist as the Worker:

```bash
EPICENTER_MODE=shared \
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
ALLOWED_MEMBER_EMAILS=ada@example.com,grace@example.com \
DATABASE_URL=... BETTER_AUTH_SECRET=... \
bun server.ts
```

`ALLOWED_MEMBER_EMAILS` is the shipped `admit` (see [Admission](#admission-who-gets-in)); an empty allowlist admits nobody (fail closed). At least one OAuth provider is required. Solo-only knobs (`INSTANCE_TOKEN`, a leftover `<DATA_DIR>/instance-token`) are unused here and warn at boot.

## Composition

The entire app is in `worker/index.ts`. Top to bottom:

```ts
const ownership = shared({
  admit: (c) => allowed.has(c.var.user.email),
});

createServerApp()
  .route('/', authApp)                                 // OAuth + sign-in pages
  // mountSessionApp(app, { ownership })              // GET /api/session
  // mountRoomsApp(app, { ownership })                // /api/owners/:ownerId/rooms/*
  // mountAiApp(app, { auth: requireBearerUser, ownership }) // POST /api/ai/chat
```

Deliberately absent: `mountBillingApi`, `chargeAiCreditsWithAutumn`, any `apps/api/ui` static-asset fallback. The composition shape is the contract.

## Admission: who gets in

`admit` is the only thing standing between a signed-in Google account and your shared workspace. It is a plain callback the library calls on every request:

```ts
shared({ admit: (c) => boolean | Promise<boolean> });
```

Return `true` and the user is partitioned into the shared workspace; return `false` and they get `403 NotAdmitted` before any data is read. It runs per request, not once at sign-up, so dropping someone takes effect on their next request rather than whenever their session expires.

The library owns the mechanism (run the predicate, reject, partition). You own the policy. That inversion is the whole design: every "how do I manage members" question below is a different `admit` body, and none of them touch the library.

A fixed list in code. The roster lives in this file, in git, reviewable in a PR. Changing it is a `wrangler deploy`.

```ts
const MEMBERS = new Set(['ada@example.com', 'grace@example.com']);
shared({ admit: (c) => MEMBERS.has(c.var.user.email) });
```

An env list, which is what ships. Same idea, but the roster is `ALLOWED_MEMBER_EMAILS` so you change it without editing code. Keep it a `wrangler.jsonc` var (a redeploy, roster stays in git) or move it to a secret (`wrangler secret put`, no code redeploy, roster leaves git).

```ts
shared({
  admit: (c) => {
    const allowed = new Set(
      ((c.env as Cloudflare.Env).ALLOWED_MEMBER_EMAILS ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean),
    );
    return allowed.has(c.var.user.email);
  },
});
```

Delegate to your identity provider. If your members share a domain, do not keep a roster at all: let Google Workspace be the source of truth. Onboarding and offboarding happen in your Google admin console, and a disabled account can't sign in, so it can't be admitted.

```ts
shared({ admit: (c) => c.var.user.email.endsWith('@yourteam.com') });
```

A Postgres lookup. `admit` is async and `c.var.db` is already connected, so the roster can be a table you mutate at runtime: one `INSERT` adds a member, no deploy. You define the table and how you write to it (a small admin route, a CLI, or psql); `admit` only reads it.

```ts
shared({
  admit: async (c) => {
    // `members` is a table you define and write to yourself.
    const [row] = await c.var.db
      .select().from(members)
      .where(eq(members.email, c.var.user.email)).limit(1);
    return row != null;
  },
});
```

The radical option: don't admit in the app at all. The simplest predicate is `admit: () => true`, everyone who signs in is in. That is only safe if something gates sign-in for you, so push membership one layer up and out of your code:

- Put Cloudflare Access in front of the Worker. Its policy (email list, SSO group, MFA) runs before the request reaches you, with a dashboard, an audit log, and no redeploy to change membership. The free tier covers small teams. It is Cloudflare-specific, so it fits this Worker reference, not the portable Bun path.
- Or restrict the Google OAuth app itself (internal to your Workspace, or a fixed test-user list). Then "can sign in" already means "is a member."

```ts
shared({ admit: () => true }); // membership enforced by Cloudflare Access or the OAuth app
```

| `admit` body | roster lives in | adding a member |
| --- | --- | --- |
| fixed `Set` | this file (git) | edit, `wrangler deploy` |
| `ALLOWED_MEMBER_EMAILS` | wrangler var (git) or secret | redeploy, or `wrangler secret put` |
| domain match | your IdP (Google Workspace) | add the user in Google |
| Postgres lookup | a table you own | one `INSERT`, no deploy |
| `() => true` + edge gate | Cloudflare Access / OAuth app | the Access or OAuth dashboard |

Pick the row that matches your churn. A two-person wiki is fine with a fixed `Set`; a company is happiest delegating to its IdP or Cloudflare Access; only a roster with real churn and no shared domain needs the Postgres table.

## See also

- `specs/20260528T145510-deployment-collapse.md` for the design rationale
- `apps/api` for the hosted personal cloud variant (with billing + dashboard)
- `packages/server` for the shared library
