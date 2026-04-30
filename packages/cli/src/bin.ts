#!/usr/bin/env bun

import { createCLI } from './cli';

try {
	await createCLI().run(process.argv.slice(2));
} catch (error) {
	console.error('Error:', String(error));
	process.exit(1); // usage (see README: Exit codes)
}
