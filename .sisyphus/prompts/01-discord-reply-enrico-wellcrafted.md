# Discord Reply: Enrico's wellcrafted Dependency Concern

## Task

Draft a Discord reply to Enrico in the Svelte Discord. He's worried that using wellcrafted in one part of his project will "spread" to the rest and create maintenance burden.

## Context

wellcrafted (https://github.com/wellcrafted-dev/wellcrafted) is a lightweight TypeScript utility library. It exports independent subpath modules:

- `wellcrafted/result`—Result types (`Ok`, `Err`, `trySync`, `tryAsync`)
- `wellcrafted/error`—`extractErrorMessage`, `TaggedError`

Each import is standalone. Using `tryAsync` in one file doesn't force you to adopt Result types everywhere. There's no framework, no runtime, no global state. It's closer to lodash-style "pick what you need" than a framework that takes over.

The Epicenter monorepo uses wellcrafted extensively, but individual packages only import the specific subpaths they need. Many packages use only `wellcrafted/result` and nothing else.

## Voice

Use Discord casual voice. Lowercase starts, short multi-line messages (each line = separate Discord message), no corporate hedging. Empathy first—acknowledge his concern is valid before addressing it. Don't be defensive about the library.

Examples of the tone:

- "honestly that's a fair concern"
- "the tldr is..."
- "so like you'd import wellcrafted/result in that one file and nothing else touches it"

## MUST DO

- Acknowledge the concern is legitimate (dependency sprawl is real)
- Explain wellcrafted uses subpath exports—each import is independent
- Give a concrete example: "you can use tryAsync in one service file and the rest of your app never knows wellcrafted exists"
- Mention it has zero dependencies itself
- Keep it to 4–6 short messages max

## MUST NOT DO

- Don't be defensive or salesy
- Don't compare to other libraries
- Don't use bullet points or headers
- Don't say "great question" or any AI filler
- Don't use exclamation marks on every sentence
