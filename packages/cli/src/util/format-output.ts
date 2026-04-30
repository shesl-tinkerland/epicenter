export const outputFormats = ['json', 'jsonl'] as const;
export type OutputFormat = (typeof outputFormats)[number];

export type OutputConfig = {
	/** Override format (default: json, auto-pretty for TTY) */
	format?: OutputFormat;
};

/** Format a single value as JSON: pretty on TTY unless `format: 'jsonl'`. */
function formatJson(value: unknown, options: OutputConfig = {}): string {
	const shouldPretty =
		options.format !== 'jsonl' && (process.stdout.isTTY ?? false);
	return JSON.stringify(value, null, shouldPretty ? 2 : undefined);
}

/** Format an array as JSONL: one JSON value per line. */
function formatJsonl(values: unknown[]): string {
	return values.map((v) => JSON.stringify(v)).join('\n');
}

/** Output data to stdout with appropriate formatting. */
export function output(value: unknown, options: OutputConfig = {}): void {
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

/** Shared format flag for commands that can emit machine-readable output. */
export const formatArgs = {
	format: {
		type: 'enum',
		options: [...outputFormats] as ['json', 'jsonl'],
		description: 'Output format (default: json, auto-pretty for TTY)',
	},
} satisfies {
	format: {
		type: 'enum';
		options: ['json', 'jsonl'];
		description: string;
	};
};
