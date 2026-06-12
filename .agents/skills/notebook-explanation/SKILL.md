---
name: notebook-explanation
description: "Explain technical systems in a notebook style: short working notes, small code blocks, ASCII diagrams, concrete examples, and compressed rules. Use when the user asks to understand architecture, APIs, auth flows, specs, boundaries, code ownership, design tradeoffs, or says \"zoom out\", \"give me the bigger picture\", \"what does this fit into\", or \"I'm lost in this file\"."
metadata:
  author: epicenter
  version: '1.0'
---

# Notebook Explanation

Use this skill when the user wants to understand a technical system, not just receive a polished answer. Write like private working notes from someone trying to make the system obvious to themself.

The point is compression:

```txt
term = meaning
boundary = owner
flow = step by step
rule = durable takeaway
```

If a design cannot survive this format, the design is probably muddy.

## Shape

Start with the question.

```txt
Question:
  What are we trying to understand?

Short answer:
  One sentence.
```

Then build the model in small blocks:

```txt
Notebook model:
  term = meaning
  term = meaning

Flow:
  thing A
    -> thing B
    -> thing C

Good:
  small concrete example

Bad:
  confusing or overbroad example

Rule:
  durable takeaway
```

## Style Rules

- Prefer code blocks over long prose when naming ownership, state, flows, boundaries, or tradeoffs.
- Use short paragraphs only to bridge code blocks.
- Use tiny definitions before diagrams.
- Show "good" and "bad" when a boundary can drift.
- Keep examples concrete: real package names, file names, scopes, route names, or type names.
- Avoid abstract architecture language unless it is immediately grounded in a small example.
- Avoid explaining every edge case up front. Teach the core model first, then name the edge case if it changes the model.
- Avoid bold-heavy formatting. The notebook blocks should carry the structure.

## Architecture Explanations

For architecture, show ownership first:

```txt
apps/server owns:
  private workspace auth
  private workspace sync

apps/cloud owns:
  public product modules
  public records

module owns:
  routes
  schemas
  scope names

network owns:
  domain
  records
  policy

token owns:
  identity proof
  audience
  scopes

policy owns:
  exact product rule
```

Then show the flow:

```txt
private draft
  -> explicit publish
  -> network API
  -> public record
```

## Zoom Out Explanations

When the user asks to zoom out from a file, go up one layer of abstraction before explaining local code. Map:

```txt
Current file:
  path
  role

Surrounding modules:
  module -> why it exists

Callers:
  caller -> what it needs from this file

Sibling concepts:
  nearby concept -> how it differs

Boundary:
  what this file owns
  what it must not own
```

Use the project's domain glossary vocabulary when it exists. The useful answer is not a file tour; it is the mental map that lets the user edit the file without getting lost.

When an architecture explanation will feed an article, the first pass answers four questions:

```txt
Old model:  What did we think owned the thing?
Tell:       What route, type, query, or error revealed the model was wrong?
New model:  What owns it now?
Rule:       What sentence should future readers remember?
```

## Diagram Choices

Write the takeaway first, then draw only what proves it. A diagram that needs more than a short paragraph to explain is probably carrying too many concerns.

Choose the diagram shape by the reader's question:

```txt
Journey / evolution:
  old decision
    -> pressure or failure
    -> current decision

Layer:
  high-level owner
    -> narrower owner
      -> primitive

Flow:
  caller
    -> route
    -> policy
    -> storage

Composition tree:
  public surface
    -> domain layer
      -> primitive

Comparison:
  model A | model B | current choice
```

Use journey diagrams when the important part is how a decision changed. Use layer diagrams when the important part is ownership level. Use flow diagrams when the important part is movement. Use composition trees when the important part is which layer delegates to which. Use comparison tables when the important part is a tradeoff with 3+ stable columns.

Reach for indent-arrow diagrams by default. They are cheap to write and fit working notes. Reach for box art when the diagram is a deliverable: something meant to be looked at and remembered in an article, a polished summary, or a spec.

A layer is hierarchy, and indentation already expresses hierarchy, so indent-arrow is enough:

```txt
Layer (workspace builder):
  createDisposableCache(id => ...).open(id)
    -> createWorkspace({ id, tables, kv })
      -> defineTable() / defineKv()
```

For box art and a worked example of all four shapes, see `docs/articles/four-diagrams-explain-the-ykeyvalue-decision.md`. It takes one decision and draws it four ways, journey, layer, flow, and comparison, each shape answering a different question.

That article is the reference rendering. Do not copy a second rendering of those diagrams into this skill. Cite the article, so the prose that makes each diagram teach stays in one place and cannot drift.

Keep each diagram at one abstraction level. If a diagram mixes product concepts, routes, database tables, and implementation helpers, split it.

Label arrows when the relationship is not obvious:

```txt
Good:
  user token
    -> proves identity
    -> subject-owned room

Bad:
  user token
    -> room
```

For clean diagrams, use these characters when useful: `┌ ┐ └ ┘ ─ │ ├ ┤ ┬ ┴ ┼ ▼ ▲ ◀ ▶ ──→ ←──`.

## API And Auth Explanations

For API, auth, and capability boundaries, separate where, what, and policy:

```txt
audience = where the token works
scope    = what the client can attempt
policy   = whether this user can do this exact thing now
```

Good:

```txt
audience: https://ark.alice.com
scope:    ark:publish
policy:   user is allowed to publish to Alice's network
```

Bad:

```txt
scope: ark:alice:post:create:public:not-banned
```

## Code Break Explanations

When showing code organization, make the folder tree express ownership:

```txt
apps/cloud/src/
  modules/
    ark/
      routes.ts
      schema.ts
      scopes.ts
      policy.ts
  networks/
    config.ts
    host-dispatch.ts
```

Then show the smallest useful type or function:

```ts
type Network = {
  host: string;
  module: string;
  audience: string;
  supportedScopes: string[];
};
```

## When To Stop

Stop once the reader can answer:

```txt
What is this thing?
Who owns it?
Where does data flow?
What is the rule of thumb?
What is the tempting wrong version?
```

Do not keep adding sections just because the topic is large.
