# Workspace Schema Definition Patterns

Detailed guidance for `defineTable`, `defineKv`, row type inference, scalar KV design, and branded table IDs.

## Tables

Tables are built from TypeBox column schemas. Use the `column.*` sugar from `@epicenter/workspace` for the SQLite-safe constructor menu; raw `Type.X()` from `typebox` is interchangeable. The `FlatJsonTSchema` constraint enforces "one column maps 1:1 to a SQLite column" regardless of which side built the schema.

`_v` is library-managed end-to-end. Never declare it as a column key (it's a compile error), never set it on a write, never read it off a row. The library stamps it on every stored row, routes by it on read, and strips it before handing the row back.

### Shorthand (Single Version)

Use when a table has only one version. There is no migrate step:

```typescript
import {
  column,
  defineTable,
  type InferTableRow,
} from '@epicenter/workspace';

const notesTable = defineTable({
  id: column.string<NoteId>(),
  title: column.string({ minLength: 1, maxLength: 200 }),
  body: column.nullable(column.string()),
  createdAt: column.dateTime(),
});
export type Note = InferTableRow<typeof notesTable>;
```

### Variadic (Multiple Versions)

Use when you need to evolve a schema over time. Each positional argument is a version (v1 first, v2 second, etc.). The `.migrate()` step is required before the definition is usable: passing the intermediate builder to `createWorkspace`'s `tables` is a compile error.

```typescript
const notesTable = defineTable(
  // v1
  {
    id: column.string<NoteId>(),
    title: column.string(),
  },
  // v2
  {
    id: column.string<NoteId>(),
    title: column.string(),
    pinned: column.boolean(),
  },
).migrate(({ value, version }) => {
  switch (version) {
    case 1:
      return { ...value, pinned: false };
    case 2:
      return value;
  }
});
export type Note = InferTableRow<typeof notesTable>;
```

The migrate function receives a discriminated `{ value, version }` so `switch (version)` narrows `value` to the matching version's columns. The return type is the latest version's row. The user's columns are visible end-to-end; `_v` is invisible.

### Row Type Inference

**Always derive row types with `InferTableRow<typeof X>` against the table definition.** Export the type from the same file that calls `defineTable()`. Consumers `import type` it directly: never re-derive.

```typescript
// Good: schema is the single source of truth
const notesTable = defineTable(/* ... */);
export type Note = InferTableRow<typeof notesTable>;
```

```typescript
// Bad: goes through the runtime Table instance
type Note = ReturnType<typeof workspace.tables.notes.scan>['rows'][number];

// Bad: same smell, plucking the row type out of a point read
type Note = NonNullable<ReturnType<typeof workspace.tables.notes.get>['data']>;
```

Why `InferTableRow` is better:
- Source of truth is the schema, not a method signature.
- Doesn't require importing/building the runtime client (works in workers, server code, isomorphic modules).
- Survives method renames and signature changes.
- Matches the convention used across every app in this repo.

**Don't relay types through state files.** Reactive state files (e.g. `*.svelte.ts`) should `import type` from the workspace definition module, not redefine or re-export the row type. Other consumers should also import the type directly from the workspace module: not from the state file. State files export runtime values; the workspace module exports types.

```typescript
// state/notes.svelte.ts
import type { Note } from '$lib/workspace';     // Good: import directly
// export type { Note };                         // Bad: pass-through re-export

// some-component.svelte
import { notes } from '$lib/state/notes.svelte';  // runtime
import type { Note } from '$lib/workspace';       // type: same source as state file
```

## KV Stores

KV stores use `defineKv(schema, defaultValue)`. No versioning, no migration: invalid stored data returns `defaultValue()` instead.

`defaultValue` is always a **factory function**, not a bare value. The library calls it on every default firing so each call returns a fresh, mutation-safe value.

```typescript
import { column, defineKv } from '@epicenter/workspace';
import { Type } from 'typebox';

const sidebar = defineKv(
  Type.Object({ collapsed: Type.Boolean(), width: Type.Number() }),
  () => ({ collapsed: false, width: 300 }),
);
const fontSize = defineKv(column.number(), () => 14);
const enabled = defineKv(column.boolean(), () => true);
```

KV accepts any TypeBox `TSchema`: the `column.*` sugar, raw `Type.X()`, or composed unions. There is no `FlatJsonTSchema` constraint on KV values (no SQLite materialization layer for KV).

### KV Design Convention: One Scalar Per Key

Use dot-namespaced keys for logical groupings of scalar values:

```typescript
// Good: each preference is an independent scalar
'theme.mode': defineKv(
  column.enum(['light', 'dark', 'system']),
  () => 'light' as const,
),
'theme.fontSize': defineKv(column.number(), () => 14),

// Bad: structured object invites migration needs
'theme': defineKv(
  Type.Object({
    mode: column.enum(['light', 'dark']),
    fontSize: Type.Number(),
  }),
  () => ({ mode: 'light' as const, fontSize: 14 }),
),
```

With scalar values, schema changes either don't break validation (widening `'light' | 'dark'` to `'light' | 'dark' | 'system'` still validates old data) or the default fallback is acceptable (resetting a toggle takes one click).

Exception: discriminated unions and `Record<string, T> | null` are acceptable when they represent a single atomic value.

## Branded Table IDs (Required)

Every table's `id` field and every string foreign key field MUST use a branded type instead of a plain `string`. This prevents accidental mixing of IDs from different tables at compile time.

### Pattern

Define a branded type as a **pure type alias** and a co-located `generate*` factory. There is no runtime validator object: the brand is type-only, and `column.string<NoteId>()` carries the brand through the schema.

```typescript
import type { Brand } from 'wellcrafted/brand';
import {
  column,
  defineTable,
  generateId,
  type InferTableRow,
} from '@epicenter/workspace';

// 1. Branded type alias (co-located with workspace definition)
export type ConversationId = string & Brand<'ConversationId'>;

// 2. Generator function: the ONLY place with the cast
export const generateConversationId = (): ConversationId =>
  generateId<ConversationId>();

// 3. Use the brand inside column.string<>() to propagate it through the schema
const conversationsTable = defineTable({
  id: column.string<ConversationId>(),              // Primary key: branded
  title: column.string(),
  parentId: column.nullable(column.string<ConversationId>()),  // Self-FK
});
export type Conversation = InferTableRow<typeof conversationsTable>;

// 4. At call sites: use the generator, never cast directly
const newId = generateConversationId();  // Good
// const newId = 'abc' as ConversationId;  // Bad
```

`column.string<T>()` accepts a brand-extended string type as its sole generic. Passing a non-branded literal subtype (e.g. `column.string<'draft'>()`) is a compile error: literal-subtype pretending isn't enforced at runtime, so the type system refuses it. Use `column.literal('draft')` for that case instead.

### `as*` Helper Variant for External-Source IDs

When the branded ID is not minted but received as a typed `string` from another typed source (Better Auth user id, URL param, DB column), pair the type with an `as*` syntactic-sugar helper instead of a `generate*` factory:

```typescript
export type UserId = string & Brand<'UserId'>;

/**
 * Syntactic sugar for `value as UserId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place `as UserId` should appear.
 */
export const asUserId = (value: string): UserId => value as UserId;
```

Pick the variant by ID origin:

| Origin of the value                         | Third part                                       |
| ------------------------------------------- | ------------------------------------------------ |
| Minted fresh by this code                   | `generateXxx()` factory (workspace table IDs)    |
| Received as a typed string                  | `asXxx(value: string)` syntactic-sugar helper    |
| Received as `unknown` at a network boundary | Validate with the action's TypeBox input schema  |

Type aliases are PascalCase; functions are camelCase. Schema bodies read `column.string<ConversationId>()` / `column.string<UserId>()` with no `Schema` suffix anywhere.
