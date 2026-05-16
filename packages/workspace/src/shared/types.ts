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
 * Branded type for absolute filesystem paths.
 *
 * Ensures paths have been resolved to absolute paths at the type level,
 * preventing accidental use of relative paths in filesystem operations.
 */
export type AbsolutePath = string & Brand<'AbsolutePath'>;

/**
 * Project root directory path.
 *
 * This is where user-facing content lives: markdown vaults, config files,
 * and any content that should be version-controlled. Typically the directory
 * where the user runs their app from (`process.cwd()`).
 *
 * @example
 * ```typescript
 * // Markdown extension stores user content relative to project root
 * const vaultDir = path.join(projectDir, 'vault');
 * const postsDir = path.join(projectDir, 'content/posts');
 * ```
 */
export type ProjectDir = AbsolutePath & Brand<'ProjectDir'>;
