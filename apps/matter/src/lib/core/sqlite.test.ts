import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { loadVault } from '../load/fs';
import { classifyRows } from './conformance';
import { validateContract } from './contract';
import type { Row } from './parse';
import { projectToSqlite } from './sqlite';

function contract(
	fields: Record<string, Record<string, unknown>>,
	optional?: string[],
) {
	const { data, error } = validateContract({ fields, optional });
	if (error) throw new Error(error.message);
	return data;
}

const m = contract({
	title: { type: 'string' },
	status: { type: 'string', enum: ['draft', 'published'] },
	count: { type: 'integer' },
	score: { type: 'number' },
	live: { type: 'boolean' },
	tags: { type: 'array', items: { type: 'string' } },
	url: { type: 'string', format: 'uri' },
});

const valid: Row = {
	fileName: 'post-1.md',
	frontmatter: {
		title: 'Hello',
		status: 'draft',
		count: 3,
		score: 4.5,
		live: true,
		tags: ['a', 'b'],
		url: 'https://x.com',
		extraKey: 'kept',
	},
	body: '',
};

const incomplete: Row = {
	fileName: 'post-2.md',
	frontmatter: { title: 'Partial' }, // missing required fields -> MISSING_REQUIRED -> NULL
	body: '',
};

const invalid: Row = {
	fileName: 'post-3.md',
	frontmatter: {
		title: 'Bad',
		status: 'bogus', // not in the enum -> INVALID, kept raw
		count: 1.5, // not an integer -> INVALID, kept raw
		score: 2,
		live: false,
		tags: ['x'],
		url: 'https://y.com',
	},
	body: '',
};

describe('schema script (DROP + CREATE, one execute_batch)', () => {
	test('drops then recreates: stem PK, one nullable column per field by storage class, _extra JSON', () => {
		const { schema } = projectToSqlite('posts', m, []);
		expect(schema).toBe(
			'DROP TABLE IF EXISTS "posts";\n' +
				'CREATE TABLE "posts" (' +
				'"stem" TEXT PRIMARY KEY, ' +
				'"title" TEXT, ' +
				'"status" TEXT, ' +
				'"count" INTEGER, ' +
				'"score" REAL, ' +
				'"live" INTEGER, ' +
				'"tags" TEXT, ' +
				'"url" TEXT, ' +
				'"_extra" TEXT NOT NULL)',
		);
	});

	test('field identifiers with quotes/spaces are escaped, and stay nullable', () => {
		const weird = contract({ 'a "b"': { type: 'string' } });
		const { schema } = projectToSqlite('posts', weird, []);
		expect(schema).toContain('"a ""b""" TEXT');
		expect(schema).not.toContain('"a ""b""" TEXT NOT NULL');
	});

	test('the table name is the folder name, quoted', () => {
		const { schema, insert } = projectToSqlite('my posts', m, []);
		expect(schema).toContain('CREATE TABLE "my posts" (');
		expect(schema).toContain('DROP TABLE IF EXISTS "my posts"');
		expect(insert).toContain('INSERT INTO "my posts" (');
	});
});

