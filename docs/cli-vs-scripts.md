# CLI vs scripts

Epicenter is a TypeScript library first; the CLI is a thin shell wrapper around it. When you're deciding whether to reach for `epicenter <command>` or write a `bun script.ts`, this is the rule.

## The principle

> **Scripts are the primary API. The CLI exists for two narrow cases: shell pipes and pre-workspace bootstrap.**

Bun is the assumed runtime everywhere Epicenter runs. If you're using Epicenter, you're already in a TypeScript / Bun environment. That makes scripts a 30-second affair, not a learning curve.

## The CLI surface, in scope

| Command   | Purpose                                                       | Scope                                |
|-----------|---------------------------------------------------------------|--------------------------------------|
| `auth`    | Pre-workspace session bootstrap                               | Bootstrap; legitimately shell-shaped |
| `list`    | Discovery: tree of available actions                          | Discovery; cheap to keep             |
| `peers`   | Discovery: who's connected right now                          | Discovery; cheap to keep             |
| `run`     | Invoke a single action; pipe its JSON output to shell tools   | Shell-pipe positioning               |
| `serve`   | Foreground long-lived workspace process (one socket per dir)  | Run a workspace as a process         |

That's it. New verbs that wrap workspace functionality don't get added.

## What the CLI is NOT for

If you're tempted to reach for the CLI for any of the following, write a script instead:

```bash
# bad: not actually using the shell, just running an action
$ epicenter run savedTabs.create '{"url":"...","title":"..."}'

# bad: trying to do logic in the shell
$ if [ "$(epicenter run sync.status | jq -r '.connected')" = "true" ]; then ...

# bad: fan-out coordination
$ for peer in $(epicenter run sync.peers | jq -r '.[].deviceId'); do
    epicenter run sync.status --peer "$peer"
  done
```

Each of these reinvents control flow that TypeScript already has.

## What `epicenter run` IS for

Genuine shell-pipe shapes — your shell composes the result with other tools:

```bash
$ epicenter run sync.status | jq '.peers[]'
$ epicenter run savedTabs.list | grep "github.com" | wc -l
$ epicenter run savedTabs.list > tabs-backup.json
$ epicenter run sync.status --peer device-mac | tee mac-status.json
```

The test: **if removing the pipe makes the example pointless, it belongs as a CLI invocation. Otherwise, write a script.**

## Side-by-side examples

### Invoke an action

```bash
# CLI: only when you're piping to shell tools
$ epicenter run savedTabs.list | jq '.[].url'
```

```ts
// script: anything else
import { connectWorkspace } from '@epicenter/cli';
import { createMyWorkspace } from './workspace.ts';

const ws = await connectWorkspace(createMyWorkspace);
const tabs = await ws.actions.savedTabs.list();
console.log(tabs.map(t => t.url));
```

```bash
$ bun script.ts
```

### Wait for a peer and dispatch

```ts
// script: this isn't a CLI shape at all
import { connectWorkspace } from '@epicenter/cli';

const ws = await connectWorkspace(createMyWorkspace);
const result = await ws.sync.waitForPeer('device-mac', { timeoutMs: 5000 });
if (result.error) {
  console.error('peer miss:', result.error.peerTarget);
  process.exit(3);
}
const { clientId } = result.data;
await ws.sync.rpc(clientId, 'tabs.close', { ids: [1] });
```

### Fan out across peers

```ts
// script: the CLI deliberately doesn't grow flags for this
import { connectWorkspace } from '@epicenter/cli';

const ws = await connectWorkspace(createMyWorkspace);
const peers = [...ws.sync.peers().values()];
const statuses = await Promise.all(
  peers.map(p => ws.sync.rpc(p.clientId, 'sync.status', undefined)),
);
console.log(statuses);
```

### Run a long-lived workspace process

```bash
# CLI shorthand: foreground, manage with shell
$ epicenter serve

# you control backgrounding
$ epicenter serve > epicenter.log 2>&1 &
$ epicenter serve  # in tmux / systemd / etc.
```

```ts
// script: when you need custom lifecycle (watchers, periodic jobs)
import { connectWorkspace } from '@epicenter/cli';

const ws = await connectWorkspace(createMyWorkspace);

ws.tables.events.observe((change) => {
  // your domain-specific reaction
});

setInterval(() => doSomething(ws), 60_000);

process.on('SIGINT', async () => {
  await ws[Symbol.dispose]();
  process.exit(0);
});
```

`epicenter serve` is a convenience wrapper around exactly this pattern: load workspace, attach sync, park until SIGINT. Skip it the moment you need any logic of your own.

## What we deliberately ruled out

These are NOT future moves; the script-first principle says no:

- **Adding `--repeat`, `--all-peers`, `--if-then` flags to `run`.** Those are scripting concerns; live in user scripts.
- **Auto-printing action results in a "smart" format (table, tree, etc).** `--format json/jsonl` is the only interchange.
- **Generating CLI subcommands from action schemas.** TypeScript autocomplete in your IDE is better than any tab completion will ever be.
- **Caching daemon responses in the CLI.** The `serve` process already amortizes; another cache layer is misplaced.

## Why this works

A bun runtime is a real prerequisite, but it self-selects: anyone using Epicenter is already a TypeScript developer running Bun. Pretending the CLI is the front door creates a worse front door than the language itself.
