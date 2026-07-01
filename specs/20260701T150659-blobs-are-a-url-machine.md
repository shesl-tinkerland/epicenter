# Blobs Are a URL Machine

**Date**: 2026-07-01
**Status**: In Progress
**Owner**: Braden
**Branch**: blob-direction
**Supersedes**: `specs/20260623T220000-content-addressed-blob-store.md` (deleted; its kernel decisions live in ADR-0088 and ADR-0089, this direction in ADR-0090)

## One Sentence

`epicenter blobs add <file|url>` trades bytes that do not fit in git for a durable, content-addressed URL, and because the sha256 rides inside that URL, the documents that cite it are the only manifest.

## Overview

Collapse the `epicenter blobs` CLI from two products in one command tree (a content-addressed store plus a half-built vault-sync layer) down to one: file in, URL out. Delete `epicenter.blobs.lock`, `pull`, and the path machinery in `add`. The server and client kernel stay exactly as built.

## Motivation

### Current State

The CLI's own header sentence admits it is two products (`packages/cli/src/commands/blobs.ts:1-9`): "archive vault files in the content-addressed cloud store and restore them, lockfile-style." The lockfile half is 40% of a sync product: there is no `push`, no `status`, `rm` deletes the cloud object but leaves the manifest entry dangling by design (`blobs.ts:175-176`), and `get`/`rm` key by hash while `add`/`pull` key by path. Meanwhile `add` carries ~80 lines of path machinery (`-C` root-walk, `--dir`, outside-root guard, write-to-disk branch, manifest upsert) that exists only to feed the lockfile.

This creates problems:

1. **Two sources of truth**: the manifest, the store listing, and the markdown that cites a blob can all disagree, and `rm` guarantees they eventually do.
2. **An unfinished promise**: "lockfile-style restore" implies `push`, `status`, and a delete that maintains the map. Finishing that is building git-lfs; not finishing it is shipping drift.
3. **The manifest records what the reference format already carries**: every blob URL contains its own sha256, so the path-to-hash map is recoverable by grepping the documents that actually use the blob.

### Desired State

```txt
you (or an agent):  epicenter blobs add talk-recording.mp4
CLI prints:         https://api.epicenter.so/api/owners/<ownerId>/blobs/<sha256>
your markdown:      [the talk](https://api.epicenter.so/api/owners/<ownerId>/blobs/<sha256>)
```

The vault stays a plain git folder. Small assets live in git and are referenced by relative path. Big assets are traded for URLs and the URL is the reference. Nothing else is recorded anywhere.

## The Core Insight: the URL carries its own receipt

The read URL is `<origin>/api/owners/<ownerId>/blobs/<sha256>`. The hash inside it makes every citation self-describing, which is what makes the manifest deletable:

```txt
Question:
  what did the lockfile buy, and what still buys it?

Model:
  reference = a URL with the content address embedded
  document  = the manifest (grep for the URL pattern)
  store     = the index (blobs ls)

Derivable without any lockfile:
  retrieve a cited file      -> blobs get <sha256>   (hash is in the URL you cited)
  audit what is referenced   -> grep vault for /blobs/[a-f0-9]{64}
  find orphans in the store  -> blobs ls minus the grep set
  migrate deployments        -> find-replace the origin prefix; the hash part never changes

Not derivable (the one real loss):
  fresh-clone bulk restore of binaries to their original disk paths
```

That last line is git-lfs's product. Refusing it is the asymmetric win.

## Asymmetric-Wins Ledger

