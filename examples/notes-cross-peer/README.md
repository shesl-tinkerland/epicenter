# notes-cross-peer

Two-peer minimal repro for the `system.describe` cross-peer fetch.

Both configs construct the same workspace (`epicenter.notes-repro`) with
distinct deviceIds, so each appears in the other's awareness. Exercises
`describePeer(sync, deviceId)` end-to-end against the deployed API.

## Setup

```bash
bun install                       # picks up the new workspace package
bun x epicenter auth login        # one-time, https://api.epicenter.so
```

## Run

**Terminal 1** — bring peer-a online as a long-lived peer (Ctrl-C to stop):

```bash
bun x epicenter serve --dir examples/notes-cross-peer/peer-a
```

**Terminal 2** — bring peer-b online too, then dispatch via its daemon to peer-a:

```bash
bun x epicenter serve --dir examples/notes-cross-peer/peer-b &
bun x epicenter peers --dir examples/notes-cross-peer/peer-b
bun x epicenter run notes.add --dir examples/notes-cross-peer/peer-b --peer notes-repro-peer-a '{"body":"from peer-b"}'
```

To inspect peer-a's full action manifest from peer-b, write a script
(the CLI no longer offers a flag for this — see `packages/cli/README.md`
under "Local vs. remote"):

```ts
// examples/notes-cross-peer/inspect-peer.ts
import { describePeer } from '@epicenter/workspace';
import { notes } from './peer-b/epicenter.config';

await notes.whenReady;
const result = await describePeer(notes.sync, 'notes-repro-peer-a');
console.log(result.error ?? result.data);
notes.dispose();
```

```bash
bun run examples/notes-cross-peer/inspect-peer.ts
```

## What confirms it works

- `peers` lists `notes-repro-peer-a` → awareness round-tripped through the API
- `inspect-peer.ts` prints peer-a's manifest with `notes.add` and its input shape → `system.describe()` carries the schema
- `run --peer notes-repro-peer-a notes.add` succeeds → cross-peer dispatch through the same RPC channel

## What confirms it broke

- `ActionNotFound: system.describe` → injection didn't land
- `inspect-peer.ts` returns `RpcError.PeerNotFound` → awareness never propagated
- `inspect-peer.ts` hangs or times out → manifest fetch isn't completing
