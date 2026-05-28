/**
 * Web runtime: every Tauri capability is absent. The named `tauri`
 * export matches the shared platform check from `./tauri.tauri.ts` but
 * always returns `null`.
 *
 * Vite picks this file via `resolve.extensions` for web builds.
 * TypeScript resolves `import { tauri } from '$lib/tauri'` to the
 * `.tauri.ts` companion (via `moduleSuffixes`) so consumers see the
 * full `Tauri | null` type without this file needing to restate it.
 *
 * `tauriOnly` is intentionally absent here. If shared or web-bundled
 * code imports it, the browser build fails instead of shipping a runtime
 * assertion.
 */
export const tauri = null;
