# CI/CD Workflows

All workflows live flat in `.github/workflows/` (GitHub Actions requirement). We use **period-delimited prefixes** so they group naturally when sorted alphabetically. Periods are structural delimiters (category from name); hyphens are word separators within a segment.

## Naming Convention

| Prefix | Purpose | Scope |
|---|---|---|
| `release.{app}` | Tag-triggered desktop builds + GitHub Release | Per Tauri app (expensive 3-platform matrix) |
| `pr-preview.{app}` | PR preview desktop builds | Per Tauri app (expensive 3-platform matrix) |
| `deploy.{target}` | Web app deployment | Deployed web targets |
| `ci.{name}` | Code quality checks | Whole repo |
| `auto.{name}` | Automated repo maintenance | Whole repo |
| `meta.{name}` | Repo housekeeping | Whole repo |

Tauri desktop apps get **separate per-app workflows** because builds run a 3-platform matrix (macOS Apple Silicon, Ubuntu, Windows) taking 20+ minutes. A PR touching only Whispering shouldn't trigger an Epicenter build.

Web apps (Cloudflare Workers) deploy **together in one workflow** because deploys are fast (~2 min on a single runner) and share the same runtime setup. Each worker's build lives in its own `wrangler.jsonc` `build.command`, which Wrangler runs for both `deploy` and `versions upload`, so production, previews, and local `wrangler deploy` build through one definition. Repo-wide lint, typecheck, and unrelated package builds belong to CI.

## Workflows

### Desktop Releases

| File | Trigger | What it does |
|---|---|---|
| `release.whispering.yml` | `v*` tags, manual | Builds Whispering for 3 platforms, publishes to GitHub Releases as draft. Includes code signing, notarization, and release notes from `docs/release-notes/`. |
| `pr-preview.whispering.yml` | Pull requests | Builds Whispering for 3 platforms, uploads as PR artifacts. Cancels previous builds via concurrency groups. |

#### macOS release invariant: the `.app` and the `.dmg` must both be notarized

`tauri-action` notarizes and staples the `.app`, then builds the `.dmg` around it and only signs that `.dmg`. So the file users download (the `.dmg`) is "Unnotarized Developer ID" and fails Gatekeeper's open check even though the app inside it passes. The `notarize-whispering-dmg` action closes that gap: after `tauri-action` uploads, it notarizes, staples, and verifies the `.dmg`, then replaces the draft's asset with the stapled copy. It addresses the draft by the `releaseId` and `releaseUploadUrl` that `tauri-action` outputs, not by tag, because `gh release upload <tag>` resolves tags through an endpoint that 404s for drafts. Because the release is a draft, no one can download the unstapled file first, and because `latest.json` references the `.app.tar.gz` updater bundle rather than the `.dmg`, replacing the `.dmg` leaves the updater signature untouched.

Both of these must pass on a release `.dmg` (run against the exact uploaded file, not a local rebuild):

```bash
xcrun stapler validate -v Whispering_*.dmg
spctl -a -vvv -t open --context context:primary-signature Whispering_*.dmg   # accepted, Notarized Developer ID
```

And the app inside it must still pass once the `.dmg` is mounted:

```bash
spctl -a -vvv -t execute /Volumes/Whispering/Whispering.app                  # accepted, Notarized Developer ID
```

### Web Deployment (Cloudflare Workers)

| File | Trigger | What it does |
|---|---|---|
| `deploy.cloudflare.yml` | Push to `main`, manual | Deploys Whispering, Landing, and API to Cloudflare Workers. Each `wrangler deploy` runs that worker's `build.command` first, so a deploy can never ship stale assets. Posts Discord notification. |
| `deploy.cloudflare-preview.yml` | Pull requests touching `apps/whispering/**`, `apps/landing/**`, `packages/**` | Uploads preview versions via `wrangler versions upload --preview-alias`. Posts PR comment with preview URLs. No cleanup needed (aliases auto-expire at 1000). |

### CI

| File | Trigger | What it does |
|---|---|---|
| `ci.format.yml` | Push to `main`, pull requests | Runs `bun run lint:check` and `bun run typecheck`. Cancels older runs for the same branch or PR. |
| `ci.autofix.yml` | Push to `main`, pull requests | Runs `bun run format` and commits fixes back via autofix-ci. Cancels older runs for the same branch or PR. |

### Automation

| File | Trigger | What it does |
|---|---|---|
| `auto.label-issues.yml` | Issues opened/edited | Uses Claude to auto-label issues by type, priority, platform, and area. |
| `auto.release.yml` | PR merged to `main` | Bumps version, collects `## Changelog` entries from merged PRs, commits release, tags, creates GitHub Release with grouped changelog. |
| npm release (manual) | Manual | `bun run release` (`changeset version` + `scripts/publish-packages.ts`). See "Package Releases (npm)" below. `@changesets/action` will automate this later. |

## Package Releases (npm)

