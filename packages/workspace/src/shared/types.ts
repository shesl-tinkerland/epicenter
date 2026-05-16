import type { Brand } from 'wellcrafted/brand';

/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Flatten a mapped or conditional type for IDE hover output.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Project root directory path: a resolved absolute path that contains the
 * user's workspace content (markdown vaults, config files, version-controlled
 * artifacts). Typically the directory where the user runs their app from
 * (`process.cwd()`). Minted exclusively by `findEpicenterDir`, so the brand
 * acts as proof that the path was discovered via the project's discovery
 * rules rather than passed in raw.
 *
 * @example
 * ```typescript
 * const vaultDir = path.join(projectDir, 'vault');
 * const postsDir = path.join(projectDir, 'content/posts');
 * ```
 */
export type ProjectDir = string & Brand<'ProjectDir'>;
