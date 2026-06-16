# Account and Document Ownership

This is the canonical reference for who owns a document in Epicenter, how cloud
sync is addressed, and where "organization" fits. For the narrative behind the
decision, see `docs/articles/20260522T170000-documents-belong-to-you-not-a-workspace.md`.

## The core rule

A document is owned by a user, addressed by the user's identity. There is no
container between the user and the document.

```
owner   = the user (in personal mode) or the deployment (in shared mode)
document = a Y.Doc, identified by its guid
```

The token says who you are. For your own documents, that is the entire
authorization story. There is no membership lookup, because you cannot fail to
be yourself.

## Three layers, introduced over time

Epicenter separates content ownership from tenancy and billing. They are
distinct layers; only Layer 1 exists today.

```
LAYER 3  Tenancy / billing       acme.com, 40 seats, admin console     Google Workspace
           groups user ACCOUNTS for one invoice and admin policy       (enterprise, future)
              |  administers
LAYER 2  Shared-drive content    docs OWNED BY an org, so they         Google Shared Drives
           survive a departing employee                                (enterprise, future)
              |  alongside
LAYER 1  Personal content        owners/<ownerId> owns the doc;        consumer Google Docs
           an ACL grants other users access                             (TODAY)
```

Layer 1 is what ships today: your documents are yours. Layer 1.5 is per-document
sharing through an access list, additive, not yet built. Layer 2 is org-owned
content for the enterprise case where work must outlive an employee. Layer 3 is
the billing and administration grouping for enterprise seats.

The layers attach cleanly because Layer 1 makes no claim about teams or billing.
Build a fused container first (the Notion model) and you are forced to invent a
container-of-one for every solo user before any real org exists.

## Google Docs, not Notion

The distinction that decides everything: Notion fuses content ownership and
billing into one "workspace". A page lives inside a workspace, the workspace is
the billing boundary, membership is workspace-level. One entity, two jobs.

Google separates them. A Google Doc is owned by a user account; sharing is a
per-document access list. Google Workspace is a separate product: a domain, an
admin console, per-seat billing, administering a set of user accounts. It never
owns a document.

Epicenter follows Google. Content ownership is Layer 1. Tenancy and billing are
Layer 3. They never merge.

## Cloud sync addressing

A cloud doc syncs through one route, keyed by the owning user and the doc's
guid.

```
route     /api/owners/:ownerId/rooms/:room   (both modes)
DO name   owners/${ownerId}/rooms/${room}    (room = ydoc.guid)
builder   roomWsUrl({ baseURL, ownerId, guid: ydoc.guid, nodeId })
```

The DO partition is `owners/<ownerId>` in both modes. In personal mode
`ownerId === user.id`, derived from the authenticated user's id. In shared mode
`ownerId === 'shared'`, so every admitted user on the deployment shares the
same partition. The room id is the Y.Doc's guid: the document already carries
its own identity, so nothing else is composed into the name.

Browser apps and the daemon use the same route and the same builder. They sync
the same document by using the same guid.

There is no `appId` segment. A user may hold documents from several apps;
cross-app collision is avoided by convention (each app names its root doc
after itself, child docs carry unique guids), not by infrastructure. Guid
uniqueness per user is already required for local IndexedDB, so cloud sync
adds no new collision surface.

## What "organization" means here

An organization is a Layer 3 concept: a billing and administration grouping of
user accounts. It is not a container that owns documents.

The Better Auth organization plugin belongs to Layer 3, where its real strengths
(members, roles, invitations, admin) apply to accounts. It does not belong under
documents. A solo user is not an organization, and modeling them as an
organization-of-one buys a degenerate entity, a derived id that is a pure hash
of the user id, and a membership check whose only failure mode is a provisioning
bug.

## Why personal docs need no membership check

Authorization for a Layer 1 document is identity, not membership. The route's
auth middleware confirms the caller is a valid user; the DO name is derived from
that same identity. A user reaching their own `owners/${ownerId}/rooms/*` space
(where `ownerId === user.id` in personal mode) is, by construction, authorized.
A membership query here would have exactly one possible denial: the system is
broken.

Layer 1.5 sharing changes this only for documents shared *to* you: the owner's
DO name stays `owners/${ownerId}/rooms/${room}`, and an ACL table grants
other users access. The auth check becomes "is the caller the owner, or in the
ACL". Your own documents still need no lookup.

## Billing

Billing is per user account. The signup hook creates an Autumn customer keyed on
`user.id`. No per-document or per-workspace billing exists. Enterprise per-seat
billing is Layer 3 and aggregates user accounts under a tenancy; it does not
require content to be owned by anything other than the user.

## Related

- `docs/articles/20260522T170000-documents-belong-to-you-not-a-workspace.md` - the narrative
- `specs/20260522T160000-revert-cloud-workspace-sync-layer.md` - the spec that reverted the code to this model
- `packages/workspace/SYNC_ARCHITECTURE.md` - the sync transport, presence, and dispatch surfaces
- `docs/encryption.md` - the trust model: the relay reads plaintext, so
  privacy is a topology choice (who runs the anchor) rather than an encryption layer
