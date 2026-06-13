# Table Migrations

## When to Read This

Read when adding table versions, writing `.migrate()` functions, or validating migration style and anti-patterns.

## Migrate Function Contract

`defineTable` is variadic over positional versions. The first argument is v1, the second is v2, etc. `.migrate(fn)` is required for the multi-version form and forbidden on the single-version form (there's nothing to migrate).

The migrate function takes a **discriminated** `{ value, version }` and returns the latest version's user-facing row.

```typescript
.migrate(({ value, version }) => {
  switch (version) {
    case 1: /* `value` narrows to v1 columns */
    case 2: /* `value` narrows to v2 columns */
  }
});
```

Rules:

1. Input is a discriminated union: `{ value: RowOf<vN>; version: N }` for every N.
2. Return type is the latest version's row (user-facing; no `_v`).
3. Use `switch (version)` for discrimination. `value` does not carry `version` and is not self-describing.
4. The final case returns `value` as-is (already latest).
5. Always migrate directly to latest. Don't chain v1 → v2 → v3 incrementally.

`_v` is never present on `value`, never returned from the function, and never appears in user-facing row types. The library stamps it on storage and routes by it before calling migrate.

## Anti-Patterns

### Incremental migration (v1 -> v2 -> v3)

```typescript
// BAD: Chains through each version, re-running intermediate migrations
.migrate(({ value, version }) => {
  let current: any = value;
  if (version === 1) current = { ...current, views: 0 };
  if (version <= 2) current = { ...current, tags: [] };
  return current;
});

// GOOD: Migrate directly to latest, one branch per stored version
.migrate(({ value, version }) => {
  switch (version) {
    case 1: return { ...value, views: 0, tags: [] };
    case 2: return { ...value, tags: [] };
    case 3: return value;
  }
});
```

### Declaring `_v` as a column

```typescript
// BAD: `_v` is library-managed. The defineTable parameter type refuses it.
defineTable({
  id: column.string<NoteId>(),
  title: column.string(),
  _v: column.literal(1),   // compile error: "_v is library-managed; remove it from the column record"
});

// GOOD: just declare your columns.
defineTable({
  id: column.string<NoteId>(),
  title: column.string(),
});
```

### Reading or writing `_v` at call sites

```typescript
// BAD: `_v` does not exist on the user-facing row type.
const { _v } = note;                  // type error: property '_v' does not exist
tables.notes.set({ ..., _v: 2 });     // type error: object literal may only specify known properties

// GOOD: set/update/get the user columns. Library handles versioning.
tables.notes.set({ id, title, pinned: false });
tables.notes.update(id, { title });
```

## Branded ID Rules

1. **Every table gets its own ID type**: `DeviceId`, `SavedTabId`, `ConversationId`, `ChatMessageId`, etc.
2. **Foreign keys use the referenced table's ID type**: `chatMessages.conversationId` uses `column.string<ConversationId>()`, not `column.string()`.
3. **Optional FKs use `column.nullable(...)`**: `parentId: column.nullable(column.string<ConversationId>())`.
4. **Composite IDs are also branded**: `TabCompositeId`, `WindowCompositeId`, `GroupCompositeId`.
5. **Use generator functions**: When IDs are generated at runtime, use a `generate*` factory that calls `generateId<X>()`. Never scatter casts across call sites.
6. **Functions accept branded types**: `function switchConversation(id: ConversationId)` not `(id: string)`.

### Why Not Plain `string`

```typescript
// BAD: Nothing prevents mixing conversation IDs with message IDs
function deleteConversation(id: string) { ... }
deleteConversation(message.id);  // Compiles! Silent bug.

// GOOD: Compiler catches the mistake
function deleteConversation(id: ConversationId) { ... }
deleteConversation(message.id);  // Error: ChatMessageId is not ConversationId
```

### Reference Implementations

See `apps/honeycrisp/honeycrisp.ts` and `apps/fuji/src/lib/workspace/index.ts` for the canonical co-located pattern (brand type + `generate*` / `as*` + table + `InferTableRow` export).
See `apps/whispering/src/lib/workspace/definition.ts` for a multi-table example including `column.json(Type.Union([...]))` for discriminated JSON results. No first-party app has a multi-version migration yet; for `.migrate()` examples, see the test suites at `packages/workspace/src/document/create-table.test.ts` and `packages/workspace/src/document/define-table.test.ts`.

### Pattern

```typescript
import type { Brand } from 'wellcrafted/brand';
import {
  column,
  createWorkspace,
  defineTable,
  generateId,
  type InferTableRow,
} from '@epicenter/workspace';

// ─── Branded IDs ─────────────────────────────────────────────────────────

export type UserId = string & Brand<'UserId'>;
export const generateUserId = (): UserId => generateId<UserId>();

export type PostId = string & Brand<'PostId'>;
export const generatePostId = (): PostId => generateId<PostId>();

// ─── Tables (each followed by its type export) ──────────────────────────

const usersTable = defineTable({
  id: column.string<UserId>(),
  email: column.string(),
});
export type User = InferTableRow<typeof usersTable>;

const postsTable = defineTable({
  id: column.string<PostId>(),
  authorId: column.string<UserId>(),
  title: column.string(),
});
export type Post = InferTableRow<typeof postsTable>;

const myAppTables = { users: usersTable, posts: postsTable };

// ─── Workspace factory ──────────────────────────────────────────────────

export function createMyAppWorkspace() {
  return createWorkspace({
    id: 'my-workspace',
    tables: myAppTables,
    kv: {},
  });
}

export const workspace = createMyAppWorkspace();
```

### Why This Structure

- **Co-located types**: Each `export type` sits right below its `defineTable`: easy to verify 1:1 correspondence, easy to remove both together.
- **Error co-location**: If you forget `id` or pass a non-flat column shape, the error surfaces on the `defineTable()` call itself, not buried inside the `createWorkspace({ tables })` call.
- **Single source of truth**: `InferTableRow` derives from the schema. Migrations always infer the latest version's row.
- **Fast type inference**: `InferTableRow<typeof usersTable>` resolves against a standalone const. Avoids expensive indirection through the workspace bundle type.

### Anti-Pattern: Inline Tables + Deep Indirection

```typescript
// BAD: Tables inline inside createWorkspace, types derived through indirection off the bundle
export function createMyAppWorkspace() {
  return createWorkspace({
    id: 'my-workspace',
    tables: {
      users: defineTable({ id: column.string<UserId>(), email: column.string() }),
    },
    kv: {},
  });
}
type Tables = ReturnType<typeof createMyAppWorkspace>['tables'];
export type User = InferTableRow<Tables['users']>;

// GOOD: Extract table, co-locate type, reference it in createWorkspace
const usersTable = defineTable({
  id: column.string<UserId>(),
  email: column.string(),
});
export type User = InferTableRow<typeof usersTable>;

export function createMyAppWorkspace() {
  return createWorkspace({
    id: 'my-workspace',
    tables: { users: usersTable },
    kv: {},
  });
}
```
