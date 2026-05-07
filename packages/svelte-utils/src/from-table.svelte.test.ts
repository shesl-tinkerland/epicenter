/**
 * fromTable Tests
 *
 * Verifies the readonly table view wraps workspace tables with Svelte's
 * createSubscriber lifecycle instead of a mirrored SvelteMap.
 *
 * Key behaviors:
 * - First tracked read attaches a table observer
 * - Last tracked reader teardown detaches the observer
 * - Untracked reads return live table data without subscribing
 * - Table writes invalidate derived readers
 */

import { describe, expect, test } from 'bun:test';
import type { BaseRow, Table } from '@epicenter/workspace';
import type { Component } from 'svelte';
import { flushSync, mount, unmount } from 'svelte';
import { compile } from 'svelte/compiler';
import { fromTable } from './from-table.svelte.js';

type TestRow = BaseRow & {
	_v: 1;
	value: string;
};

type TableView = ReturnType<typeof fromTable<TestRow>>;
type TestComponent = Component<{
	report(value: string): void;
	view: TableView;
}>;

class TestNode {
	childNodes: TestNode[] = [];
	parentNode: TestNode | null = null;
	nodeType = 1;
	nodeName: string;
	private text = '';

	constructor(nodeName: string) {
		this.nodeName = nodeName;
	}

	get firstChild(): TestNode | null {
		return this.childNodes[0] ?? null;
	}

	get nextSibling(): TestNode | null {
		if (this.parentNode === null) return null;
		const index = this.parentNode.childNodes.indexOf(this);
		return this.parentNode.childNodes[index + 1] ?? null;
	}

	get textContent(): string {
		return this.text;
	}

	set textContent(value: string) {
		this.text = value;
	}

	appendChild(node: TestNode): TestNode {
		this.childNodes.push(node);
		node.parentNode = this;
		return node;
	}

	insertBefore(node: TestNode, anchor: TestNode | null): TestNode {
		const index = anchor === null ? -1 : this.childNodes.indexOf(anchor);
		if (index >= 0) {
			this.childNodes.splice(index, 0, node);
		} else {
			this.childNodes.push(node);
		}
		node.parentNode = this;
		return node;
	}

	removeChild(node: TestNode): TestNode {
		const index = this.childNodes.indexOf(node);
		if (index >= 0) this.childNodes.splice(index, 1);
		node.parentNode = null;
		return node;
	}
}

class TestElement extends TestNode {}
class TestText extends TestNode {}

function installBrowserGlobals(): void {
	const document = {
		createComment: () => new TestNode('#comment'),
		createElement: (name: string) => new TestElement(name),
		createTextNode: (text: string) => {
			const node = new TestText('#text');
			node.textContent = text;
			return node;
		},
	};

	Object.assign(globalThis, {
		document,
		Element: TestElement,
		navigator: { userAgent: 'bun-test' },
		Node: TestNode,
		Text: TestText,
		window: { document },
	});
}

async function compileCounterComponent(): Promise<TestComponent> {
	const source = `
		<script>
			let { view, report } = $props();
			const rows = $derived(view.all);
			$effect(() => {
				report(rows.map((row) => row.value).join(','));
			});
		</script>
	`;
	const { js } = compile(source, { generate: 'client' });
	const url = `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`;
	const module = await import(url);
	return module.default as TestComponent;
}

function setupTable(initialRows: TestRow[] = []) {
	const rows = new Map(initialRows.map((row) => [row.id, row]));
	const observers = new Set<() => void>();

	const table = {
		get(id: string) {
			return { data: rows.get(id) ?? null };
		},
		getAllValid() {
			return [...rows.values()];
		},
		observe(update: () => void) {
			observers.add(update);
			return () => {
				observers.delete(update);
			};
		},
	} as unknown as Table<TestRow>;

	return {
		observers,
		set(row: TestRow) {
			rows.set(row.id, row);
			for (const update of [...observers]) update();
		},
		table,
	};
}

function row(id: string, value: string): TestRow {
	return { id, value, _v: 1 };
}

describe('fromTable', () => {
	test('tracked read attaches the observer and teardown detaches it', async () => {
		installBrowserGlobals();
		const Counter = await compileCounterComponent();
		const setup = setupTable([row('a', 'alpha')]);
		const view = fromTable(setup.table);
		const reports: string[] = [];

		const component = mount(Counter, {
			target: new TestElement('main') as unknown as Element,
			props: { view, report: (value: string) => reports.push(value) },
		});

		flushSync();
		expect(setup.observers.size).toBe(1);
		expect(reports).toEqual(['alpha']);

		await unmount(component);
		await Promise.resolve();

		expect(setup.observers.size).toBe(0);
	});

	test('untracked reads return live table data without subscribing', () => {
		const setup = setupTable([row('a', 'alpha')]);
		const view = fromTable(setup.table);

		expect(view.all).toEqual([row('a', 'alpha')]);
		expect(view.byId('a')).toEqual(row('a', 'alpha'));
		expect(setup.observers.size).toBe(0);

		setup.set(row('b', 'beta'));

		expect(view.all).toEqual([row('a', 'alpha'), row('b', 'beta')]);
		expect(view.byId('b')).toEqual(row('b', 'beta'));
		expect(setup.observers.size).toBe(0);
	});

	test('table writes propagate to a derived reader', async () => {
		installBrowserGlobals();
		const Counter = await compileCounterComponent();
		const setup = setupTable([row('a', 'alpha')]);
		const view = fromTable(setup.table);
		const reports: string[] = [];

		const component = mount(Counter, {
			target: new TestElement('main') as unknown as Element,
			props: { view, report: (value: string) => reports.push(value) },
		});

		flushSync();
		setup.set(row('b', 'beta'));
		flushSync();

		expect(reports).toEqual(['alpha', 'alpha,beta']);

		await unmount(component);
	});
});