describe('insert template (one ? per column, bound positionally)', () => {
	test('lists every column in order with one placeholder each', () => {
		const { insert } = projectToSqlite('posts', m, []);
		expect(insert).toBe(
			'INSERT INTO "posts" (' +
				'"stem", "title", "status", "count", "score", "live", "tags", "url", "_extra"' +
				') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		);
		// stem + 7 typed fields + _extra = 9 placeholders.
		expect((insert.match(/\?/g) ?? []).length).toBe(9);
	});
});

describe('rows (every readable row, serialized by conformance state)', () => {
	const conformance = classifyRows(m.fields, [valid, incomplete]);
	const proj = projectToSqlite('posts', m, conformance);

	test('valid AND incomplete rows both project, in folder order', () => {
		expect(proj.rows).toHaveLength(2);
		expect(proj.rows.map((r) => r[0])).toEqual(['post-1', 'post-2']);
	});

	test('an OK cell is serialized to its storage class', () => {
		const [stem, title, status, count, score, live, tags, url, extra] =
			proj.rows[0]!;
		expect(stem).toBe('post-1');
		expect(title).toBe('Hello');
		expect(status).toBe('draft');
		expect(count).toBe(3); // INTEGER stays a number
		expect(score).toBe(4.5); // REAL stays a number
		expect(live).toBe(1); // boolean -> 0/1
		expect(tags).toBe('["a","b"]'); // array -> JSON TEXT
		expect(url).toBe('https://x.com');
		expect(extra).toBe('{"extraKey":"kept"}'); // untyped keys -> _extra JSON
	});

	test('a missing required cell binds NULL (the draft is still a row)', () => {
		const [stem, title, status, count, , , tags, url, extra] = proj.rows[1]!;
		expect(stem).toBe('post-2');
		expect(title).toBe('Partial');
		expect(status).toBeNull();
		expect(count).toBeNull();
		expect(tags).toBeNull();
		expect(url).toBeNull();
		expect(extra).toBe('{}'); // no untyped keys
	});

	test('a MISSING_OPTIONAL cell binds NULL while the row stays valid', () => {
		const optionalContract = contract(
			{
				title: { type: 'string' },
				reviewBy: { type: 'string', format: 'date' },
			},
			['reviewBy'],
		);
		const row: Row = {
			fileName: 'person.md',
			frontmatter: { title: 'Alice', reviewBy: null },
			body: '',
		};
		const conformance = classifyRows(optionalContract.fields, [row]);
		expect(conformance[0]?.rowValid).toBe(true);
		expect(conformance[0]?.cells.map((cell) => cell.state)).toEqual([
			'OK',
			'MISSING_OPTIONAL',
		]);
		const p = projectToSqlite('posts', optionalContract, conformance);
		expect(p.rows[0]).toEqual(['person', 'Alice', null, '{}']);
	});

	test('an out-of-domain cell keeps its raw value so the draft stays filterable', () => {
		const p = projectToSqlite('posts', m, classifyRows(m.fields, [invalid]));
		const [stem, title, status, count] = p.rows[0]!;
		expect(stem).toBe('post-3');
		expect(title).toBe('Bad');
		expect(status).toBe('bogus'); // not in the enum, kept raw
		expect(count).toBe(1.5); // not an integer, kept raw
	});
});

describe('projects a vault into one db whose tables JOIN', () => {
	// W5's payoff: one db per vault, one SQL table per folder NAMED for the folder, so a cross-table
	// JOIN falls out of real table names with no new code. This drives the real projector over the
	// bundled content-vault and runs its SQL through bun:sqlite (the same engine the Tauri command
	// uses), so the success criterion is proven end to end, not asserted on the SQL strings alone.
	const appRoot = resolve(import.meta.dir, '../../..');
	const exampleVault = resolve(appRoot, '../../examples/matter/content-vault');

	test('adaptations JOIN pages on the reference column returns the resolved rows', async () => {
		// Load the fixture and project every typed table into one in-memory db, exactly as the Vault
		// fills its shared .matter db (each folder -> a table named for the folder).
		const tables = await loadVault(exampleVault);
		const db = new Database(':memory:');
		for (const table of tables) {
			if (table.status !== 'readable' || table.read.view.mode !== 'typed')
				continue;
			const { schema, insert, rows } = projectToSqlite(
				table.name,
				table.read.view.contract,
				table.read.view.conformance,
			);
			db.exec(schema); // DROP + CREATE for this folder's table
			const stmt = db.prepare(insert);
			for (const row of rows) stmt.run(...row);
		}

		// `adaptations.page` holds a page's stem (basename, no extension), and the mirror's `stem`
		// column IS that same reference identity, so the JOIN key is just `a.page = p.stem` — no
		// `.md` juggling. An INNER JOIN naturally drops the deliberately-dangling orphan-adaptation
		// (page `ghost-page`, which has no pages row).
		const joined = db
			.query(
				`SELECT a."stem" AS adaptation, p."stem" AS page
				 FROM adaptations a JOIN pages p ON a."page" = p."stem"
				 ORDER BY a."stem"`,
			)
			.all() as { adaptation: string; page: string }[];

		expect(joined).toEqual([
			{
				adaptation: 'become-the-source-carousel',
				page: 'become-the-source',
			},
			{
				adaptation: 'become-the-source-thread',
				page: 'become-the-source',
			},
			{
				adaptation: 'plan-yourself-short',
				page: 'how-we-plan-ourselves',
			},
		]);
	});
});
