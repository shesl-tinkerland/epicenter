/**
 * `epicenter blobs`: trade a file that does not fit in git for a durable
 * content-addressed URL. The sha256 rides inside the URL, so the documents
 * that cite it are the only manifest; nothing is recorded anywhere else.
 *
 *   add <file|url>  upload the bytes (hash -> ticket -> presigned PUT straight
 *                   to the store) and print the URL; writes nothing to disk
 *   ls              list the owner's stored blobs (the store is the index)
 *   get <sha256>    download one blob by content address to a file
 *   rm  <sha256>    delete one blob from the store (breaks every citation)
 *
 * Every subcommand is a direct cloud round-trip built from the resolved machine
 * auth client (the persisted OAuth cell, or a configured instance token for a
 * self-hosted star); none route through the local daemon, unlike `run`. See
 * `docs/adr/0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md`.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as machineAuth from '@epicenter/auth/node';
import { createEpicenterClient, type EpicenterClient } from '@epicenter/client';
import mime from 'mime';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { cmd } from '../util/cmd.js';
import { fail, formatOptions, output } from '../util/format-output.js';

/** A source is fetched when it looks like an http(s) URL, else read from disk. */
const HTTP_URL = /^https?:\/\//i;

const addCommand = cmd({
	command: 'add <source>',
	describe: 'Archive a file or http(s) URL and print its content-addressed URL',
	builder: (yargs) =>
		yargs
			.positional('source', {
				type: 'string',
				demandOption: true,
				describe: 'A local file path or an http(s) URL',
			})
			.option('content-type', {
				type: 'string',
				describe: 'Override the content type (else inferred from the source)',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		// Hold the bytes locally so we hand the SDK a Blob (no second fetch of a
		// URL we already downloaded).
		const { data: resolved, error: resolveError } = await resolveSource(
			argv.source,
			argv.contentType,
		);
		if (resolveError !== null) {
			fail(resolveError);
			return;
		}
		const { bytes, contentType } = resolved;

		const { data: result, error: uploadError } = await epicenter.blobs.add(
			new Blob([new Uint8Array(bytes)], { type: contentType }),
			{ contentType },
		);
		if (uploadError !== null) {
			fail(uploadError.message, { code: 2 });
			return;
		}

		output(
			{ sha256: result.sha256, url: result.url, duplicate: result.duplicate },
			{ format: argv.format },
		);
	},
});

const lsCommand = cmd({
	command: 'ls',
	describe:
		"List the owner's stored blobs (content address, size, upload time)",
	builder: (yargs) => yargs.options(formatOptions).strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { data: blobs, error } = await epicenter.blobs.list();
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}
		output(blobs, { format: argv.format });
	},
});

const rmCommand = cmd({
	command: 'rm <sha256>',
	// Removes the cloud object only; local files are yours to manage. Every
	// document URL citing this hash 404s from now on.
	describe:
		'Delete a blob from the store by content address; every URL citing it breaks forever (idempotent)',
	builder: (yargs) =>
		yargs
			.positional('sha256', {
				type: 'string',
				demandOption: true,
				describe: 'The lowercase-hex sha256 content address',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { error } = await epicenter.blobs.delete(argv.sha256);
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}
		output({ sha256: argv.sha256, deleted: true }, { format: argv.format });
	},
});

