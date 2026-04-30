# The daemon isn't accidental: why we kept it after deleting the sync hub

When we were designing the Epicenter API, we kept circling back to one question: do we actually need a daemon? Every script you write could just spin up its own workspace instance, attach SQLite, attach cloud sync, do its thing, and exit. No IPC, no preamble, no resident process.

We didn't go that way. Each folder gets one daemon, scoped to that folder, unique to your machine. For one week we built it as a sync hub: a unix-socket Yjs-sync transport so peers could share a Y.Doc across processes. Then we deleted that wire wholesale, ~4,500 lines of recently-shipped transport code. The daemon stayed. This article is about why the tempting "no daemon" version doesn't survive contact with reality, and why the daemon's real job turned out to be smaller than we first thought.

## Every-script-its-own-instance was tempting

The pitch writes itself. Drop the resident process. Each script does:

```ts
using fuji = openFuji();
attachSqlitePersistence(fuji.ydoc, { filePath: '.epicenter/persistence/fuji.db' });
attachSync(fuji.ydoc, { url: 'wss://api.epicenter.so/...' });

fuji.tables.entries.set({ id: 'a', url: '...' });
```

If you've ever debugged a stuck unix socket or a stale pid file, this looks like the right answer. It falls over for one load-bearing reason and one that depends on your workload:

- **SQLite is single-writer.** When SQLite is also where the materializer writes, two Bun processes writing the same file race on WAL checkpoints and the StructStore corrupts. y-sqlite providers serialize the StructStore as atomic blobs, which makes this strictly worse. Turso hit this exact wall and shipped `sqld` so libsql could serve multiple processes safely. Whenever the ecosystem wants multi-process SQLite, the answer keeps coming back as a serializing process. The daemon is one such process; `sqld` is another, just with a different name.

- **Cloud WebSocket fan-out, sometimes.** Ten long-lived peer processes on the same machine means ten WebSocket connections to your sync server. Cloudflare Durable Objects bill per connection, and each open WS pins the DO instance to a colo. For sequential one-shot scripts this is a non-issue: Cloudflare's WebSocket Hibernation API makes idle connections essentially free. For genuinely concurrent or long-lived watchers, you might want one WS per device, not one per shell command. We're not in that workload yet, and we'd reintroduce a hub for that specific case if we got there.

Two reasons that *sound* like daemon arguments but aren't:

- **Cold-start hydrate is not a daemon-IPC win.** A cold script that needs the full Y.Doc pays `Y.applyUpdate` of the whole state regardless of where the bytes come from. Reading 50 MB from local SQLite vs. receiving 50 MB from a daemon over a unix socket is the same order of magnitude (a few ms either way); the dominant cost is the apply, which both paths pay. A daemon does help any peer that already has its own persistence (small state-vector diff over IPC), but a fresh script with no persistence sees no cold-start speedup from talking to a daemon vs. talking to the cloud.

- **clientID accumulation is fixed peer-side, not by the daemon.** Every Y.Doc has a random `clientID`, and every write it performs is tagged with that ID forever. Fresh process per script means fresh random clientID per invocation, ten thousand entries in your state vector after ten thousand runs. The fix is `hashClientId(Bun.main)` (`packages/workspace/src/shared/client-id.ts`): derive a stable 53-bit clientID from the script's entry-point path. Two invocations of the same script reuse the same clientID. This works whether or not there's a daemon; the daemon just gets the same fix for free because daemons have stable identities trivially.

## So we kept the daemon

One daemon per folder. Scoped to that folder, unique to your machine. It owns the SQLite file, holds the Y.Doc in memory, talks to the cloud over a single WebSocket. One key thing changed in our second pass: it does NOT serve a local sync wire. Scripts read its persistence file directly, in read-only mode, and run their own cloud sync.

```
~/projects/fuji/
├── .epicenter/
│   ├── daemon.pid                       (a second daemon refuses to start)
│   ├── daemon.sock                      (typed RPC for /run, optional)
│   ├── persistence/<workspaceId>.db     ← daemon WRITES; scripts READ
│   ├── mirrors/<workspaceId>.db         ← daemon WRITES; scripts READ
│   └── markdown/<workspaceId>/          ← daemon WRITES; scripts READ
└── scripts/
    ├── tag-untagged.ts                  ← peer
    └── export.ts                        ← peer
```

Once you accept the daemon, the interesting question collapses: how do peers talk to it? We tried two answers, then found a third.

## The first two were the wrong question

Our first attempt was JSON-RPC over the unix socket. The script never holds a real Y.Doc. The proxy intercepts every method call and ships it as JSON:

```ts
// JSON-RPC: every call becomes a round trip
const ws = await connectDaemon<Fuji>('fuji');
await ws.tables.entries.set({ id: 'a', url: '...' });
//        ↓ proxy intercepts
//   POST /run { actionPath: 'tables.entries.set', input: {...} }

ws.tables.entries.observe(cb);  // throws RemoteNotSupported
ws.ydoc.getText('readme');      // undefined, ydoc never crossed the wire
```

To make that work, you have to define a parallel API surface (the wire-callable subset) and write machinery to enforce it: branded methods, mapped types, recursive proxies, then-masking, depth-bounded type recursion. Then live with the parts that can't cross a JSON wire at all (`observe`, closure filters, `Y.Text` binding). It's a real tax for the parts that *can* cross, and a hard wall for the parts that can't.

