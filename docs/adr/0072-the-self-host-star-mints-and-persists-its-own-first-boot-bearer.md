# 0072. The self-host star mints and persists its own first-boot bearer

- **Status:** Accepted
- **Date:** 2026-06-26
- **Relates:** [ADR-0070](0070-self-host-adds-no-new-ownership-or-auth-mode.md) (self-host's credential source is the first-boot bearer; this pins where that bearer comes from and how the box knows to use it), [ADR-0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) (OAuth is hosted-only; this is the server side of the token a custom instance requires), [ADR-0062](0062-local-books-stores-oauth-tokens-in-a-single-0600-file.md) (the single-`0600`-file at-rest standard this reuses), [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) (the resolver is the injected `ResolveUser`; mint and persist are Bun-only)

## Context

ADR-0070 decided self-host's credential is a single-user bearer printed at first boot, not a Google OAuth app registered against your own box, and left the concrete default "to the spec." A solo homelab must boot with zero configuration and still be secure: it has no Google app, so it cannot run OAuth, yet it must authenticate its one owner. Two questions force a decision: where does that bearer come from and how is it stored, and how does one self-host deployable know it is a solo box (a token) versus a shared wiki (OAuth + an allowlist) without a flag that can lie?

## Decision

The box mints and persists its own bearer at first boot. The resolution order is the canonical zero-config-but-secure pattern (code-server, n8n, Jupyter, Vault operator init): an `INSTANCE_TOKEN` env wins verbatim; else `<DATA_DIR>/instance-token` is reused; else a fresh `randomBytes(32).base64url` is minted, written `0600`, and printed once (later boots name the file instead, so the secret is not re-leaked into the logs). The operator pastes it into the client instance setting (ADR-0071). `createInstanceTokenResolver` is the injected `ResolveUser`, a credential SOURCE feeding the one total gate exactly like the OAuth resolver, paired with `personal()` under a byte-pinned owner id.

The box recomputes solo-vs-shared from one input, with no stored mode discriminator: the set of configured OAuth providers. The SAME `configuredSocialProviders(env)` drives both what `createAuth` registers and what the selector counts, so the gate can never disagree with what accepts a sign-in. An empty set (no provider app configured) is a solo box authenticated by the bearer; a non-empty set is a shared wiki (`shared({ admit })` + OAuth). Google is therefore optional like GitHub; the hosted star, never provider-less, re-requires it at its own boot.

## Consequences

- **A homelab needs no Google app to reach its own data.** First boot is zero-config and still secure, removing the exact cloud dependency ADR-0070 named a wart. The `INSTANCE_TOKEN` override also serves the 12-factor / container-secret crowd.
- **At rest is plaintext `0600`,** the ADR-0062 house standard (the `~/.aws/credentials` tradeoff). Hashing the token at rest is a deferred hardening, not done here.
- **The selector is recompute-from-inputs and provider-agnostic.** A GitHub-only wiki, a Google-only wiki, and a multi-provider wiki all fall out of the same rule; ADR-0066 and ADR-0071 already reject stored mode discriminators, and this stays consistent. The boot banner prints the computed mode (and the minted token once), so a silent re-mint from a non-persisted `DATA_DIR` (n8n's documented footgun) is visible rather than mysterious.
- **Bun-only.** Mint and persist need `node:crypto`, disk, and a module-scope boot hook the Worker entry has none of, so the off-Cloudflare Bun deployable carries this. The Worker self-host stays Config D (OAuth + `shared`) and is untouched. The constant-time token compare lives in the portable resolver (Web Crypto, no `node:`).
- **The owner id is byte-pinned durable data,** like `SHARED_OWNER_ID`: `personal()` keys the R2/DO/IDB partition prefix by it, so it is chosen once and never changed.
- **What this forecloses:** layering the bearer as an always-on admin key over OAuth in shared mode (auth stays one total gate, bearer XOR OAuth), and the reverse-proxy-header / email-password credential sources (ADR-0070's later escape hatches), which remain out of scope.

## Considered alternatives

- **A stored mode enum (`solo | wiki`).** Rejected: a third source of truth that can disagree with the creds and the partition (a `wiki` box with no providers, a `solo` box with Google creds), which ADR-0066 and ADR-0071 already refuse. The one thing it buys, failing loud on a wiki with no providers, the boot banner gives without the tag.
- **Select by Google-creds presence, or by `ALLOWED_MEMBER_EMAILS` presence.** Rejected: Google-presence bakes in "Google is THE provider" and misclassifies a GitHub-only wiki as solo; allowlist-presence flips a wiki that clears its allowlist into a solo box that re-mints a token. The configured-provider set is the honest, provider-agnostic signal, and it is the same set auth registers.
- **An operator-minted token (the operator generates and supplies it).** Rejected as the default: zero-config first boot should not require the operator to mint anything. The `INSTANCE_TOKEN` env override already covers operators who want to inject their own secret.
