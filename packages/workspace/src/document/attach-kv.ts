/**
 * attachKv() — Bind KV definitions to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('kv')` and
 * wraps it with a typed `Kv`. KV uses validate-or-default semantics:
 * invalid or missing values return the default value from the KV definition.
 *
 * For encrypted storage, call `encryption.attachKv` on the coordinator
 * returned by `attachEncryption(ydoc, { keyring })`.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type * as Y from 'yjs';
import { KV_KEY } from './keys.js';
import type { CombinedStandardSchema } from './standard-schema.js';
import {
	type KvStoreChange,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

// ════════════════════════════════════════════════════════════════════════════
// KV RESULT TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Change event for KV observation */
export type KvChange<TValue> =
	| { type: 'set'; value: TValue }
	| { type: 'delete' };

// ════════════════════════════════════════════════════════════════════════════
// KV DEFINITION & HELPER TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A KV definition created by `defineKv(schema, defaultValue)`.
 */
export type KvDefinition<TSchema extends CombinedStandardSchema> = {
	schema: TSchema;
	defaultValue: StandardSchemaV1.InferOutput<TSchema>;
};

/** Extract the value type from a KvDefinition */
export type InferKvValue<T> =
	T extends KvDefinition<infer TSchema>
		? StandardSchemaV1.InferOutput<TSchema>
		: never;

/** Map of KV definitions (uses `any` to allow variance in generic parameters) */
export type KvDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	KvDefinition<any>
>;

/**
 * Dictionary-style typed handle over a KV store.
 */
export type Kv<TKvDefinitions extends KvDefinitions> = ReturnType<
	typeof createKv<TKvDefinitions>
>;

/**
 * Bind a record of KV definitions to a Y.Doc and return a typed Kv.
 *
 * @param ydoc - The Y.Doc to attach to
 * @param definitions - Map of KV key name to KvDefinition
 */
export function attachKv<TKvDefinitions extends KvDefinitions>(
	ydoc: Y.Doc,
	definitions: TKvDefinitions,
): Kv<TKvDefinitions> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.once('destroy', () => ykv[Symbol.dispose]());
	return createKv(ykv, definitions);
}

/**
 * Build a Kv helper over any `ObservableKvStore`. Exported so
 * `@epicenter/workspace` can reuse the same helper logic over its encrypted
 * store wrapper.
 */
export function createKv<TKvDefinitions extends KvDefinitions>(
	ykv: ObservableKvStore<unknown>,
	definitions: TKvDefinitions,
) {
	return {
		get<K extends keyof TKvDefinitions & string>(
			key: K,
		): InferKvValue<TKvDefinitions[K]> {
			const definition = definitions[key]!;
			const raw = ykv.get(key);
			if (raw === undefined) return definition.defaultValue;

			const result = definition.schema['~standard'].validate(raw);
			if (result instanceof Promise)
				throw new TypeError('Async schemas not supported');
			if (result.issues) return definition.defaultValue;

			return result.value;
		},

		set<K extends keyof TKvDefinitions & string>(
			key: K,
			value: InferKvValue<TKvDefinitions[K]>,
		): void {
			ykv.set(key, value);
		},

		delete<K extends keyof TKvDefinitions & string>(key: K): void {
			ykv.delete(key);
		},

		observe<K extends keyof TKvDefinitions & string>(
			key: K,
			callback: (
				change: KvChange<InferKvValue<TKvDefinitions[K]>>,
				origin?: unknown,
			) => void,
		): () => void {
			const definition = definitions[key]!;

			const handler = (
				changes: Map<string, KvStoreChange<unknown>>,
				origin: unknown,
			) => {
				const change = changes.get(key);
				if (!change) return;

				switch (change.action) {
					case 'delete':
						callback({ type: 'delete' }, origin);
						break;
					case 'add':
					case 'update': {
						const result = definition.schema['~standard'].validate(
							change.newValue,
						);
						if (!(result instanceof Promise) && !result.issues) {
							callback(
								{ type: 'set', value: result.value } as Parameters<
									typeof callback
								>[0],
								origin,
							);
						}
						// Skip callback for invalid values
						break;
					}
					default:
						change satisfies never;
				}
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		observeAll(
			callback: (
				changes: Map<keyof TKvDefinitions & string, KvChange<unknown>>,
				origin?: unknown,
			) => void,
		): () => void {
			const handler = (
				changes: Map<string, KvStoreChange<unknown>>,
				origin: unknown,
			) => {
				const parsed = new Map<string, KvChange<unknown>>();
				for (const [key, change] of changes) {
					const definition = definitions[key];
					if (!definition) continue;
					if (change.action === 'delete') {
						parsed.set(key, { type: 'delete' });
					} else {
						const result = definition.schema['~standard'].validate(
							change.newValue,
						);
						if (!(result instanceof Promise) && !result.issues) {
							parsed.set(key, {
								type: 'set',
								value: result.value,
							});
						}
					}
				}
				if (parsed.size > 0)
					callback(
						parsed as Map<keyof TKvDefinitions & string, KvChange<unknown>>,
						origin,
					);
			};
			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		getAll(): {
			[K in keyof TKvDefinitions & string]: InferKvValue<TKvDefinitions[K]>;
		} {
			const result = {} as {
				[K in keyof TKvDefinitions & string]: InferKvValue<TKvDefinitions[K]>;
			};
			for (const key of Object.keys(definitions)) {
				const typedKey = key as keyof TKvDefinitions & string;
				result[typedKey] = this.get(typedKey);
			}
			return result;
		},
	};
}