```txt
Product sentence:
  epicenter blobs trades a file for a durable content-addressed URL.

Candidate refusal:
  the path-to-hash manifest (epicenter.blobs.lock) and everything that feeds it.

Code family it deletes:
  blobs-manifest.ts (parse/stringify/upsert/downloadName) and its test file
  the pull command and its per-file status loop
  add's -C root-walk, --dir, outside-root guard, write-to-disk branch, manifest upsert
  the epicenterRootOption dependency in blobs
  the rm-desyncs-the-manifest bug class and the manifest-vs-store drift class
  the future obligations push, status, and rm-that-maintains-the-map
  the standing question "which map is truth: markdown, lockfile, or store?"

User loss:
  a fresh clone cannot bulk-restore binaries to their original paths.
  Mitigations that survive: any cited blob is recoverable by the hash in its URL;
  blobs ls still lists everything owned.

Decision:
  Refuse it. The product sentence survives untouched; the second product disappears.
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Reference format | 2 coherence | Plain https URL with the hash embedded | Works in every renderer and agent without a resolver; a custom `blob:` scheme would need a plugin everywhere. Verified: `blobs.url()` already returns this shape (`packages/client/src/index.ts`). |
| Manifest | 2 coherence | Delete `epicenter.blobs.lock`, `blobs-manifest.ts`, `pull` | Documents are the manifest; see ledger above. |
| Server key model | 2 coherence | Stays hash-only, `owners/<ownerId>/blobs/<sha256>` | Paths are a client concern; the server never learns them. Unchanged from the kernel spec. |
| Read auth | 1 evidence | Private v1; owner URL 302s to a presigned GET behind auth | Verified in `packages/server/src/routes/blobs.ts:237`. Public serving is a separate earned tier (see Open Questions). |
| `usage` route + `client.blobs.usage()` | 3 taste | Delete until Autumn metering lands | Zero consumers (the CLI never exposed it); it is `ls` summed. Revisit when: billed storage ships. |
| `add <url>` disk writes | 2 coherence | None; download, upload, print the URL | Under the URL-machine sentence the local copy is not the product; `get -o` covers retrieval. |
| Idempotency | 1 evidence | Re-adding the same bytes returns the same URL with `duplicate: true` | Verified: dedupe HEAD in `routes/blobs.ts:160-171`. This is the agent contract: `add` is safe to repeat. |
| Encryption | settled | Blob layer stays plaintext; an encrypting consumer composes on top | Decided in the 2026-07-01 blob review memo; ciphertext-in gives ciphertext-hash-as-address with zero server change. |

## CLI Catalog

```txt
epicenter blobs add <file|url>    # hash -> ticket -> presigned PUT; prints the URL; idempotent
epicenter blobs ls                # the store is the index
epicenter blobs get <sha256|url>  # download by content address; accepts a pasted URL and extracts the hash
epicenter blobs rm  <sha256|url>  # delete from the store; breaks every citation, and the help text says so
```

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| `pull` | Restore-to-path is the manifest product; refused above. |
| `push` / `status` | Only exist to serve the manifest; die with it. |
| `usage` | Unconsumed; `ls` summed. Returns with billed storage. |
| `gc` (delete unreferenced) | Wanted eventually, but it is `ls` minus grep; earn it when a vault actually accumulates orphans. |
| `publish` / `--public` | Belongs to the public tier, which belongs to the post pipeline era (see Open Questions). |
| A markdown-snippet output mode | Agents compose their own markdown; keep the tool dumb, print the URL. |

## Division of Labor

```txt
small enough for git  -> commit it, reference by relative path (previews everywhere, git history)
too big for git       -> blobs add, reference by URL (durable, no inline preview in local editors)
publish time          -> the post pipeline resolves paths to public URLs (later; owns the public tier)
```

The middle row has an honest catch: v1 blobs are private, so a blob URL resolves for an authed browser session and for the CLI, but not in a cookie-less local editor preview. That is accepted. Big media (video, audio, archives) does not preview inline in most editors anyway, and anything you want previewing while drafting is by definition small enough for git.

## Call Sites: before and after

### `add` loses its tail

**Before** (`packages/cli/src/commands/blobs.ts:101-151`): after upload, ~50 lines compute `blobPath`, guard it against escaping the root, write bytes to disk, load and upsert the manifest, and print five fields including `path` and `manifest`.

**After**:

```ts
const { data: result, error: uploadError } = await epicenter.blobs.add(
	new Blob([new Uint8Array(bytes)], { type: contentType }),
	{ contentType },
);
if (uploadError !== null) {
	fail(uploadError.message, { code: 2 });
	return;
}
output(
	{ sha256: result.sha256, url: result.url, duplicate: result.duplicate },
	{ format: argv.format },
);
```

**Semantic shift to flag**: `add` no longer writes anything to disk and no longer takes `-C` or `--dir`. A URL source is archived, not downloaded.

### `pull` is deleted whole

**Before** (`blobs.ts:251-318`): manifest iteration, per-file download, local re-hash, `present`/`restored`/`failed`/`corrupt` report.

**After**: gone. The re-hash-after-download integrity check is worth keeping; it moves into `get` (hash the downloaded bytes against the requested address before writing the file).

## Implementation Plan

### Phase 0: settle the decision

- [x] **0.1** Confirm the direction (confirmed 2026-07-01).
- [x] **0.2** Recorded as three ADRs: [ADR-0088](../docs/adr/0088-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md) (kernel, Accepted), [ADR-0089](../docs/adr/0089-the-blob-layer-stays-plaintext-confidentiality-belongs-to-the-encrypting-consumer.md) (plaintext posture, Accepted), [ADR-0090](../docs/adr/0090-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md) (this direction, Proposed; flips to Accepted when Phase 1 lands). `specs/20260623T220000-content-addressed-blob-store.md` deleted.

### Phase 1: delete (after the bearer-302 fix PR merges)

- [x] **1.1** Delete `pull`, `blobs-manifest.ts`, `blobs-manifest.test.ts`.
- [x] **1.2** Collapse `add` to hash-upload-print; drop `-C`, `--dir`, and all disk writes.
- [x] **1.3** Move the download re-hash check from `pull` into `get`.
- [x] **1.4** Delete the `usage` route, `client.blobs.usage()`, and the `API_ROUTES.blobs.usage` entry (check `apps/api/scripts/smoke.ts` for a caller first).
- [x] **1.5** Rewrite the CLI module header to the one-product sentence.

### Phase 2: agent ergonomics

- [ ] **2.1** `get` and `rm` accept a full blob URL and extract the hash (regex on `/blobs/([a-f0-9]{64})`).
- [ ] **2.2** Plain (non-JSON) `add` output prints the URL alone on stdout, so `$(epicenter blobs add x.png)` composes.

### Phase 3: trigger-gated, not scheduled

- [ ] **3.1** Public tier (second bucket, bucket-level public access) when the post pipeline publishes its first asset.
- [ ] **3.2** `gc` when a real vault accumulates orphans.

## Edge Cases

### rm while cited

1. A markdown file cites a blob URL; `blobs rm` deletes the object.
2. The URL 404s forever.
3. Accepted: the store is yours and storage costs money. The `rm` help text states the consequence; `gc` (Phase 3) is the safer verb later.

### Same file added twice

1. `blobs add` on identical bytes.
2. The dedupe HEAD returns `duplicate: true` and the same URL.
3. This is the contract that lets agents call `add` without checking first.

### Deployment migration

1. Cited URLs embed the old origin (hosted, then self-host, or a domain change).
2. Find-replace the origin prefix across the vault; the `owners/<id>/blobs/<sha>` path is stable.
3. The hash inside every URL keeps documents self-describing through the rewrite.

## Open Questions

1. **Should `add` remember original filenames?**
   - The manifest recorded them; without it, `blobs ls` is hashes, sizes, dates.
   - Options: (a) accept illegibility, (b) pin `content-disposition` into the presigned PUT signature the same way `content-type` already is, so the object itself remembers its name (costs one signed header now, per-object HEADs to display later).
   - **Recommendation**: (a) for now; the URL is pasted next to prose that names it. Revisit when `ls` illegibility actually bites.

2. **Public tier verb shape**: `add --public` vs an explicit `blobs publish <sha256>` promotion.
   - **Recommendation**: the explicit verb. Private-by-default with a deliberate promotion step keeps the privacy copy honest, and it matches the post pipeline owning the publish moment. Defer until that pipeline exists.

3. **Does `get` accepting URLs belong in Phase 1 instead of Phase 2?** It is a five-line parse and it is the ergonomic agents will hit first.
   - **Recommendation**: fine either way; keep Phase 1 pure deletion for reviewability.

## Success Criteria

- [ ] `epicenter blobs` passes the one-sentence test with a single product sentence.
- [ ] Zero references to `epicenter.blobs.lock` anywhere in the repo.
- [ ] `add` prints a URL and touches no disk; `get` verifies the download against its address.
- [ ] Client and CLI typecheck and tests pass; live round trip (`add`, `get`, byte-identical sha256) run once against the real bucket.

## References

- `packages/cli/src/commands/blobs.ts`: the command tree this spec collapses.
- `packages/cli/src/commands/blobs-manifest.ts`: deleted whole in Phase 1.
- `packages/client/src/index.ts`: `blobs.add/get/url`; unchanged except `usage` removal.
- `packages/server/src/routes/blobs.ts`, `packages/server/src/s3-blob-store.ts`: the kernel; untouched.
- `specs/20260623T220000-content-addressed-blob-store.md`: the kernel spec whose settled decisions move to the ADR.
- `apps/whispering/specs/20260701T120000-whispering-cloud-sync-remainder.md`: Phase 5 should consume `client.blobs` instead of minting audio routes (2026-07-01 review memo).
