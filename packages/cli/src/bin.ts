#!/usr/bin/env bun

import { runCli } from './cli';

try {
	await runCli(process.argv.slice(2));
} catch (error) {
	console.error('Error:', String(error));
	process.exit(1); // usage (see README: Exit codes)
}
