// Runtime barrel: `import * as schema from './db'` is passed to drizzle()
// for the relational query API (db.query.*). drizzle-kit reads schema files
// directly via the glob in drizzle.config.ts.
export * from './schema/core';
export * from './schema/betcha';
export * from './schema/shared';
