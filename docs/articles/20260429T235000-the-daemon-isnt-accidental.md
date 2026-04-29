# The daemon isn't accidental: why every Epicenter script connects to a hub

When we were designing the Epicenter API, we kept circling back to one question: do we actually need a daemon? Every script you write could just spin up its own workspace instance, attach SQLite, attach cloud sync, do its thing, and exit. No IPC, no preamble, no resident process.

We didn't go that way. Each folder gets one daemon, scoped to that folder, unique to your machine, and every script you write connects to it as a peer. This article is about why the tempting "no daemon" version doesn't survive contact with reality, and how we picked the protocol the daemon speaks.

## Every-script-its-own-instance was tempting

The pitch writes itself. Drop the resident process. Each script does:

```ts
using fuji = openFuji();
attachSqlitePersistence(fuji.ydoc, { filePath: '.epicenter/fuji.sqlite' });
attachSync(fuji.ydoc, { url: 'wss://api.epicenter.so/...' });

fuji.tables.entries.set({ id: 'a', url: '...' });
```

If you've ever debugged a stuck unix socket or a stale pid file, this looks like the right answer. It falls over for two load-bearing reasons:

- **SQLite is single-writer.** When SQLite is also where the materializer writes, two Bun processes writing the same file race on WAL checkpoints and the StructStore corrupts. y-sqlite providers serialize the StructStore as atomic blobs, which makes this strictly worse. Turso hit this exact wall and shipped `sqld` so libsql could serve multiple processes safely. Whenever the ecosystem wants multi-process SQLite, the answer keeps coming back as a serializing process. The daemon is one such process; `sqld` is another, just with a different name.

- **Cloud WebSocket fan-out for concurrent or long-lived peers.** Ten scripts running concurrently means ten WebSocket connections to your sync server. Cloudflare Durable Objects bill per connection (and even when the per-connection cost is tiny, each open WS pins the DO instance to a colo and consumes its memory budget). For sequential one-shot scripts this is fine; for concurrent fanout or long-lived peer.ts watchers, you want one WS per device, not one per shell command. The whole y-websocket / y-redis / hocuspocus / partykit ecosystem is hub-and-spoke for this reason.

Two reasons that *sound* like daemon arguments but aren't:

- **Cold-start hydrate is not a daemon win.** A cold script that needs the full Y.Doc pays `Y.applyUpdate` of the whole state regardless of where the bytes come from. Reading 50 MB from local SQLite vs. receiving 50 MB from a daemon over a unix socket is the same order of magnitude (a few ms either way); the dominant cost is the apply, which both paths pay. A daemon does help *long-lived* peers and helps any peer that already has its own persistence (small state-vector diff over IPC), but a fresh script with no persistence sees no cold-start speedup from talking to a daemon vs. talking to the cloud.

- **clientID accumulation is fixed peer-side, not by the daemon.** Every Y.Doc has a random `clientID`, and every write it performs is tagged with that ID forever. Fresh process per script means fresh random clientID per invocation, ten thousand entries in your state vector after ten thousand runs. The fix is `hashClientId(Bun.main)` (`packages/workspace/src/shared/client-id.ts`): derive a stable 53-bit clientID from the script's entry-point path. Two invocations of the same script reuse the same clientID. This works whether or not there's a daemon; the daemon just gets the same fix for free because daemons have stable identities trivially.

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

Under JSON-RPC, the script never holds a real Y.Doc. The proxy intercepts every method call and ships it as JSON:

```ts
// JSON-RPC: every call becomes a round trip
const ws = await connectDaemon<Fuji>('fuji');
await ws.tables.entries.set({ id: 'a', url: '...' });
//        ↓ proxy intercepts
//   POST /run { actionPath: 'tables.entries.set', input: {...} }

ws.tables.entries.observe(cb);  // throws RemoteNotSupported
ws.ydoc.getText('readme');      // undefined, ydoc never crossed the wire
```

To make that work, you have to define a parallel API surface, "the wire-callable subset," and write machinery to enforce it: branded methods, mapped types, recursive proxies, then-masking, depth-bounded type recursion. Then live with the parts that can't cross a JSON wire at all (`observe`, closure filters, `Y.Text` binding).

We went with option two. Under sync-as-peer, the script holds a real Y.Doc, and the wire ships Yjs updates. Three env factories, one core, IO swapped per environment:

```ts
// Browser tab: IndexedDB + cloud WS
export function openFujiBrowser(opts: { authToken: string }) {
  const fuji = openFuji();
  attachIndexedDb(fuji.ydoc, 'epicenter.fuji');
  attachSync(fuji.ydoc, { url: ..., auth: opts.authToken });
  return fuji;
}

// Daemon: SQLite + cloud WS + serves local peers
export function openFujiDaemon(opts: { absDir: string; authToken: string }) {
  const fuji = openFuji();
  attachSqlitePersistence(fuji.ydoc, { filePath: persistencePath(opts.absDir) });
  attachSync(fuji.ydoc, { url: ..., auth: opts.authToken });
  attachSyncHub(fuji.ydoc, { socket: socketPathFor(opts.absDir) });
  return fuji;
}

// Peer (script): syncs to the local daemon, no other IO
export async function openFujiPeer(opts?: { absDir?: string }) {
  const fuji = openFuji();
  await attachSyncIpc(fuji.ydoc, {
    socket: socketPathFor(opts?.absDir ?? findEpicenterDir()),
  });
  return fuji;
}
```

The browser attaches IndexedDB. The daemon attaches SQLite and serves a sync hub. The peer attaches a unix-socket sync session pointed at that hub. Same `openFuji()` core under all three.

The script then looks like any other workspace consumer:

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

`observe`, `batch`, `ydoc.getText`: all just work. The daemon happens to be the peer that owns persistence and cloud sync; the script happens to be the peer that doesn't.

## What this buys, plainly

Scripts get the full Y.Doc API. Binding a `Y.Text` to a TUI editor in a script: free. Subscribing to changes pushed by the browser tab: free. Atomic multi-write batches inside a closure: free. Closure-based filters that never cross a wire: free.

The mental model collapses to one sentence. Every Epicenter process holds a real workspace. They differ only in which `attach*` primitives carry their bytes. The daemon is a peer that happens to own SQLite and the cloud WebSocket; everything else is a peer that talks to the daemon (over the same Yjs sync protocol the daemon uses to talk to the cloud).

The daemon was never the accidental complexity. The accidental complexity was pretending the workspace API could be projected through a JSON wire. We dropped the wire. The daemon stayed.
