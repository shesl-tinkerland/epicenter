# @epicenter/skills

`@epicenter/skills` defines the shared skills data model: table schemas, row
types, the pure skills workspace factory, per-row document guid helpers, and
read action factories. It does not own browser storage. Browser apps compose
IndexedDB, BroadcastChannel, and `createDisposableCache` at the app boundary.

## Root Export

```typescript
import {
	SKILLS_WORKSPACE_ID,
	createSkillsActions,
	openSkills,
	referenceContentDocGuid,
	referencesTable,
	skillInstructionsDocGuid,
	skillsTable,
} from '@epicenter/skills';
```

The root export is intentionally runtime-neutral. It is safe to use from
browser apps, Node scripts, and package-level tests because it does not import
IndexedDB or file-system APIs.

`openSkills()` builds the shared encrypted Y.Doc, tables, KV, and batch helper.
It does not create instruction or reference document caches, because those
caches own runtime persistence and browser cleanup.

## Browser Composition

Browser callers layer browser lifecycle wiring on top of `openSkills()`:

```typescript
const doc = openSkills();
const idb = attachIndexedDb(doc.ydoc);
attachBroadcastChannel(doc.ydoc);

const instructionsDocs = createDisposableCache(
	(skillId: string) => {
		const ydoc = new Y.Doc({
			guid: skillInstructionsDocGuid({
				workspaceId: doc.ydoc.guid,
				skillId,
			}),
			gc: true,
		});
		onLocalUpdate(ydoc, () =>
			doc.tables.skills.update(skillId, { updatedAt: Date.now() }),
		);
		const idb = attachIndexedDb(ydoc);
		return {
			ydoc,
			instructions: attachPlainText(ydoc),
			idb,
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: 5_000 },
);

async function clearInstructionsLocalData() {
	await Promise.all(
		doc.tables.skills.scan().rows.map((skill) =>
			clearDocument(
				skillInstructionsDocGuid({
					workspaceId: doc.ydoc.guid,
					skillId: skill.id,
				}),
			),
		),
	);
}
```

That inline cache source is deliberate. `openSkills()` owns the root document,
the app owns child document construction, and `skillInstructionsDocGuid()` owns
the stable storage address.

## Node Composition

Use `@epicenter/skills/node` when disk import/export actions are needed:

```typescript
import { openSkillsNode } from '@epicenter/skills/node';

using workspace = openSkillsNode({ workspaceId: 'epicenter-skills' });
await workspace.actions.import_from_disk({ dir: '.agents/skills' });
await workspace.actions.export_to_disk({ dir: '.agents/skills' });
```

Node opens instruction and reference docs per operation. The browser cache
exists for shared live identity, refcounting, and IndexedDB reset; the Node
import/export path does not need those lifecycle rules.

## Data Model

```text
skills row
  metadata columns
  instructions document

references row
  skillId
  content document
```

The catalog stays small and queryable. Markdown bodies live in per-row Y.Docs
so editors can load and collaborate on them on demand.

## License

MIT