We use [changesets](https://github.com/changesets/changesets) to version and publish npm packages.

### Public and private packages

| Package | npm name | Published |
|---|---|---|
| `packages/workspace` | `@epicenter/workspace` | yes |
| `packages/cli` | `@epicenter/cli` | yes |
| `packages/sync` | `@epicenter/sync` | yes |
| `packages/filesystem` | `@epicenter/filesystem` | yes |
| `packages/skills` | `@epicenter/skills` | yes |
| `packages/ui` | `@epicenter/ui` | yes |
| `packages/field` | `@epicenter/field` | yes |
| `packages/identity` | `@epicenter/identity` | yes |
| `packages/svelte-utils` | `@epicenter/svelte` | yes (see note) |
| `packages/ai` | `@epicenter/ai` | no (private) |
| `packages/constants` | `@epicenter/constants` | no (private) |
| `packages/vault` | `@epicenter/vault` | no (private) |

### Fixed version group

The framework closure shares one version number, configured via the `fixed` array in `.changeset/config.json`: `workspace`, `cli`, `sync`, `filesystem`, `skills`, `ui`, `svelte`, `field`, and `identity`. When any one of them changes, all of them bump together. This keeps the ecosystem coherent: if you install `@epicenter/workspace@0.3.0`, you know `@epicenter/cli@0.3.0` is the matching release.

Note: `@epicenter/svelte` is in the `fixed` array but currently marked `private` in its `package.json`, so changesets versions it in lockstep without publishing it. Un-private it to publish, or drop it from the array if it should stay internal.

### Day-to-day: adding a changeset

After making changes to any package, record what changed before committing:

```bash
bunx changeset
```

The CLI will ask which packages changed, what semver bump applies (patch/minor/major), and for a short summary. It writes a `.changeset/*.md` file. Commit that file alongside your code changes.

Don't skip this step. Without a changeset, the change won't appear in the CHANGELOG and won't trigger a version bump.

### Cutting a release

When you're ready to publish accumulated changesets:

1. Verify the packed manifests first (no upload):
   ```bash
   bun run release:dry-run
   ```
   This packs every public package and fails if any tarball still carries an
   unresolved `catalog:` or `workspace:` string.

2. Cut the release (bump versions and changelogs, then pack, upload, and tag):
   ```bash
   bun run release
   ```
   `release` runs `changeset version` followed by `scripts/publish-packages.ts`,
   which publishes each not-yet-published version with `bun publish --access
   public` and creates a local `name@version` tag per package.

3. Commit the version bump and push everything:
   ```bash
   git add . && git commit -m "chore: release vX.Y.Z"
   git push && git push --tags
   ```

### Why bun publish, not changeset publish

`bun publish` resolves bun-only dependency protocols (`catalog:`,
`workspace:*`) to concrete versions at pack time. The npm-based `changeset
publish` does not, so it shipped `@epicenter/*@0.1.0` tarballs whose published
deps still read `catalog:` / `workspace:*`, which 404 on a clean install. We
keep `changeset version` (it owns version math and changelogs) but replaced
`changeset publish` with `scripts/publish-packages.ts`.

### What not to do

- Don't manually edit `version` fields in `package.json`. Changesets owns those.
- Don't run `changeset publish` (it reintroduces the unresolved-protocol bug).
  Use `bun run release`, which publishes through `bun publish`.
- Don't run `bun publish` by hand in a package dir without running the dry-run
  gate first.

### Meta

| File | Trigger | What it does |
|---|---|---|
| `meta.sponsors-readme.yml` | Daily schedule, manual | Updates README sponsors section. |
| `meta.sync-releases.yml` | Release published/edited, manual | Mirrors releases from EpicenterHQ/epicenter to braden-w/whispering (downstream). |
| `meta.update-readme-version.yml` | Release published, manual | Updates download link versions in Whispering README via sed. |

### Uncategorized

| File | Trigger | What it does |
|---|---|---|
| `claude.yml` | `@claude` mentions in issues/PRs | Runs Claude Code agent to respond. One-off, no prefix needed. |

## Secrets Reference

| Secret | Used by | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy.cloudflare`, `deploy.cloudflare-preview` | Cloudflare API token. Named `github-actions-cloudflare-deploy` in the CF dashboard (Account API Tokens). Use the "Edit Cloudflare Workers" template. |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.cloudflare`, `deploy.cloudflare-preview` | Cloudflare account ID |
| `DISCORD_WEBHOOK_URL` | `deploy.cloudflare` | Discord webhook for deployment notifications (optional) |
| `TAURI_SIGNING_PRIVATE_KEY` | `release.whispering`, `pr-preview.whispering` | Tauri update signing key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `release.whispering`, `pr-preview.whispering` | Tauri signing key password |
| `APPLE_CERTIFICATE` | `release.whispering`, `pr-preview.whispering` | macOS code signing certificate (base64) |
| `APPLE_CERTIFICATE_PASSWORD` | `release.whispering`, `pr-preview.whispering` | macOS certificate password |
| `APPLE_SIGNING_IDENTITY` | `release.whispering`, `pr-preview.whispering` | macOS signing identity |
| `APPLE_ID` | `release.whispering`, `pr-preview.whispering` | Apple ID for notarization |
| `APPLE_PASSWORD` | `release.whispering`, `pr-preview.whispering` | Apple app-specific password |
| `APPLE_TEAM_ID` | `release.whispering`, `pr-preview.whispering` | Apple Developer team ID |
| `GH_ACTIONS_PAT` | `auto.release`, `meta.sync-releases`, `meta.sponsors-readme`, `meta.update-readme-version` | PAT with repo + read:org scope for pushing commits/tags and creating releases |
| `ANTHROPIC_API_KEY` | `auto.label-issues`, `claude` | Anthropic API key for Claude |

## Rollback

**Web apps**: Revert the commit on `main` and push, or for immediate rollback: `bunx wrangler rollback --name <worker-name>`.

**Desktop releases**: Delete the draft release and re-tag from an earlier commit.
