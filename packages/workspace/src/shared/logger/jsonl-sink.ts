/**
 * JSONL file sink: Bun/Node-only. One JSON object per line, `\n`-terminated.
 *
 * Caller decides the path. Parent directory is auto-created. Bun's
 * `FileSink` buffers writes; call the sink's `[Symbol.asyncDispose]` (via
 * `await using`) to flush + end at scope exit: otherwise pending writes
 * may be lost on process termination.
 *
 * ```ts
 * await using sink = jsonlFileSink(join(DATA_DIR, 'app.log.jsonl'));
 * const log = createLogger('my-source', sink);
 * ```
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEvent, LogSink } from 'wellcrafted/logger';

function normalizeForJson(value: unknown): unknown {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

function serializeEvent(event: LogEvent): string {
	const { ts, level, source, message, data } = event;
	const line = {
		ts: new Date(ts).toISOString(),
		level,
		source,
		message,
		...(data === undefined ? {} : { data }),
	};
	// The replacer handles native Error instances at every depth: the
	// top-level `data` and any nested `cause`/sub-errors all go through here.
	return `${JSON.stringify(line, (_key, val) => normalizeForJson(val))}\n`;
}

export type DisposableLogSink = LogSink & AsyncDisposable;

export function jsonlFileSink(path: string): DisposableLogSink {
	mkdirSync(dirname(path), { recursive: true });
	const writer = Bun.file(path).writer();
	const write = (event: LogEvent) => {
		writer.write(serializeEvent(event));
	};
	const dispose = async (): Promise<void> => {
		await writer.flush();
		await writer.end();
	};
	return Object.assign(write, {
		[Symbol.asyncDispose]: dispose,
	}) satisfies DisposableLogSink;
}
