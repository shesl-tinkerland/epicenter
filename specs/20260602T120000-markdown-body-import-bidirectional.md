# Bidirectional entry bodies (markdown body import, V2)

> **Superseded by `specs/20260602T200000-vault-read-only-projection-agent-mutation.md`.** The materialized markdown is now a one-way read-only projection of Yjs: the disk to Yjs body import this spec describes (`writeBody`, `parseEntryBody`, `markdown_apply`) was deleted along with `attachMarkdownVault`. App data mutates only through validated actions. Kept for history.

**Status**: implemented on `feat/fuji-body-import` (follow-up to the vault/export split, PR #1890). Unit-tested (codec round-trip, vault apply, the HTTP write primitive); the live two-vault relay proof still needs cloud auth.
**Supersedes**: the "Bodies (v2)" section of `specs/20260601T160000-markdown-sync-greenfield.md`. That section specifies body import on the OLD single-seam `codec` model (paired `toMarkdown`/`fromMarkdown`/`applyBody` + a derived `bodyHash` row column). That model was abandoned in PR #1890, which split the one seam into `attachMarkdownVault` (editable, `readBody`) and `attachMarkdownExport` (read-only, `toMarkdown`). This spec realigns body import to the shipped vault. There is no `codec` and no `bodyHash`.

## Intent (one paragraph)

Today the vault materializes a fuji entry's rich-text body to disk READ-ONLY (`readBody: (row) => string`, a faithful `prosemirror-markdown` serialization) and `markdown_apply` reconciles FRONTMATTER ONLY, ignoring the body on disk. V2 makes the body two-way: an edited markdown body on disk is parsed back into the entry's ProseMirror/Yjs content doc on `apply`. The hard part is not the plumbing (it exists); it is keeping the markdown round-trip faithful for fuji's two custom marks, and writing the parsed doc back as a CRDT-minimal diff rather than a history-destroying clobber.

## What shipped (the V2 baseline, PR #1890)

```
vault.ts        VaultTableConfig<TRow> = { readBody?, onDelete? }
                render(row) = assembleMarkdown(row, await readBody?(row))   // frontmatter = row + body section
                applyMarkdownFiles: diffs FRONTMATTER rows (Value.Equal), body on disk is parsed then DISCARDED
                                    (parse-markdown-file.ts already returns `body`; vault.ts ignores it)
fuji project.ts readEntryBody(entry): open ephemeral content doc by entryContentDocGuid(id),
                                      whenConnected, serializeEntryBody(fragment), destroy. Read-on-demand,
                                      never persisted on the daemon. Throws-to-skip on connect-deadline.
entry-body-markdown.ts  serializeEntryBody(fragment) = yXmlFragmentToProseMirrorRootNode(fragment, entryBodySchema)
                        then a MarkdownSerializer (default nodes + marks; strikethrough `~~`, underline as `<u>`).
entry-body-schema.ts    entryBodySchema = basic + list nodes + {strikethrough, underline}. ONE schema, shared
                        with the editor (EntryBodyEditor.svelte) so reads and edits cannot drift.
```

Materialize (Yjs -> disk) staleness is accepted by design: the vault observes only `table.observe`, so a pure body edit (no row change) does not re-materialize the `.md` until the row changes or the daemon restarts (restart re-reads every body = restart-as-heal). V2 does NOT change this read-direction behavior and does NOT reintroduce a `bodyHash` to fix it.

## The blocker: a faithful parser, not just any parser

`serialize(parse(md))` must equal `serialize(md)` (canonical fixed point), or an agent's one-word edit corrupts structure. The read half already serializes the two custom marks lossily-for-CommonMark:

- underline -> literal `<u>...</u>` HTML
- strikethrough -> `~~...~~`

`prosemirror-markdown`'s `defaultMarkdownParser` is built on `MarkdownIt('commonmark', { html: false })`. Consequences, both SILENT corruption on apply:

1. `html: false` => `<u>x</u>` parses to the visible text `<u>x</u>`, not an underline mark.
2. The `commonmark` preset does not enable markdown-it's `strikethrough` rule, and `defaultMarkdownParser.tokens` has no `s` entry => `~~x~~` parses to the literal text `~~x~~`.

Everything else in `entryBodySchema` (headings, lists, blockquote, code_block, em, strong, link, code, image, hard_break) round-trips through the defaults.

### Fix (mechanical, mirrors the serializer)

Build a custom `MarkdownParser` the same way `entry-body-markdown.ts` builds a custom `MarkdownSerializer`:

```ts
// entry-body-markdown.ts (the file stops being "read half only")
import { MarkdownParser, defaultMarkdownParser } from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';

const md = MarkdownIt('commonmark', { html: true }).enable('strikethrough');

const parser = new MarkdownParser(entryBodySchema, md, {
  ...defaultMarkdownParser.tokens,
  s: { mark: 'strikethrough' },              // markdown-it emits s_open / s_close
  // <u>/</u> arrive as html_inline tokens; map them to open/close the underline mark
  // (a small token rule, since ParseSpec has no built-in HTML-to-mark path)
});

export function parseEntryBody(markdown: string): Node {
  return parser.parse(markdown);
}
```

`entryBodySchema` gains a THIRD consumer (editor, serializer, parser). That is the real maintenance cost and the reason the schema is already a single shared module.

### Round-trip test (the gate)

Mirror `entry-body-markdown.test.ts`: for a corpus covering every node and BOTH custom marks, assert `serialize(parse(serialize(doc))) === serialize(doc)`. Body import does not turn on until this passes. Non-canonical hand-authored markdown (e.g. `*` vs `-` lists, setext headings) is allowed to normalize on first apply; only the mirror's own output must be a fixed point.

## The write half: diff into the content doc, never clobber

Do NOT replace the fragment. `attachRichText.write` deletes + re-inserts, and `prosemirrorToYXmlFragment` warns it destroys history. A clobber loses CRDT history and any concurrent edit that synced between read and write. Use y-prosemirror's `updateYFragment` (the same diff the live editor binding uses):

```ts
import { initProseMirrorDoc, updateYFragment } from 'y-prosemirror';

function writeBodyIntoFragment(ydoc: Y.Doc, fragment: Y.XmlFragment, markdown: string): void {
  const { mapping } = initProseMirrorDoc(fragment, entryBodySchema);
  const target = parseEntryBody(markdown);
  ydoc.transact(() => updateYFragment(ydoc, fragment, target, { mapping, isOMark: new Map() }));
}
```

`updateYFragment` produces a structural minimal diff: if the parsed body equals the current doc, the diff is empty and nothing syncs. This is why V2 needs NO `bodyHash` to avoid churn: idempotence falls out of the diff. The cost is opening the content doc during apply for each entry whose `.md` is present (the daemon's open-sync-mutate-flush-destroy dance). `apply` is explicit and rare, so this is acceptable.

## API: `writeBody` as a flat sibling of `readBody`

```ts
// vault.ts
export type VaultTableConfig<TRow extends BaseRow> = {
  readBody?: (row: TRow) => MaybePromise<string>;            // unchanged: Yjs -> disk (read)
  writeBody?: (id: string, markdown: string) => MaybePromise<void>;  // NEW: disk -> Yjs (write)
  onDelete?: (id: string) => void;
};
```

NOT a merged `bodyCodec: { read, write }`. The signatures are honestly asymmetric (`readBody(row)` during materialize vs `writeBody(id, markdown)` during apply), a table may legitimately have one without the other (read-only projection = `readBody` only), and `onDelete` already sets the flat-optional-sibling precedent. This matches the prior decision: read-only `readBody` and an editable body must NOT hide behind one cute option.

### The write transport: one-shot HTTP, not an ephemeral websocket

A one-shot body write is a request/response, NOT a live collaboration session. The content doc has no local persistence and no long-lived connection, so "the bytes left my buffer" is not durability. The original draft of this spec assumed `await collaboration.whenSynced` would flush before teardown; that API does not exist, and on Bun (`ws.close()` discards the send buffer) an ephemeral open-write-destroy can silently lose the update. The relay already exposes a durable HTTP route (`POST /api/owners/:ownerId/rooms/:roomId` applies the update with a synchronous durable append BEFORE responding), so the `2xx` IS the receipt and there is nothing to tear down.

This is the generic `writeRoomOverHttp` primitive (`packages/workspace/src/document/http-room-sync.ts`): GET the room's current doc, apply a `mutate` to a local copy seeded with that state, POST the diff. The daemon mount gets an auth'd `fetch` via a new `MountContext.fetch` (sourced from the auth client's existing bearer-bearing `fetch`).

```ts
// fuji project.ts: partner to readEntryBody. GET state -> diff -> POST, no socket.
const writeEntryBody = (id: EntryId, markdown: string): Promise<void> =>
  writeRoomOverHttp({
    fetch, baseURL: EPICENTER_API_URL, ownerId, guid: entryContentDocGuid(id),
    mutate: (ydoc) => {
      const fragment = ydoc.getXmlFragment('content');
      const { meta } = initProseMirrorDoc(fragment, entryBodySchema);
      updateYFragment(ydoc, fragment, parseEntryBody(markdown), meta);
    },
  });
// attachMarkdownVault({ tables: { entries: { readBody, writeBody: (id, md) => writeEntryBody(asEntryId(id), md), onDelete } } })
```

`mutate` runs against a throwaway `Y.Doc` already holding the server state, so `updateYFragment` computes a minimal diff that preserves history and merges concurrent edits. (`readEntryBody` still uses the websocket today; migrating it to an HTTP GET is an optional follow-up.)

## apply algorithm changes

In `applyMarkdownFiles` / `readTableFile` (vault.ts):

1. `readTableFile` already has `parsed.body` from `parseMarkdownFile`; stop discarding it. Carry it (plus the raw file content) on the `ReadResult` row variant.
2. After the frontmatter transaction commits, call `writeBody(id, body ?? '')` for each desired entry whose `.md` CHANGED since the vault last materialized it (a `fileState` byte compare). This is keyed on file change, NOT on a frontmatter create/update: a body-only edit leaves the frontmatter identical, so gating on the frontmatter diff would miss it. The `fileState` compare skips untouched files without opening their body doc; no `bodyHash` column is needed.
3. Body writes are per-content-doc and async; they are NOT inside the root-doc `ydoc.transact`, and a failure is logged, never rolled back.

## Invariants (additions to the v1 set)

1. Frontmatter apply stays atomic on the ROOT doc (one `ydoc.transact`). Body writes are per-entry, per-content-doc, separate transactions = best-effort per entry. "apply is atomic" applies to frontmatter only; do not claim otherwise.
2. Faithful round trip: `serialize(parse(serialize(doc))) === serialize(doc)` for the full fuji schema including both custom marks. Gated by the round-trip test.
3. Write is a diff (`updateYFragment`), never a fragment clobber. History and concurrent edits survive.
4. The body write is durable by the HTTP response: the relay appends the update synchronously before answering, so a `2xx`/`204` confirms it. No send-buffer flush, no socket teardown (the failure mode the original `whenSynced` plan papered over).

## What collapses

- `apps/fuji/src/lib/workspace/markdown.ts` (`createFujiMarkdownActions`): DELETE. It is a WIP "not yet wired to UI" parallel markdown impl with a hand-rolled `js-yaml` frontmatter codec and a LOSSY plaintext body codec. Its own header says to unify it. Once `parseEntryBody` + the vault own body import, this second implementation has no reason to exist. (The one real dependency to resolve first: it uses `js-yaml` because `Bun.YAML` is not in the Tauri webview; re-derive a browser path from the shared codec only if a browser caller actually needs it.)
- `parse-markdown-file.ts`'s `body` field: becomes consumed (was parsed then dropped at vault.ts).
- `entry-body-markdown.ts`'s "read half only" framing: becomes a real serialize+parse codec pair.

## What does NOT collapse (kept honestly separate)

- `readBody` vs `writeBody`: two flat siblings, asymmetric on purpose.
- Root-doc atomic frontmatter apply vs per-content-doc body writes.
- Daemon ephemeral open-sync-mutate-destroy vs the browser's live `entryBodies` cache: different lifecycles, not a shared store.
- The vault stays prosemirror-agnostic: it knows only `readBody`/`writeBody: (…) => string`. The schema-aware codec lives in fuji.

## What NOT to build (YAGNI)

- `bodyHash` / a derived content-hash column: NOT needed. `updateYFragment`'s empty diff gives idempotence; `apply` opening present-file docs is acceptable for an explicit, rare operation. Add a hash only if a benchmark proves per-apply doc opens hurt.
- A body-write cache or a shared `EntryBodyStore`: fake symmetry, deferred (see prior spec).
- Continuous body materialize (fixing read-direction staleness without restart): out of scope; restart-as-heal stands unless a real need appears.

## Validation

Two-vault live runbook with the body included: edit a structured body (heading + list + bold + underline + strikethrough) in `vaultA/entries/x.md`, `epicenter run fuji.markdown_apply`, then assert `vaultB` materializes a byte-identical body after sync. Needs real cloud auth. Run the round-trip unit test first; it catches the custom-mark corruption without any cloud.

## Prior art / grounding (file:line)

- `packages/workspace/src/document/materializer/markdown/vault.ts`: `VaultTableConfig`, `readTableFile` (discards body ~L162), `applyMarkdownFiles` (root transaction).
- `apps/fuji/src/lib/workspace/entry-body-markdown.ts`: `serializeEntryBody` (the half to mirror).
- `apps/fuji/src/lib/workspace/entry-body-schema.ts`: `entryBodySchema` (the shared contract the parser must track).
- `apps/fuji/src/lib/workspace/project.ts`: `readEntryBody` (the pattern `writeEntryBody` mirrors).
- `apps/fuji/src/lib/workspace/markdown.ts`: `createFujiMarkdownActions` (the collapse target).
- libraries: `prosemirror-markdown` (`MarkdownParser`, `defaultMarkdownParser`), `y-prosemirror` (`initProseMirrorDoc`, `updateYFragment`, `yXmlFragmentToProseMirrorRootNode`), `markdown-it` (`strikethrough` rule, `html: true`).
