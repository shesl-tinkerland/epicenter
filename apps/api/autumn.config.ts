import { feature, item, plan } from 'atmn';
import {
	ANNUAL_PLANS,
	FEATURE_IDS,
	PLAN_IDS,
	PLANS,
} from './src/billing-plans';

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export const aiUsage = feature({
	id: FEATURE_IDS.aiUsage,
	name: 'AI Usage',
	type: 'metered',
	consumable: true,
});

export const aiCredits = feature({
	id: FEATURE_IDS.aiCredits,
	name: 'AI Credits',
	type: 'credit_system',
	creditSchema: [{ meteredFeatureId: aiUsage.id, creditCost: 1 }],
});

// ---------------------------------------------------------------------------
// Plans — Monthly
// ---------------------------------------------------------------------------

const f = PLANS[PLAN_IDS.free];
export const free = plan({
	id: PLAN_IDS.free,
	name: f.name,
	group: f.group,
	autoEnable: f.autoEnable,
	items: [
		item({
			featureId: aiCredits.id,
			included: f.credits.included,
			reset: { interval: f.credits.reset },
		}),
	],
});

const p = PLANS[PLAN_IDS.pro];
export const pro = plan({
	id: PLAN_IDS.pro,
	name: p.name,
	group: p.group,
	price: p.price!,
	items: [
		item({
			featureId: aiCredits.id,
			included: p.credits.included,
			price: {
				amount: p.credits.overage.amount,
				billingUnits: p.credits.overage.billingUnits,
				billingMethod: p.credits.overage.billingMethod,
				interval: p.credits.reset,
			},
		}),
	],
});

const u = PLANS[PLAN_IDS.ultra];
export const ultra = plan({
	id: PLAN_IDS.ultra,
	name: u.name,
	group: u.group,
	price: u.price!,
	freeTrial: { durationLength: 14, durationType: 'day', cardRequired: false },
	autoEnable: true,
	items: [
		item({
			featureId: aiCredits.id,
			included: u.credits.included,
			price: {
				amount: u.credits.overage.amount,
				billingUnits: u.credits.overage.billingUnits,
				billingMethod: u.credits.overage.billingMethod,
				interval: u.credits.reset,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
	],
});

const m = PLANS[PLAN_IDS.max];
export const max = plan({
	id: PLAN_IDS.max,
	name: m.name,
	group: m.group,
	price: m.price!,
	items: [
		item({
			featureId: aiCredits.id,
			included: m.credits.included,
			price: {
				amount: m.credits.overage.amount,
				billingUnits: m.credits.overage.billingUnits,
				billingMethod: m.credits.overage.billingMethod,
				interval: m.credits.reset,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
	],
});

const t = PLANS[PLAN_IDS.creditTopUp];
export const creditTopUp = plan({
	id: PLAN_IDS.creditTopUp,
	name: t.name,
	addOn: t.addOn,
	items: [
		item({
			featureId: aiCredits.id,
			price: {
				amount: t.credits.overage!.amount,
				billingUnits: t.credits.overage!.billingUnits,
				billingMethod: t.credits.overage!.billingMethod,
				interval: 'month',
			},
		}),
	],
});

// ---------------------------------------------------------------------------
// Plans — Annual (~17% discount, credits still reset monthly)
// ---------------------------------------------------------------------------

const pa = ANNUAL_PLANS[PLAN_IDS.proAnnual];
export const proAnnual = plan({
	id: PLAN_IDS.proAnnual,
	name: pa.name,
	group: pa.group,
	price: pa.price!,
	items: [
		item({
			featureId: aiCredits.id,
			included: pa.credits.included,
			reset: { interval: 'month' },
			price: {
				amount: pa.credits.overage.amount,
				billingUnits: pa.credits.overage.billingUnits,
				billingMethod: pa.credits.overage.billingMethod,
			},
		}),
	],
});

const ua = ANNUAL_PLANS[PLAN_IDS.ultraAnnual];
export const ultraAnnual = plan({
	id: PLAN_IDS.ultraAnnual,
	name: ua.name,
	group: ua.group,
	price: ua.price!,
	items: [
		item({
			featureId: aiCredits.id,
			included: ua.credits.included,
			reset: { interval: 'month' },
			price: {
				amount: ua.credits.overage.amount,
				billingUnits: ua.credits.overage.billingUnits,
				billingMethod: ua.credits.overage.billingMethod,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
	],
});

const ma = ANNUAL_PLANS[PLAN_IDS.maxAnnual];
export const maxAnnual = plan({
	id: PLAN_IDS.maxAnnual,
	name: ma.name,
	group: ma.group,
	price: ma.price!,
	items: [
		item({
			featureId: aiCredits.id,
			included: ma.credits.included,
			reset: { interval: 'month' },
			price: {
				amount: ma.credits.overage.amount,
				billingUnits: ma.credits.overage.billingUnits,
				billingMethod: ma.credits.overage.billingMethod,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		}),
	],
});
