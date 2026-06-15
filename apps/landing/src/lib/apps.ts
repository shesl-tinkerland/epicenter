// The Epicenter app ecosystem. Single source of truth for the switcher nav,
// the home page tiles, and each app's own page. Adding an app is one entry
// here plus a routed page at /<slug>; the shell does not change.
//
// `status` is the honesty gate. It must be provable in the repo:
//   live        installable through a normal release channel
//   in-progress code exists, built in public, not yet a shipped product
//   planned     announced direction, no code yet
// Exactly one app may be `live` at a time (the single download anchor).

export type AppStatus = 'live' | 'in-progress' | 'planned';

export type AppEntry = {
	slug: string;
	name: string;
	/** One line, for the tile and the page header. */
	tagline: string;
	status: AppStatus;
	/** Resolved by AppIcon.astro. */
	icon: 'mic' | 'notebook-pen' | 'languages';
	/** Internal route. */
	href: string;
	/** Source folder on GitHub, for "follow the build". */
	repo: string;
	/** The featured app, shown first and anchored as "start here". */
	featured?: boolean;
};

const GITHUB = 'https://github.com/EpicenterHQ/epicenter/tree/main/apps';

export const APPS: AppEntry[] = [
	{
		slug: 'whispering',
		name: 'Whispering',
		tagline: 'Talk instead of type. The words land wherever your cursor is.',
		status: 'live',
		icon: 'mic',
		href: '/whispering',
		repo: `${GITHUB}/whispering`,
		featured: true,
	},
	{
		slug: 'honeycrisp',
		name: 'Honeycrisp',
		tagline: 'Notes that work offline and sync when they can.',
		status: 'in-progress',
		icon: 'notebook-pen',
		href: '/honeycrisp',
		repo: `${GITHUB}/honeycrisp`,
	},
	{
		slug: 'vocab',
		name: 'Vocab',
		tagline: 'Build your vocabulary in any language, a word at a time.',
		status: 'in-progress',
		icon: 'languages',
		href: '/vocab',
		repo: `${GITHUB}/zhongwen`,
	},
];

export const STATUS_LABEL: Record<AppStatus, string> = {
	live: 'Live',
	'in-progress': 'In progress',
	planned: 'Planned',
};

export const getApp = (slug: string): AppEntry | undefined =>
	APPS.find((app) => app.slug === slug);
