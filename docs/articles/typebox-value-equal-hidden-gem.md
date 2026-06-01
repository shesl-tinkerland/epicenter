# TypeBox's Hidden Gem: Value.Equal

So I'm looking at my codebase and I've got this 20-line function for comparing two plain data objects. Nested structures, discriminated unions, the whole deal. It's doing manual property checks, handling null cases, comparing nested icon objects with their own discriminants. And at the end? It falls back to `JSON.stringify` anyway.

There has to be a better way.

Turns out TypeBox has this [`Value.Equal` function that does deep structural equality](https://sinclairzx81.github.io/typebox/#/docs/value/equal). It is not tied to a TypeBox schema. You hand it two values and it compares arrays, plain objects, and primitives by structure.

```typescript
import { Value } from 'typebox/value';

// Before: 20 lines of manual comparison
function deepEqual(a: FieldDefinition, b: FieldDefinition): boolean {
	if (a.type !== b.type) return false;
	if (a.name !== b.name) return false;
	if (a.icon !== b.icon) {
		if (!a.icon || !b.icon) return false;
		if (a.icon.type !== b.icon.type) return false;
		// ... more nested checks
	}
	return JSON.stringify(a) === JSON.stringify(b);
}

// After: one line
const deepEqual = (a: FieldDefinition, b: FieldDefinition) => Value.Equal(a, b);
```

One line. Done.

## What It Actually Does

`Value.Equal` delegates to TypeBox's internal `Guard.IsDeepEqual` function. The implementation is small:

- arrays compare by length, then recursively by index
- objects compare the left object's own string property names against values on the right, after checking both objects have the same number of own string property names
- everything else compares with `===`

That means it is a good fit for the kind of data TypeBox usually deals with: JSON-like structures and JavaScript primitives. If your objects use `undefined` as meaningful field state, read the caveat below.

## Why Not Just Use JSON.stringify?

You might think `JSON.stringify(a) === JSON.stringify(b)` is good enough. It's not.

JSON.stringify is order-dependent. `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce different strings even though they're structurally identical. Value.Equal doesn't care about property order.

JSON.stringify also drops `undefined` object properties:

```typescript
JSON.stringify({ a: undefined }) === JSON.stringify({}); // true
Value.Equal({ a: undefined }, {}); // false
```

That difference matters when the shape itself carries meaning. `Value.Equal` can see that one object has an own property where the other does not.

## Where It Does Not Fit

`Value.Equal` is not a universal deep equality library for every JavaScript object graph.

It does not track visited objects, so circular references are not supported. It also does not compare prototypes, property descriptors, or symbol keys. Special objects such as `Date`, `Map`, and `Set` are a poor fit because their meaningful state is not represented as ordinary own string properties.

There is also a narrow object-key caveat: because the comparison reads keys from the left object and values from the right, two objects with different keys can compare equal when the left-side values are all `undefined` and the right object has the same number of own string keys.

The primitive fallback is `===`, so `NaN` is not equal to `NaN`, and `0` equals `-0`.

Use it for plain data where `undefined` is not carrying key-level meaning. Do not use it when class identity, dates, maps, sets, symbols, descriptors, cycles, or `NaN` semantics are part of the contract.

## The Value Module Has More

`Value.Equal` is just one function in TypeBox's Value module. There's a whole toolkit:

```typescript
import { Value } from 'typebox/value';

// Deep equality
Value.Equal(a, b);

// Deep clone
Value.Clone(obj);

// Type checking (runtime validation)
Value.Check(schema, value);

// Get validation errors
Value.Errors(schema, value);

// Transform values to match a schema
Value.Convert(schema, value);

// Run the full parse pipeline
Value.Parse(schema, value);

// Create default values from schema
Value.Create(schema);
```

Some functions need schemas (`Check`, `Errors`, `Convert`, `Parse`, `Create`). Others, like `Equal` and `Clone`, operate directly on values.

## When to Use It

Anytime you're writing manual deep equality checks for plain data, reach for `Value.Equal` first. Schema merging, config diffing, cache invalidation, test assertions, and generated row comparisons are all good fits.

I replaced three separate comparison functions in my codebase with `Value.Equal`. Each was trying to compare plain structured data and each had small holes: missing nested fields, inconsistent null handling, or a brittle `JSON.stringify` fallback. The TypeBox version made the comparison explicit and boring.

---

**Related**: [TypeBox is a Beast](./typebox-is-a-beast.md) covers more TypeBox fundamentals, including `Compile` vs `Value.Check` for validation.
