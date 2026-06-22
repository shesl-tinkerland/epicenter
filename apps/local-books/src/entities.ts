/**
 * The QuickBooks entity registry: which QB types we mirror, the SQLite table
 * each lands in, and the handful of scalar columns worth lifting out of the raw
 * blob for indexing and joins. Everything else stays in `raw`, so a new QB
 * field needs no migration.
 *
 * The raw blob is canonical; the extracted columns are pure projections of it.
 * Each column is declared as a SQLite GENERATED column over `json_extract(raw,
 * ...)` (see `db.ts`), so the registry is plain data: a JSON path and the column
 * type SQLite coerces it to. There is no write-path extraction and no delete-stub
 * special case: a missing field is `json_extract`'s `null` for free.
 */

export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';

/**
 * A scalar column projected from `raw`. `path` is the segment list into the QB
 * object, e.g. `['CustomerRef', 'value']` becomes `json_extract(raw,
 * '$.CustomerRef.value')`. `type` is the SQLite affinity: REAL for amounts,
 * INTEGER for JSON booleans (`json_extract` yields 0/1), TEXT otherwise.
 */
export type GeneratedColumn = {
	name: string;
	type: ColumnType;
	path: string[];
};

export type EntityDef = {
	/** QuickBooks entity name, e.g. `Invoice` (also the CDC `entities` value). */
	name: string;
	/** SQLite table name, e.g. `invoices`. */
	table: string;
	columns: GeneratedColumn[];
};

export type QbObject = Record<string, unknown> & {
	Id?: string | number;
	status?: string;
	MetaData?: { LastUpdatedTime?: string; CreateTime?: string };
};

/** A column declaration: the SQLite name, its type, and the JSON path into `raw`. */
function col(
	name: string,
	type: ColumnType,
	...path: string[]
): GeneratedColumn {
	return { name, type, path };
}

/** The registry, keyed by QB entity name; the key is the canonical name. */
type EntitySource = Omit<EntityDef, 'name'>;

/**
 * Default mirror set. Each is a CDC-supported QuickBooks transaction or
 * name-list entity. Extend or trim via `config.json` `entities`.
 */
export const ENTITY_DEFS: Record<string, EntitySource> = {
	Invoice: {
		table: 'invoices',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('doc_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('balance', 'REAL', 'Balance'),
			col('customer_ref', 'TEXT', 'CustomerRef', 'value'),
		],
	},
	Customer: {
		table: 'customers',
		columns: [
			col('display_name', 'TEXT', 'DisplayName'),
			col('company_name', 'TEXT', 'CompanyName'),
			col('email', 'TEXT', 'PrimaryEmailAddr', 'Address'),
			col('active', 'INTEGER', 'Active'),
			col('balance', 'REAL', 'Balance'),
		],
	},
	Item: {
		table: 'items',
		columns: [
			col('name', 'TEXT', 'Name'),
			col('type', 'TEXT', 'Type'),
			col('unit_price', 'REAL', 'UnitPrice'),
			col('active', 'INTEGER', 'Active'),
		],
	},
	Payment: {
		table: 'payments',
		columns: [
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('customer_ref', 'TEXT', 'CustomerRef', 'value'),
		],
	},
	Bill: {
		table: 'bills',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('balance', 'REAL', 'Balance'),
			col('vendor_ref', 'TEXT', 'VendorRef', 'value'),
		],
	},
	Vendor: {
		table: 'vendors',
		columns: [
			col('display_name', 'TEXT', 'DisplayName'),
			col('company_name', 'TEXT', 'CompanyName'),
			col('active', 'INTEGER', 'Active'),
			col('balance', 'REAL', 'Balance'),
		],
	},
	Account: {
		table: 'accounts',
		columns: [
			col('name', 'TEXT', 'Name'),
			col('account_type', 'TEXT', 'AccountType'),
			col('current_balance', 'REAL', 'CurrentBalance'),
			col('active', 'INTEGER', 'Active'),
		],
	},
	// Money-out transactions (card/cash/check expenses, incl. posted bank-feed
	// items). The category lives in Line[].AccountBasedExpenseLineDetail.AccountRef
	// (1:N), so it stays in `raw`; the extracted columns are the header scalars
	// worth grouping and joining on.
	Purchase: {
		table: 'purchases',
		columns: [
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('payment_type', 'TEXT', 'PaymentType'),
			col('account_ref', 'TEXT', 'AccountRef', 'name'),
			col('payee', 'TEXT', 'EntityRef', 'name'),
		],
	},
	// Money-in transactions (deposits, incl. posted bank-feed credits). The
	// crediting category lives in Line[].DepositLineDetail.AccountRef (1:N) and
	// stays in `raw`.
	Deposit: {
		table: 'deposits',
		columns: [
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('deposit_to', 'TEXT', 'DepositToAccountRef', 'name'),
		],
	},
};

/** The default entities mirrored when config does not narrow the set. */
export const DEFAULT_ENTITIES: string[] = Object.keys(ENTITY_DEFS);

export function isKnownEntity(name: string): boolean {
	return name in ENTITY_DEFS;
}

export function entityDef(name: string): EntityDef {
	const source = ENTITY_DEFS[name];
	if (!source) {
		throw new Error(
			`Unknown QuickBooks entity "${name}". Known entities: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
	}
	return { name, ...source };
}

/** A deleted CDC record carries `status: "Deleted"`; everything else is live. */
export function isDeleted(raw: QbObject): boolean {
	return (
		typeof raw.status === 'string' && raw.status.toLowerCase() === 'deleted'
	);
}

export function lastUpdatedTime(raw: QbObject): string | null {
	const value = raw.MetaData?.LastUpdatedTime;
	return typeof value === 'string' ? value : null;
}
