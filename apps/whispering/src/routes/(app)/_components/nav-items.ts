import HomeIcon from '@lucide/svelte/icons/house';
import ListIcon from '@lucide/svelte/icons/list';
import SettingsIcon from '@lucide/svelte/icons/settings';
import type { Component } from 'svelte';

export type NavItem = {
	label: string;
	href: string;
	icon: Component;
	isActive: (pathname: string) => boolean;
};

/** Matches a route and all its sub-routes (e.g., `/settings` matches `/settings/audio`). */
const matchesRoute = (href: string) => (pathname: string) =>
	pathname === href || pathname.startsWith(`${href}/`);

/**
 * Primary navigation items shared across sidebar and bottom bar layouts.
 *
 * Add new top-level routes here: both `VerticalNav` and `BottomNav` consume
 * this array, so changes propagate automatically.
 */
export const NAV_ITEMS = [
	{
		label: 'Home',
		href: '/',
		icon: HomeIcon,
		isActive: (pathname) => pathname === '/',
	},
	{
		label: 'Recordings',
		href: '/recordings',
		icon: ListIcon,
		isActive: matchesRoute('/recordings'),
	},
	// TODO(wave-3): add a "Formats" nav item once the Formats library page lands.
	// The old "Transformations" item and its route were removed with the
	// Transformation model (ADR 0013).
	{
		label: 'Settings',
		href: '/settings',
		icon: SettingsIcon,
		isActive: matchesRoute('/settings'),
	},
] as const satisfies readonly NavItem[];
