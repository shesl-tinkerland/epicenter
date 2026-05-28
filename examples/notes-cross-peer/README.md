# notes-cross-peer

Two-peer minimal repro for the `system.describe` cross-peer fetch.

Both project configs default-export a `notes` mount from `workspaces/notes/daemon.ts`. `Mount.name` is the canonical CLI prefix. The two mount modules construct the same workspace (`epicenter.notes-repro`) with distinct peer ids, so each appears in the other's awareness.

This example runs one daemon process per project directory. In a normal project, one daemon can host many mounts (default-export `Mount[]`). This repro keeps peer-a and peer-b in separate project directories so they behave like two different machines.

Exercises `createRemoteClient({ awareness, rpc }).describe(peerId)` end-to-end against the deployed API.

## Setup

```bash
bun install                       # picks up the new workspace package
bun x epicenter auth login        # one-time, https://api.epicenter.so
```

## Run

**Terminal 1**: bring peer-a online as a long-lived peer (Ctrl-C to stop):

```bash
bun x epicenter daemon up -C examples/notes-cross-peer/peer-a
```

**Terminal 2**: bring peer-b online too, then dispatch via its daemon to peer-a:

```bash
bun x epicenter daemon up -C examples/notes-cross-peer/peer-b &
bun x epicenter peers -C examples/notes-cross-peer/peer-b
bun x epicenter run notes.notes.add --peer notes-repro-peer-a '{"body":"from peer-b"}' -C examples/notes-cross-peer/peer-b
```

To inspect peer-a's full action manifest from peer-b, write a script
(the CLI no longer offers a flag for this; use the scripting API in
`packages/cli/README.md` for local daemon calls):

```ts
// examples/notes-cross-peer/inspect-peer.ts
import { createRemoteClient } from '@epicenter/workspace';
import { openNotes } from './notes';

using notes = openNotes({
	id: 'notes-repro-inspector',
	name: 'Inspector',
	platform: 'node',
});

await notes.whenReady;
const remote = createRemoteClient({
	awareness: notes.awareness,
	rpc: notes.rpc,
});
const result = await remote.describe('notes-repro-peer-a');
console.log(result.error ?? result.data);
```

```bash
bun run examples/notes-cross-peer/inspect-peer.ts
```

## What confirms it works

- `peers` lists `notes-repro-peer-a`, so awareness round-tripped through the API.
- `inspect-peer.ts` prints peer-a's manifest with `notes.add` and its input shape, so `system.describe()` carries the schema.
- `run notes.notes.add --peer notes-repro-peer-a` succeeds, so cross-peer dispatch uses the same RPC channel.

## What confirms it broke

- `ActionNotFound: system.describe` means injection didn't land.
- `inspect-peer.ts` returns `PeerNotFound` means awareness never propagated.
- `inspect-peer.ts` hangs or times out means manifest fetch isn't completing.
