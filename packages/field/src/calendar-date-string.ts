/**
 * @fileoverview `CalendarDateString` branded type and runtime companion.
 *
 * A calendar day string in ISO `YYYY-MM-DD` form. It carries no time, offset, or
 * time zone meaning.
 */

import { Format } from 'typebox/format';
import type { Brand } from 'wellcrafted/brand';

/** Branded ISO calendar date string. */
export type CalendarDateString = string & Brand<'CalendarDateString'>;

export const CalendarDateString = {
	/**
	 * Runtime predicate for ISO calendar dates.
	 */
	is(value: unknown): value is CalendarDateString {
		if (typeof value !== 'string') return false;
		return Format.Test('date', value);
	},

	/**
	 * Today as a local wall-clock calendar day.
	 *
	 * Built from local date components, not `toISOString()`, so the day matches
	 * the user's calendar rather than flipping at the UTC boundary. This is the
	 * companion to `InstantString.now()`: instants are UTC moments, calendar
	 * dates are local days.
	 *
	 * @example `"2026-06-14"`
	 */
	today(): CalendarDateString {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}` as CalendarDateString;
	},
};
