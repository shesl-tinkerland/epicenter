# Local Books: an agent over a local SQL mirror

Status: Draft. Date: 2026-06-20.

Local Books is the first real worker consumer (ADR-0043): a local-first product where an agent answers questions about your books by running SQL locally, over a synced conversation, and proposes mutations you approve from any device. It is the forcing function that un-defers the agent loop (ADR-0042) and exercises the approval policy seam (ADR-0044). Vocab proved the conversation substrate with zero tools; Local Books is the same substrate plus the tools that make a daemon necessary.

## Why a daemon is necessary here (and not for Vocab)

The justification for a worker is **capability locality**, not answering. Vocab's worker has no capability the client lacks (it is a stateless model call), so it answers in the client. Local Books' worker reads a local SQLite mirror of your books that lives on one machine: you ask from your phone, the data is on your desktop, so the agent must run on the desktop and stream the answer back through the box (ADR-0035) to your phone. A hosted worker is impossible by definition here: it would mean uploading the books, the one thing the product exists to avoid.

## Locked product direction (mirror, not ledger)

Settled in an earlier greenfield grill (not yet harvested onto `main`; harvest into `docs/adr/` when this lands):

1. **Mirror plus overlay, not a ledger.** QuickBooks is the system of record; Local Books reflects and annotates, never authors.
2. **SQLite, not Yjs, for the facts.** Facts are a re-pullable cache of remote truth, so a CRDT earns nothing. The conversation and the overlay (notes, review state) are the only Yjs-synced surfaces.
3. **Faithful per-provider raw is canonical.** QuickBooks-only, concrete, no provider abstraction until provider #2 disagrees.
4. **No Markdown in v1.** The read path is agent-over-SQL.
5. **Append-only observations plus a local overlay keyed to the QuickBooks logical id.** Each sync appends; nothing updates or deletes a fact in place.
6. **No write-back.** Append-only observation diffs give free change-tracking of your own books without competing with the accountant who owns the QuickBooks edits.

## Shape

```txt
apps/local-books/                Epicenter root (app folder = root)
  epicenter.config.ts            export default localBooks({ agentId: 'local-books' })
  facts (NOT synced)             local SQLite mirror of QuickBooks:
                                   observations  raw_payloads  sync_runs  overlay_*
                                   + current_state / observation_diff views
  conversation (synced)          conversations table -> child doc -> parts (ADR-0025/0036)

daemon (runs where the data is, ADR-0043)
  observes conversations bound to agent 'local-books' (designation, ADR-0025)
  runs the agent loop (ADR-0042) over the synced conversation doc
  tools = workspace actions via tool-bridge (ADR-0021):
    READ   books_sql_query(sql)        approval policy -> auto
    WRITE  mark_reviewed(ids)          approval policy -> read-only | ask | auto (ADR-0044)
           add_note(qbId, note)
  engine resolves a backend (ADR-0038); inference may be cloud-metered, data stays local
  NEVER: bash, file I/O, write-SQL, a raw Y.Doc handle

client (phone / browser)
  opens the conversation child doc, renders parts (text, tool-call, tool-result)
  writes user turns; approves pending mutations from any device
  (writes the client-owned decision field, ADR-0042)
```

## Slices

1. **QuickBooks OAuth read spike (sandbox).** Populate the SQLite mirror; observations append-only. Risk-first, proves the data path before any agent.
2. **Agent-over-SQL daemon, read tools only.** `books_sql_query` auto-runs; phone asks, desktop answers over sync. This un-defers ADR-0042's loop at the zero-mutation path.
3. **Write tools plus the approval policy seam (ADR-0044) over doc-mediated approval (ADR-0042).** `mark_reviewed` / `add_note`; ship `read-only` / `ask` / `auto`; classifier deferred.
4. **Client UI.** Render the parts, approve pending mutations from any device, write user turns.

## Open items

- Placement confirmed: `apps/local-books` is its own root, reusing the CLI / relay / agent and the conversation workspace, not the books facts as Yjs.
- Observation-table grain: one table plus `entity_type` plus `raw_json` plus extracted query columns (leaning), vs per-entity-type tables.
- Bound transaction volume and which QuickBooks entities v1 mirrors.
- Harvest the mirror-not-ledger and SQLite-not-Yjs decisions into `docs/adr/` on landing.
