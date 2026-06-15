import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/constants/apps';

const apiRoot = resolve(import.meta.dir, '..');
const dashboardBuild = resolve(apiRoot, 'ui/build/dashboard');
const devVars = resolve(apiRoot, '.dev.vars');

// The dashboard SPA is built into apps/api/ui/build/dashboard/ (SvelteKit
// adapter-static + paths.base='/dashboard'). Wrangler errors if its assets
// directory does not exist, even when the dashboard has not been built yet.
await mkdir(dashboardBuild, { recursive: true });

// Keep local secrets in Infisical, not a checked-out .dev.vars file. Wrangler's
// `secrets.required` support reads required secrets from process.env during
// local dev; removing stale .dev.vars keeps that source unambiguous.
await rm(devVars, { force: true });

const auth = await Bun.$`infisical --silent user get token --plain`
	.quiet()
	.nothrow();

if (auth.exitCode !== 0 || !auth.stdout.toString().trim()) {
	console.error('Not logged into Infisical.');
	console.error(
		'Running `apps/api` requires Infisical access for dev secrets (API keys, auth secret).',
	);
	console.error('Run `infisical login`, then rerun the same command.');
	console.error(
		'If you do not have Infisical access, see CONTRIBUTING.md for what you can work on without it.',
	);
	process.exit(1);
}

const wrangler =
	await Bun.$`infisical run --silent --env=dev --path=/api -- bun x wrangler dev --var ${`API_PUBLIC_ORIGIN:${localUrl(APPS.API)}`}`
		.cwd(apiRoot)
		// Dev narrows the public auth origin to localhost. Required auth
		// bindings, including GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, come
		// from Infisical's dev environment through process.env.
		.nothrow();

process.exit(wrangler.exitCode);
