# The Case Against relations.ts

**TL;DR**: Keep `relations()` in the same file as the `pgTable()` definitions they describe. Extracting them to a shared `relations.ts` creates a circular import waiting to happen and pulls apart things that belong together.

## The Instinct

You split your schema across files. `auth.ts` has users. `posts.ts` has posts. `comments.ts` has comments. At some point someone suggests: "Let's collect all the `relations()` calls in one place. It'll be easier to see all the joins."

It sounds tidy. It isn't.

## What Goes Wrong

A central `relations.ts` imports table references from every schema file:

```typescript
// relations.ts — the "tidy" version
import { users } from './auth';
import { posts } from './posts';
import { comments } from './comments';

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
  comments: many(comments),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.userId], references: [users.id] }),
  comments: many(comments),
}));
```

This works until one of those source files needs to import something from `relations.ts` back—say, a helper derived from the relation config, or a Drizzle `with` clause you extracted as a constant. Now `auth.ts` imports from `relations.ts`, and `relations.ts` imports from `auth.ts`. TypeScript often tolerates this. Bundlers and runtime module evaluation sometimes don't. Either way you've created a dependency cycle in what should be a simple DAG.

The colocated layout sidesteps this entirely:

```typescript
// auth.ts — tables and relations in one place
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));
```

Each schema file can import table references from other schema files. Nothing imports back from a central relations module. The dependency graph stays linear.

## Relations Aren't a Separate Concern

The impulse to extract `relations()` usually comes from experience with Prisma, where your whole schema lives in one `schema.prisma` file and relations are literally a different syntax block. That model doesn't apply here.

In Drizzle, `relations()` is a projection of the table. It describes how `users` connects to `posts`. That description belongs next to the `users` table definition for the same reason a TypeScript interface belongs next to the code it types—not because a style guide says so, but because they describe the same thing.

When you read `auth.ts`, you want to know: what columns does `users` have, and what does it relate to? Both answers should be in the same file.

## Orphaned Relations

When you delete a table, you delete the file. If that table's `relations()` call lives in `relations.ts`, the relation definition stays behind. It references a table that no longer exists. TypeScript will catch the missing import, but only after you've already gone looking in a separate file. Colocation makes cleanup automatic—delete the file, the relations go with it.

## What Drizzle's Own Docs Show

Look at [orm.drizzle.team/docs/rqb](https://orm.drizzle.team/docs/rqb). Every example in the Relational Queries documentation puts `relations()` in the same file as `pgTable()`. This isn't just convention—it's the model Drizzle is built around. The relations API is designed to extend your table definitions, not replace them.

## The Golden Rule

Relations describe tables. They live with tables.

If you're reviewing a PR that extracts `relations()` into a separate file, push back. Not because it's wrong today, but because it creates the conditions for a circular import and splits information that belongs together.
