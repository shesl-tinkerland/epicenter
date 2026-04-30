---
name: logging
description: Use `wellcrafted/logger` for structured library-side diagnostics. 5 levels (trace/debug/info/warn/error), typed errors on warn/error, DI-only sink. Use when wiring a new attach primitive, adding a background error path, or setting up a file-backed log. Do NOT use `console.*` in library code.
metadata:
  author: epicenter
  version: '2.0'
---

# Workspace Logger

Structured, level-keyed, field-oriented logging for library code. Modeled on Rust's `tracing`. Completes the `defineErrors` story: errors are structured data; level lives at the call site.

## Where it lives

The core (`createLogger`, `consoleSink`, `memorySink`, `composeSinks`, `tapErr`, and their types) ships from **`wellcrafted/logger`** — runtime-agnostic, browser-safe. The Bun-only `jsonlFileSink` + `DisposableLogSink` ship from **`@epicenter/workspace`** because they need `Bun.file(path).writer()` and `node:fs`.

## Quickstart

```ts
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('markdown-materializer'); // defaults to consoleSink

log.info('materializer ready');
log.warn(MarkdownError.TableWrite({ path, cause }));
```

## The 5 levels

`trace | debug | info | warn | error`. No `fatal` — process termination is the app's call, not the library's.

| Level | Signature | Use for |
|---|---|---|
| `trace` | `(message, data?)` | Per-token / per-message noise; off in prod |
| `debug` | `(message, data?)` | Internal state transitions (handshakes, cache loads) |
| `info`  | `(message, data?)` | Lifecycle events (connected, loaded, flushed) |
| `warn`  | `(err)` | Recoverable failure — retry, fallback, partial result |
| `error` | `(err)` | Unrecoverable at this layer; the operation has given up |

**Shape split is intentional.** `warn` / `error` take a typed error unary — the variant carries `message`, `name`, and captured fields. `trace` / `debug` / `info` are free-form because free-running diagnostic events don't need enumeration.

## Level is a call-site decision, not a variant property

```ts
// Right — same error, different levels in different contexts
log.warn(SyncError.ConnectionFailed({ cause }));  // inside retry loop
log.error(SyncError.ConnectionFailed({ cause })); // last attempt, giving up
```

Do NOT attach a `severity` to `defineErrors` variants. That's `miette`'s pattern; `tracing`, `log`, and every production Rust logger put level on the call. Context-dependent data belongs at the context.

## Sinks

A sink is `((event) => void) & Partial<AsyncDisposable>` — a callable with optional resource cleanup.

```ts
// Core — runtime-agnostic, browser-safe
import {
  createLogger,
  consoleSink,    // default; mirrors old console.* behavior
  memorySink,     // for tests; returns { sink, events }
  composeSinks,   // fan out to multiple sinks
  tapErr,         // Result-flow combinator
} from 'wellcrafted/logger';

// Bun-only file sink — ships from the workspace package because it needs
// `Bun.file(path).writer()` and `node:fs`
import { jsonlFileSink } from '@epicenter/workspace';
```

### `jsonlFileSink(path)` — Bun-only

Streamed append via Bun's `FileSink`. Parent directory auto-created. The returned sink implements `[Symbol.asyncDispose]` (flush + end the writer), so bind it with `await using`:

```ts
await using sink = jsonlFileSink(join(DATA_DIR, 'app.log.jsonl'));
const log = createLogger('attachSync', sink);
// ... do work ...
// scope exit → flush + close the writer
```

Without `await using`, buffered writes can be lost on abrupt termination. **Never** skip the dispose binding.

### `composeSinks(...)` — fan out

```ts
await using file = jsonlFileSink(path);
const sink = composeSinks(consoleSink, file);
const log = createLogger('source', sink);
```

`composeSinks` forwards disposal to members that implement it (via `sink[Symbol.asyncDispose]?.()`). `consoleSink` is a no-op on dispose; file/network sinks flush and close.

### `memorySink()` — for tests

```ts
const { sink, events } = memorySink();
const log = createLogger('test', sink);
log.warn(MyError.Thing({ cause: new Error('boom') }));
expect(events).toHaveLength(1);
expect(events[0]).toMatchObject({ level: 'warn', source: 'test' });
```

Do NOT assert on `console.*` output. Inject a `memorySink` and inspect the event array.

## `tapErr` — the Result-flow combinator

`tapErr(logFn)` logs on the Err branch and returns the Result unchanged. Takes a log *method*, not a whole logger, so the caller picks the level at the pipeline site.

```ts
const result = await tryAsync({
  try: () => writeTable(path),
  catch: (cause) => MarkdownError.TableWrite({ path, cause }),
}).then(tapErr(log.warn));
```

Mirrors Rust's `.inspect_err` and Effect's `tapErrorCause`. No message argument — the typed error owns its message.

## DI, not globals

No module-level logger registry. No `setDefaultLogger()`. Each attach primitive takes an optional `log?: Logger` option and defaults to `createLogger(<source>)` (console sink). Caller wires sinks explicitly.

```ts
const markdown = attachMarkdown(ydoc, { dir, log });
const sqlite   = attachSqlite(ydoc, { db, log });
const sync     = attachSync(ydoc, { url, log });
```

Share one sink across loggers (avoids interleaved writes on the same file):

```ts
await using fileSink = jsonlFileSink(path);
const sink = composeSinks(consoleSink, fileSink);
const markdown = attachMarkdown(ydoc, { dir, log: createLogger('markdown', sink) });
const sqlite   = attachSqlite(ydoc, { db, log: createLogger('sqlite', sink) });
```

## Browser

`createLogger` + `consoleSink` + `memorySink` + `composeSinks` + `tapErr` are pure JS, browser-safe. `jsonlFileSink` is Bun-only (uses `Bun.file(path).writer()` + `node:fs`) — browser apps just don't import it.

## Event shape

Every sink receives:

```ts
type LogEvent = {
  ts:      number;    // epoch millis
  level:   LogLevel;  // 'trace' | 'debug' | 'info' | 'warn' | 'error'
  source:  string;    // from createLogger()
  message: string;    // human text — for warn/error, inherited from the typed error
  data?:   unknown;   // the typed error for warn/error; free-form for info/debug/trace
};
```

JSONL sink converts `ts` to ISO-8601 on the wire and flattens native `Error` instances to `{name, message, stack}` so they don't serialize to `{}`.

## See also

- `error-handling` skill — the `tryAsync.catch:` → `tapErr(log.warn)` pipeline
- `define-errors` skill — how to mint the typed error variants the logger consumes
- `rust-errors` skill — full `tracing` ↔ `Logger` mapping
