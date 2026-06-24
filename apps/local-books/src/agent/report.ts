/**
 * `books_report`: the live computed-report tool (ADR-0047). Where `books_sql_query`
 * answers row-level questions off the local mirror, this answers whole-ledger
 * questions QuickBooks owns the *computation* of (P&L, balance sheet, cash flow,
 * aging, trial balance).
 *
 * These are read LIVE from the QuickBooks Reports API, never mirrored and never
 * cached: there is no CDC for reports, so a cached copy would be a stale snapshot.
 * The mirror holds the facts; QuickBooks computes the opinions. A report is one
 * cheap call asked a few times a day, so live is both correct and affordable.
 *
 * It is a `query` (auto-approved): a read, even though it crosses to the API.
 */

import { defineQuery } from '@epicenter/workspace';
import { Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok } from 'wellcrafted/result';
import type { OpenQbClient } from './qb-access.ts';

export const ReportError = defineErrors({
	Unavailable: ({ detail }: { detail: string }) => ({
		message: `Reports are unavailable: ${detail}`,
		detail,
	}),
});
export type ReportError = InferErrors<typeof ReportError>;

const ReportInput = Type.Object({
	report: Type.Union(
		[
			Type.Literal('ProfitAndLoss'),
			Type.Literal('BalanceSheet'),
			Type.Literal('CashFlow'),
			Type.Literal('AgedReceivables'),
			Type.Literal('AgedPayables'),
			Type.Literal('TrialBalance'),
		],
		{
			description:
				'Which QuickBooks report to run live. Use ProfitAndLoss for burn/net income, BalanceSheet for position, CashFlow for cash, AgedReceivables/AgedPayables for who owes whom, TrialBalance for the raw account balances.',
		},
	),
	start_date: Type.Optional(
		Type.String({
			description: 'Report period start, YYYY-MM-DD (QuickBooks `start_date`).',
		}),
	),
	end_date: Type.Optional(
		Type.String({
			description: 'Report period end, YYYY-MM-DD (QuickBooks `end_date`).',
		}),
	),
	accounting_method: Type.Optional(
		Type.Union([Type.Literal('Cash'), Type.Literal('Accrual')], {
			description:
				'Cash or Accrual basis; QuickBooks defaults to the company setting.',
		}),
	),
});

/** Build the `books_report` action; `openQb` opens the live QuickBooks client. */
export function createReportAction({ openQb }: { openQb: OpenQbClient }) {
	return defineQuery({
		title: 'Run a QuickBooks report',
		description:
			'Get an authoritative computed financial statement LIVE from QuickBooks ' +
			'(profit & loss, balance sheet, cash flow, A/R & A/P aging, trial balance). ' +
			'Use this for whole-ledger totals (burn, net income, runway, what is owed); ' +
			'use `books_sql_query` for row-level detail off the local mirror.',
		input: ReportInput,
		handler: async (input) => {
			const { data: qb, error: openError } = await openQb();
			if (openError !== null) {
				return ReportError.Unavailable({ detail: openError });
			}
			const params: Record<string, string> = {};
			if (input.start_date) params.start_date = input.start_date;
			if (input.end_date) params.end_date = input.end_date;
			if (input.accounting_method)
				params.accounting_method = input.accounting_method;

			const { data, error } = await qb.report(input.report, params);
			if (error) return Err(error);
			return Ok({ report: input.report, data });
		},
	});
}
