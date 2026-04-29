# The daemon isn't accidental: why every Epicenter script connects to a hub

When we were designing the Epicenter API, we kept circling back to one question: do we actually need a daemon? Every script you write could just spin up its own workspace instance, attach SQLite, attach cloud sync, do its thing, and exit. No IPC, no preamble, no resident process. Beautiful in principle.

We didn't go that way. Each folder gets one daemon, scoped to that folder, unique to your machine, and every script you write connects to it as a peer. This article is about why the tempting "no daemon" version doesn't survive contact with reality, and how we picked the protocol the daemon speaks.

## Every-script-its-own-instance was tempting

The pitch writes itself. Drop the resident process. Each script does:

```ts
using fuji = openFuji();
// attachSqlite to the local file
// attachSync to the cloud WebSocket
fuji.tables.entries.set({ id: 'a', url: '...' });
```

One model, no IPC, no daemon lifecycle. If you've ever debugged a stuck unix socket or a stale pid file, this looks like the right answer.

It falls over for four reasons, and they're all real.

### SQLite is single-writer

y-sqlite providers serialize the StructStore as atomic blobs. Two Bun processes writing the same `.epicenter/fuji.sqlite` file race on WAL checkpoints and corrupt the store. This isn't a "tune your isolation level" problem; the Yjs persistence providers don't model concurrent writers to the same file at all.

Look at what Turso did. They wanted libsql to work for multi-process workloads, hit exactly this wall, and shipped `sqld`: a daemon that owns the file and serves connections. The daemon for SQLite is not optional. It's what the ecosystem keeps reinventing.

### Cloud WebSocket fan-out

Ten scripts running concurrently means ten WebSocket connections to your sync server. Cloudflare Durable Objects bill per connection. Cloud sync servers are sized assuming one connection per device, not one per shell command.

The whole y-websocket / y-redis / hocuspocus / partykit ecosystem is hub-and-spoke for the same reason. Nobody runs y-redis with "every client opens its own server connection." There's always a hub.

### Cold-start hydrate

A 50 MB Y.Doc loads from SQLite in roughly 1.5 seconds. Multiply that by every `bun run script.ts` invocation. Now your shell scripts feel like Java startup.

A daemon already has the doc in memory. A peer connecting over a unix socket only needs the state-vector diff, which is ~50ms on a warm doc. The same reason your dev server stays resident: rebuilding from scratch every time is a tax you pay for nothing.

### clientID accumulation

This one's subtle. Every Y.Doc has a random `clientID`, and every write it performs is tagged with that ID forever. Yjs needs the tag for causality; it never garbage-collects.

Spin up a fresh process per script and you get a fresh random clientID per invocation. Run a thousand scripts in a week, and your daemon's state vector grows by a thousand permanent entries that ship on every cold-start sync. The "no daemon" model fans this problem out across every process that touches the doc.

## So we kept the daemon

One daemon per folder. Scoped to that folder, unique to your machine. It owns the SQLite file, holds the Y.Doc in memory, talks to the cloud over a single WebSocket, and serves local processes over a unix socket inside `.epicenter/`. Every script you write connects to it.

```
~/projects/fuji/
├── .epicenter/
│   ├── daemon.sock      ← scripts connect here
│   ├── daemon.pid
│   └── fuji.sqlite      ← only the daemon writes
├── scripts/
│   ├── tag-untagged.ts  ← peer
│   └── export.ts        ← peer
└── vault/
```

Once you accept the daemon, the interesting question collapses: how do peers talk to it?

## Two clean options

```
JSON-RPC over unix socket           Yjs sync over unix socket
─────────────────────────           ─────────────────────────
Daemon owns the Y.Doc.              Daemon owns the Y.Doc.
Peer is a thin client that          Peer ALSO owns a Y.Doc.
marshals method calls.              They sync via the same protocol
                                    the daemon uses to talk to cloud.

Wire shape: JSON envelopes.         Wire shape: Yjs binary updates.
Peer can: call methods.             Peer can: everything (observe,
Peer cannot: observe, bind          bind Y.Text, batch closures,
Y.Text, batch closures, run         filter with closures, awareness).
closure filters.
```

We went with option two: sync-as-peer. The reason is single. Option one forces you to define a parallel API surface, "the wire-callable subset," and write machinery to enforce it: branded methods, mapped types, recursive proxies, then-masking, depth-bounded type recursion. Option two doesn't.

Under sync-as-peer, the script holds a real Y.Doc. The browser tab also holds a real Y.Doc. Both attach IO appropriate to where they run; the browser attaches IndexedDB and a cloud WebSocket, the script attaches a unix-socket sync session pointed at the daemon. The daemon is the only process that attaches SQLite and the cloud WebSocket. The differences are honest, not papered over.

```ts
// vault/scripts/tag-untagged.ts
await using fuji = await openFujiPeer();

const untagged = fuji.tables.entries
  .filter(e => !e.deletedAt && e.tags.length === 0);

fuji.batch(() => {
  for (const e of untagged) {
    fuji.tables.entries.update(e.id, { tags: ['untagged'] });
  }
});

fuji.tables.entries.observe(ids => console.log('changed:', ids));

const readme = fuji.ydoc.getText('readme');
readme.insert(0, '# Hello\n');
```

`observe`, `batch`, `ydoc.getText` all just work. The script isn't pretending to be a workspace through a JSON keyhole. It is one. The daemon happens to be the peer that owns persistence and cloud sync; the script happens to be the peer that doesn't.

## What this buys, plainly

Scripts get the full Y.Doc API. Binding a `Y.Text` to a TUI editor in a script: free. Subscribing to changes pushed by the browser tab: free. Atomic multi-write batches inside a closure: free. Closure-based filters that don't cross a wire: free.

The mental model collapses to one sentence. Every Epicenter process holds a real workspace. They differ only in which `attach*` primitives carry their bytes. The daemon is a peer that happens to own SQLite and the cloud WebSocket; everything else is a peer that talks to the daemon.

The daemon was never the accidental complexity. The accidental complexity was pretending the workspace API could be projected through a JSON wire. We dropped the wire. The daemon stayed.
