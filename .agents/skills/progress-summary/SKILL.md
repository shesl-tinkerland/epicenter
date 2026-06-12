---
name: progress-summary
description: 'Conversational PR-style summaries with visual diagrams. Use when: "can you summarize", "what happened", "where are we at", "give me an overview", "walk me through".'
metadata:
  author: epicenter
  version: '1.0'
---

# Progress Summary

Generate conversational summaries of work in progress, using the same style as well-crafted PR descriptions.

For newcomer-friendly architecture explanations, use [notebook-explanation](../notebook-explanation/SKILL.md) as the format: short working notes, tiny definitions, ASCII diagrams, concrete examples, and compressed rules.

## Core Principles

### Motivation First

Every summary starts with WHY. Not what files changed, not how it works:WHY this work matters.

**Good opening**:
> We've been tackling the session timeout issue that was logging users out mid-upload. The root cause was the session refresh only triggering on navigation, not during background activity.

**Bad opening**:
> We added a keepalive call to the upload handler and updated the session refresh logic.

The reader should understand the PROBLEM before seeing the SOLUTION.

### Show Your Thinking

Summaries should reveal the decision-making process:

- "We considered X, but Y made more sense because..."
- "Initially tried A, which revealed B, leading us to C"
- "The tricky part was figuring out where to hook into the existing flow"

### Conversational but Precise

Write like explaining to a colleague over coffee. Direct and honest.

- "This has been painful" rather than "This presented challenges"
- "We hit a wall with" rather than "We encountered difficulties"
- Use "we" for collaborative work, "I" for personal observations

## Summary Types

### Quick Status (verbal check-in)

For "what are you working on" or brief updates:

```
Working on the auth timeout issue. Found the root cause: session refresh
only fires on navigation, not background activity. Currently implementing
a keepalive mechanism in the upload handler.
```

2-4 sentences. Problem, finding, current action.

### Session Recap (end of work session)

For "summarize what we did" or wrapping up:

**Structure**:
1. What problem we tackled
2. Key decisions made (and why)
3. What's working now
4. What's left to do

**Example**:
```
We tackled the nested reactivity problem in state management. Users found
it cumbersome to create deeply reactive state with manual get/set properties.

After exploring several approaches, we landed on proxy-based reactivity
because it lets you write idiomatic JavaScript while we get the performance
benefits of immutability under the hood.

The core implementation is working. Still need to optimize for large arrays
and update the migration guide.
```

### Architecture Overview (explaining a complex change)

For "explain what's happening here" on larger work, use [notebook-explanation](../notebook-explanation/SKILL.md). It owns the mental model and diagram grammar: ownership, boundaries, flows, good/bad examples, durable rules, and the diagram-shape taxonomy.

`progress-summary` still frames the recap around it: what changed, why it changed, and what is still open.

## What to Avoid

- **Listing files changed**: "Updated auth.ts, session.ts, and upload.ts" : just explain what and why
- **Corporate speak**: "This enhancement leverages our existing infrastructure"
- **Marketing language**: "game-changing", "revolutionary", "seamless"
- **Dramatic hyperbole**: "excruciating pain point" : stick to facts
- **Bullet point everything**: Use flowing paragraphs when possible
- **Over-explaining simple changes**: Match the explanation depth to the complexity

## Gathering Context for Summaries

To generate a summary, gather relevant context:

```bash
# Current branch state
git status
git log --oneline -10

# What changed from main
git diff main...HEAD --stat
git log main..HEAD --oneline

# Recent activity
git log --oneline --since="1 hour ago"
```

If the environment provides a dedicated workspace-diff tool, use it. Otherwise
use `git diff --stat`, `git diff`, and targeted file reads.

Read key files that were modified to understand the substance of changes, not just the diff stats.
