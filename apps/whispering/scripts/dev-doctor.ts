#!/usr/bin/env bun
/**
 * Diagnose the macOS dev Accessibility identity in one command:
 *
 *   bun run dev:doctor
 *
 * It reports the STATIC identity facts that decide whether the TCC grant will
 * stick: where the dev binary is, its code-signing Identifier and authority,
 * whether that matches the dev identifier, and the reset command to copy. The
 * LIVE facts (AXIsProcessTrusted, the current DictationCapability, the rdev
 * listener's last stop reason) are owned by the running app's Rust supervisor
 * and surface in the app itself plus the Tauri log, so this script points there
 * rather than guessing them from outside the process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_TAURI = join(import.meta.dir, '..', 'src-tauri');

function run(command: string, args: string[]): string {
	const result = Bun.spawnSync([command, ...args]);
	return (
		new TextDecoder().decode(result.stdout) +
		new TextDecoder().decode(result.stderr)
	).trim();
}

function readDevIdentity(): { identifier: string; productName: string } {
	const config = JSON.parse(
		readFileSync(join(SRC_TAURI, 'tauri.dev.conf.json'), 'utf8'),
	);
	return { identifier: config.identifier, productName: config.productName };
}

const { identifier: expectedIdentifier, productName } = readDevIdentity();

console.log('Whispering dev Accessibility doctor');
console.log('==================================');
console.log(`platform:           ${process.platform}`);
console.log(`expected identifier: ${expectedIdentifier}`);
console.log(`expected name:       ${productName}`);

if (process.platform !== 'darwin') {
	console.log('\nNot macOS: no Accessibility/TCC identity to check.');
	process.exit(0);
}

const binary = join(SRC_TAURI, 'target', 'debug', 'whispering');
console.log(`\ndev binary:         ${binary}`);
if (!existsSync(binary)) {
	console.log('  (not built yet — run `bun run dev:local` first)');
	process.exit(0);
}

const codesign = run('codesign', ['-dv', '--verbose=2', binary]);
const identifierLine = codesign.match(/^Identifier=(.*)$/m)?.[1] ?? '(none)';
const authority = codesign.match(/^Authority=(.*)$/m)?.[1] ?? '(none)';
const flags = codesign.match(/flags=(\S+)/)?.[1] ?? '(none)';

console.log(`  signed Identifier: ${identifierLine}`);
console.log(`  authority:         ${authority}`);
console.log(`  flags:             ${flags}`);

const isAdhoc = /adhoc/.test(flags);
const identifierMatches = identifierLine === expectedIdentifier;

console.log('\nverdict:');
if (isAdhoc) {
	console.log(
		'  ✗ ad-hoc signature — the grant will NOT survive rebuilds. Install a',
	);
	console.log(
		'    codesigning cert or set WHISPERING_DEV_SIGNING_IDENTITY, then rebuild.',
	);
} else if (!identifierMatches) {
	console.log(
		`  ✗ signed identifier is "${identifierLine}", expected "${expectedIdentifier}".`,
	);
	console.log(
		'    The runner may not be wired in; re-run `bun run dev:local`.',
	);
} else {
	console.log(
		'  ✓ stable signature with the dev identifier. Grant should persist.',
	);
}

console.log('\navailable codesigning identities:');
console.log(
	`  ${run('security', ['find-identity', '-v', '-p', 'codesigning']).replace(/\n/g, '\n  ')}`,
);

console.log(
	'\nreset the dev grant (after the app has launched at least once):',
);
console.log(`  tccutil reset Accessibility ${expectedIdentifier}`);
console.log('  then relaunch dev and grant the new Accessibility entry.');

console.log('\nlive trust / capability / listener health:');
console.log(
	'  shown in the app (DictationCapability) and the Tauri log; the Rust',
);
console.log('  supervisor in src-tauri/src/keyboard/mod.rs owns those values.');
