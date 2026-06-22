import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from './config.ts';

/**
 * A minimal secret store keyed by `realmId`. The OAuth token set is serialized
 * to JSON and stored here, never in the data dir. Backends: the macOS login
 * keychain, the Linux Secret Service (`secret-tool`), an opt-in plaintext file
 * (`LOCAL_BOOKS_KEYRING_FILE`, for CI and headless boxes without a keyring
 * daemon), and an in-memory store for tests.
 *
 * Backend failures throw: a missing keychain daemon is fatal and rare, so it
 * bubbles to the top-level CLI handler rather than threading a Result through
 * every caller.
 */
export type Keyring = {
	readonly backend: string;
	get(account: string): Promise<string | null>;
	set(account: string, secret: string): Promise<void>;
	delete(account: string): Promise<void>;
};

const SERVICE = 'local-books';

async function run(
	cmd: string[],
	options: { stdin?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		stdin: options.stdin ? new TextEncoder().encode(options.stdin) : 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** macOS login keychain via the `security` CLI. */
function createMacosKeyring(): Keyring {
	return {
		backend: 'macos-keychain',
		async get(account) {
			const { exitCode, stdout } = await run([
				'security',
				'find-generic-password',
				'-s',
				SERVICE,
				'-a',
				account,
				'-w',
			]);
			// 44 = errSecItemNotFound. Anything else printed nothing useful.
			if (exitCode === 44) return null;
			if (exitCode !== 0) return null;
			const value = stdout.replace(/\n$/, '');
			return value.length > 0 ? value : null;
		},
		async set(account, secret) {
			const { exitCode, stderr } = await run([
				'security',
				'add-generic-password',
				'-U', // update if it already exists
				'-s',
				SERVICE,
				'-a',
				account,
				'-w',
				secret,
			]);
			if (exitCode !== 0) {
				throw new Error(
					`security add-generic-password failed: ${stderr.trim()}`,
				);
			}
		},
		async delete(account) {
			await run([
				'security',
				'delete-generic-password',
				'-s',
				SERVICE,
				'-a',
				account,
			]);
		},
	};
}

/** Linux Secret Service via `secret-tool` (libsecret). */
function createSecretToolKeyring(): Keyring {
	const attrs = (account: string) => ['service', SERVICE, 'account', account];
	return {
		backend: 'secret-tool',
		async get(account) {
			const { exitCode, stdout } = await run([
				'secret-tool',
				'lookup',
				...attrs(account),
			]);
			if (exitCode !== 0) return null;
			const value = stdout.replace(/\n$/, '');
			return value.length > 0 ? value : null;
		},
		async set(account, secret) {
			const { exitCode, stderr } = await run(
				[
					'secret-tool',
					'store',
					'--label',
					`${SERVICE} ${account}`,
					...attrs(account),
				],
				{ stdin: secret },
			);
			if (exitCode !== 0) {
				throw new Error(`secret-tool store failed: ${stderr.trim()}`);
			}
		},
		async delete(account) {
			await run(['secret-tool', 'clear', ...attrs(account)]);
		},
	};
}

/**
 * Plaintext JSON-file store. Opt-in only (`LOCAL_BOOKS_KEYRING_FILE`); for CI,
 * headless boxes without a keyring daemon, and the test harness. The file is
 * `0600` but the secret is not encrypted.
 */
export function createFileKeyring(filePath: string): Keyring {
	const load = (): Record<string, string> => {
		try {
			const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
			return typeof parsed === 'object' && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	};
	const save = (map: Record<string, string>) => {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(map, null, 2));
		chmodSync(filePath, 0o600);
	};
	return {
		backend: 'file',
		async get(account) {
			return load()[account] ?? null;
		},
		async set(account, secret) {
			const map = load();
			map[account] = secret;
			save(map);
		},
		async delete(account) {
			const map = load();
			delete map[account];
			save(map);
		},
	};
}

/** Process-lifetime in-memory store, for tests. */
export function createMemoryKeyring(): Keyring {
	const map = new Map<string, string>();
	return {
		backend: 'memory',
		async get(account) {
			return map.get(account) ?? null;
		},
		async set(account, secret) {
			map.set(account, secret);
		},
		async delete(account) {
			map.delete(account);
		},
	};
}

export function createKeyring(config: Pick<AppConfig, 'keyringFile'>): Keyring {
	if (config.keyringFile) return createFileKeyring(config.keyringFile);
	if (process.platform === 'darwin') return createMacosKeyring();
	if (process.platform === 'linux') return createSecretToolKeyring();
	throw new Error(
		'No OS keyring backend for this platform. Set LOCAL_BOOKS_KEYRING_FILE to use a file-backed token store.',
	);
}
