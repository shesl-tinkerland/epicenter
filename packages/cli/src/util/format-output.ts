export type FormatOptions = {
	/**
	 * Machine-readable output mode. Omit for human text (callers render
	 * their own tree/table). `json` is a single document (pretty on TTY,
	 * compact when piped). `jsonl` is one JSON value per line.
	 */
	format?: 'json' | 'jsonl';
};

/** Format a single value as JSON: pretty on TTY unless `format: 'jsonl'`. */
function formatJson(value: unknown, options: FormatOptions = {}): string {
	const shouldPretty =
		options.format !== 'jsonl' && (process.stdout.isTTY ?? false);
	return JSON.stringify(value, null, shouldPretty ? 2 : undefined);
}

/** Format an array as JSONL: one JSON value per line. */
function formatJsonl(values: unknown[]): string {
	return values.map((v) => JSON.stringify(v)).join('\n');
}

/** Output data to stdout with appropriate formatting. */
export function output(value: unknown, options: FormatOptions = {}): void {
	if (options.format === 'jsonl') {
		if (!Array.isArray(value)) {
			throw new Error('JSONL format requires an array value');
		}
		console.log(formatJsonl(value));
	} else {
		console.log(formatJson(value, options));
	}
}

/**
 * Output an error message to stderr
 */
export function outputError(message: string): void {
	console.error(message);
}

/**
 * Yargs options shared by every command that emits structured data
 * (`list`, `run`, `peers`).
 *
 * Three output modes:
 *   - omitted:   human text. Tree / table / formatted message; the default
 *                because the CLI's primary user is a person reading stdout.
 *   - `json`:    one JSON document. Pretty-printed on a TTY (eyeballable),
 *                compact when piped (small, fast for `jq`).
 *   - `jsonl`:   one JSON value per line. For line-oriented Unix tools
 *                (`grep`, `fzf`, `xargs`, `while read`) where a single
 *                document is unwieldy.
 *
 * Anything more elaborate (filtering, fan-out, joins) belongs in a `.ts`
 * script that imports `epicenter.config.ts` directly. See the CLI
 * scripting-first redesign spec.
 */
export function formatYargsOptions() {
	return {
		format: {
			type: 'string' as const,
			choices: ['json', 'jsonl'] as const,
			description:
				'Machine-readable output. Omit for human text; `json` for one document (pipe to jq); `jsonl` for one record per line (pipe to fzf/grep/xargs).',
		},
	};
}