const getCommand = cmd({
	command: 'get <sha256>',
	describe: 'Download a blob by content address and write it to a file',
	builder: (yargs) =>
		yargs
			.positional('sha256', {
				type: 'string',
				demandOption: true,
				describe: 'The lowercase-hex sha256 content address',
			})
			.option('output', {
				alias: 'o',
				type: 'string',
				describe: 'Destination path (default: <sha256>.<ext> in the cwd)',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { data: res, error } = await epicenter.blobs.get(argv.sha256);
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}

		const bytes = Buffer.from(await res.arrayBuffer());

		// The store enforces the hash on write, but a download can still be
		// truncated mid-flight; verify before we trust the bytes on disk.
		const actual = sha256Of(bytes);
		if (actual !== argv.sha256) {
			fail(
				`downloaded bytes do not match their content address: expected ${argv.sha256}, got ${actual}`,
				{ code: 2 },
			);
			return;
		}

		// Content type rides on the stored object (pinned at upload), so it names
		// the extension when the caller did not pick an output path.
		const contentType =
			res.headers.get('content-type') ?? 'application/octet-stream';
		const ext = mime.getExtension(contentType);
		const outputPath = path.resolve(
			argv.output ?? (ext ? `${argv.sha256}.${ext}` : argv.sha256),
		);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, bytes);

		output(
			{
				sha256: argv.sha256,
				output: rel(outputPath),
				size_bytes: bytes.byteLength,
				content_type: contentType,
			},
			{ format: argv.format },
		);
	},
});

export const blobsCommand = cmd({
	command: 'blobs <subcommand>',
	describe: 'Archive and retrieve bytes in the content-addressed blob store',
	builder: (yargs) =>
		yargs
			.command(addCommand)
			.command(lsCommand)
			.command(getCommand)
			.command(rmCommand)
			.demandCommand(1, 'Specify a subcommand: add, ls, get, rm'),
	handler: () => {},
});

/**
 * Build the owner-scoped cloud client from the resolved machine auth client, or
 * print a ready-to-read failure and return `null`. Every `blobs` subcommand is a
 * direct cloud round-trip (no daemon), so each one starts here.
 * `resolveMachineAuthClient` settles the credential (OAuth cell or a configured
 * instance token) before returning, so `auth.state` is readable synchronously
 * here; the client is owner-scoped and never re-resolves `/api/session` itself.
 */
async function connectCloud(): Promise<EpicenterClient | null> {
	const { data: auth, error: authError } =
		await machineAuth.resolveMachineAuthClient();
	if (authError) {
		fail(authError.message);
		return null;
	}
	if (auth.state.status === 'signed-out') {
		fail('not signed in: run `epicenter auth login` first');
		return null;
	}
	return createEpicenterClient({
		baseURL: auth.baseURL,
		fetch: (input, init) => auth.fetch(input, init),
		ownerId: auth.state.ownerId,
	});
}

/** The bytes to upload plus the content type that rides with them. */
type ResolvedSource = {
	bytes: Buffer;
	contentType: string;
};

/**
 * Read a source into bytes. An http(s) URL is downloaded (content type from the
 * response); a local path is read (content type inferred from the extension via
 * `mime`). The error channel is a ready-to-print message so the handler has one
 * failure path.
 */
async function resolveSource(
	source: string,
	contentTypeOverride: string | undefined,
): Promise<Result<ResolvedSource, string>> {
	if (HTTP_URL.test(source)) {
		const { data: res, error } = await tryAsync({
			try: () => fetch(source),
			catch: (cause) =>
				Err(`could not fetch ${source}: ${extractErrorMessage(cause)}`),
		});
		if (error !== null) return Err(error);
		if (!res.ok) return Err(`could not fetch ${source}: ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		return Ok({
			bytes,
			contentType:
				contentTypeOverride ??
				res.headers.get('content-type') ??
				'application/octet-stream',
		});
	}

	const localPath = path.resolve(source);
	const { data: bytes, error } = await tryAsync({
		try: () => fs.readFile(localPath),
		catch: (cause) =>
			Err(`could not read ${source}: ${extractErrorMessage(cause)}`),
	});
	if (error !== null) return Err(error);
	return Ok({
		bytes,
		contentType:
			contentTypeOverride ??
			mime.getType(localPath) ??
			'application/octet-stream',
	});
}

/** Lowercase-hex sha256 of bytes, to verify a download against its address. */
function sha256Of(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** A path relative to the cwd, for terse output. */
function rel(p: string): string {
	return path.relative(process.cwd(), p);
}