The second attempt was Yjs-sync over the same unix socket. The script holds a real Y.Doc; the wire ships Yjs binary updates. Same protocol the daemon already uses to talk to the cloud, just over a unix socket instead of a WebSocket. We built it: ~3,500 lines of transport code, framing, write queues, server, client, plus tests.

Then we did the math on what it actually bought a one-shot script. It buys a fast warm hydrate for scripts whose state vector is close to the daemon's, plus shared cloud fan-out across local peers. Real, but not 3,500 lines of real. The cold-start argument is the same as a cloud cold start for fresh scripts (`Y.applyUpdate` dominates either way). The fan-out argument fails for one-shot scripts under hibernation. We were paying for transport machinery that was load-bearing for a workload (concurrent long-lived peer watchers) that nobody actually has yet.

The third option is the one we shipped. Scripts read the daemon's persistence file `{ readonly: true }` for warm hydrate, then sync via cloud:

```ts
// Script: read the daemon's persistence file readonly, sync via cloud
export function openFuji({ getToken, absDir }) {
  const fuji = openFujiCore({ clientID: hashClientId(Bun.main) });
  const filePath = persistencePath(absDir ?? findEpicenterDir(), fuji.ydoc.guid);
  const persistence = attachSqliteReadonlyPersistence(fuji.ydoc, { filePath });

  // Swallow MissingFile (no daemon has written here): fall through to cold cloud sync.
  const whenReady = persistence.whenLoaded.catch((err) => {
    if (err?.name !== 'MissingFile') throw err;
  });

  attachSync(fuji, { url: '...', waitFor: whenReady, getToken });
  return { ...fuji, persistence, whenReady };
}
```

The script holds a real Y.Doc. It opens the daemon's persistence file `{ readonly: true }` and replays the existing rows once for warm hydrate. WAL on the writer side means the reader gets a snapshot without `SQLITE_BUSY`. Then it runs its own cloud-sync attachment. The script's writes go through cloud; the daemon (running its own `attachSync`) receives them and persists.

No unix socket, no IPC machinery, no shared sync wire. The script never needs the daemon to be running, but benefits from it if it is.

## The factory shape

Three env factories, one core. Same `openFuji()` core under all three; the `attach*` primitives layer on top.

```ts
// Browser tab: IndexedDB + cloud WS
export function openFuji({ auth, device }) {
  const fuji = openFujiCore();
  const idb = attachIndexedDb(fuji.ydoc);
  attachBroadcastChannel(fuji.ydoc);
  attachSync(fuji, { url, waitFor: idb, device, getToken: () => auth.getToken() });
  return { ...fuji, idb, whenReady: idb.whenLoaded };
}

// Daemon: persistence (sole writer) + cloud WS + materializer projections
export function openFuji({ getToken, device, absDir }) {
  const fuji = openFujiCore();
  const persistence = attachSqlitePersistence(fuji.ydoc, {
    filePath: persistencePath(absDir, fuji.ydoc.guid),
  });
  attachSync(fuji, { url, waitFor: persistence.whenLoaded, device, getToken });
  attachSqliteMaterializer(fuji.ydoc, {
    db: new Database(sqlitePath(absDir, fuji.ydoc.guid)),
    waitFor: persistence.whenLoaded,
  });
  attachMarkdownMaterializer(fuji.ydoc, {
    dir: markdownPath(absDir, fuji.ydoc.guid),
    waitFor: persistence.whenLoaded,
  });
  return { ...fuji, persistence, whenReady: persistence.whenLoaded };
}
```

The browser attaches IndexedDB. The daemon attaches SQLite as sole writer plus the materializer projections. The script attaches a readonly hydrator pointed at the daemon's persistence file. Cloud sync is the only sync wire; everything else is local IO.

The script then looks like any other workspace consumer:

```ts
// vault/scripts/tag-untagged.ts
const fuji = openFuji({ getToken: () => loadToken() });
await fuji.whenReady;

const untagged = fuji.tables.entries
  .filter(e => !e.deletedAt && e.tags.length === 0);

fuji.batch(() => {
  for (const e of untagged) {
    fuji.tables.entries.update(e.id, { tags: ['untagged'] });
  }
});

fuji.tables.entries.observe(ids => console.log('changed:', ids));
```

`observe`, `batch`, `ydoc.getText`: all just work. The daemon is the peer that owns persistence and materializer files; the script is the peer that doesn't. They reconcile through cloud, not through each other.

The daemon's unix socket survives in a smaller role. The `/run` HTTP endpoint serves typed action dispatch from the CLI, scripts, or curl, for callers that want atomic action invocation without booting a Y.Doc. It's optional, opt-out via config, and orthogonal to sync.

## What this buys, plainly

Net deletion: ~4,500 lines of recently-shipped IPC code, tests, and design docs. One transport instead of two; simpler mental model. Scripts get the full Y.Doc API without an IPC dance. The daemon stays for the only two roles where it was actually load-bearing: SQLite single-writer and materializer side-effects.

The mental model collapses to one sentence. Every Epicenter process holds a real workspace. They differ only in which `attach*` primitives carry their bytes. Cloud sync is the wire. The daemon owns the materializer outputs (SQLite mirror, markdown tree); a browser tab owns IndexedDB; a script is short-lived and reads what the daemon wrote. They are all peers.

The daemon was never the accidental complexity. The accidental complexity was the IPC sync wire, sitting in front of cloud sync, doing the same job twice. We dropped the wire. The daemon stayed.
