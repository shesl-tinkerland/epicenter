import type { DateTimeString, IanaTimeZone } from '@epicenter/workspace';
import { dump, load } from 'js-yaml';
import { tauri } from './tauri';
import type { Entry, EntryId, FujiWorkspace } from '../../fuji.workspace';
import { asEntryId } from '../../fuji.workspace';

type FujiMarkdownHost = Pick<FujiWorkspace, 'tables'> & {
	idb: {
		whenLoaded: Promise<unknown>;
	};
	entryContentDocs: {
		open(entryId: EntryId): {
			idb: {
				whenLoaded: Promise<unknown>;
			};
			body: {
				read(): string;
				write(text: string): void;
			};
		};
	};
};

type EntryMetadata = Omit<Entry, 'id'> & {
	id: string;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function createFujiMarkdownActions(host: FujiMarkdownHost) {
	const platform = tauri;
	if (!platform) return {};

	return {
		async pushToMarkdown() {
			await host.idb.whenLoaded;
			const entries = host.tables.entries.getAllValid();
			const files = await Promise.all(
				entries.map(async (entry) => {
					const contentDoc = host.entryContentDocs.open(entry.id);
					await contentDoc.idb.whenLoaded;
					return {
						filename: entryFilename(entry.id),
						content: serializeEntryMarkdown({
							entry,
							body: contentDoc.body.read(),
						}),
					};
				}),
			);
			await platform.markdown.writeFiles(files);
			return { count: files.length };
		},

		async pullFromMarkdown() {
			await host.idb.whenLoaded;
			const files = await platform.markdown.readFiles();
			const imported = files.map(parseEntryMarkdown);

			for (const { entry, body } of imported) {
				const contentDoc = host.entryContentDocs.open(entry.id);
				await contentDoc.idb.whenLoaded;
				contentDoc.body.write(body);
			}

			await host.tables.entries.bulkSet(imported.map(({ entry }) => entry));
			return { count: imported.length };
		},
	};
}

function entryFilename(id: EntryId): string {
	return `${encodeURIComponent(id)}.md`;
}

function serializeEntryMarkdown({
	entry,
	body,
}: {
	entry: Entry;
	body: string;
}): string {
	const metadata: EntryMetadata = {
		id: entry.id,
		title: entry.title,
		subtitle: entry.subtitle,
		type: entry.type,
		tags: entry.tags,
		pinned: entry.pinned,
		deletedAt: entry.deletedAt,
		date: entry.date,
		dateZone: entry.dateZone,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		rating: entry.rating,
	};
	return `---\n${dump(metadata, {
		lineWidth: -1,
		noRefs: true,
		sortKeys: false,
	})}---\n${body}`;
}

function parseEntryMarkdown({
	filename,
	content,
}: {
	filename: string;
	content: string;
}): { entry: Entry; body: string } {
	const match = content.match(FRONTMATTER_PATTERN);
	if (!match) {
		throw new Error(`Markdown file is missing frontmatter: ${filename}`);
	}

	const frontmatter = match[1];
	if (frontmatter === undefined) {
		throw new Error(`Markdown file is missing frontmatter: ${filename}`);
	}

	const metadata = parseMetadata(load(frontmatter), filename);
	return {
		entry: {
			...metadata,
			id: asEntryId(metadata.id),
			dateZone: metadata.dateZone as IanaTimeZone,
		},
		body: content.slice(match[0].length),
	};
}

function parseMetadata(value: unknown, filename: string): EntryMetadata {
	if (!isRecord(value)) {
		throw new Error(`Markdown frontmatter must be an object: ${filename}`);
	}

	const metadata = {
		id: readString(value, 'id', filename),
		title: readString(value, 'title', filename),
		subtitle: readString(value, 'subtitle', filename),
		type: readStringArray(value, 'type', filename),
		tags: readStringArray(value, 'tags', filename),
		pinned: readBoolean(value, 'pinned', filename),
		deletedAt: readNullableString(value, 'deletedAt', filename),
		date: readString(value, 'date', filename) as DateTimeString,
		dateZone: readString(value, 'dateZone', filename) as IanaTimeZone,
		createdAt: readString(value, 'createdAt', filename) as DateTimeString,
		updatedAt: readString(value, 'updatedAt', filename) as DateTimeString,
		rating: readNumber(value, 'rating', filename),
	};

	return metadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): string {
	const field = value[key];
	if (typeof field !== 'string') {
		throw new Error(`Frontmatter field "${key}" must be a string: ${filename}`);
	}
	return field;
}

function readNullableString(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): DateTimeString | null {
	const field = value[key];
	if (field === null) return null;
	if (typeof field !== 'string') {
		throw new Error(
			`Frontmatter field "${key}" must be a string or null: ${filename}`,
		);
	}
	return field as DateTimeString;
}

function readStringArray(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): string[] {
	const field = value[key];
	if (!Array.isArray(field) || field.some((item) => typeof item !== 'string')) {
		throw new Error(
			`Frontmatter field "${key}" must be a string array: ${filename}`,
		);
	}
	return field;
}

function readBoolean(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): boolean {
	const field = value[key];
	if (typeof field !== 'boolean') {
		throw new Error(
			`Frontmatter field "${key}" must be a boolean: ${filename}`,
		);
	}
	return field;
}

function readNumber(
	value: Record<string, unknown>,
	key: keyof EntryMetadata,
	filename: string,
): number {
	const field = value[key];
	if (typeof field !== 'number') {
		throw new Error(`Frontmatter field "${key}" must be a number: ${filename}`);
	}
	return field;
}
