# Fuji Source Format

Use one markdown file as the source of truth. The file should carry enough metadata for platform renderers without forcing the author to write separate drafts.

## Recommended Shape

```md
---
title: "AI agents don't need longer plans"
slug: "agent-verification"
hook: "The bottleneck is verification, not generation."
audience: "developers using coding agents"
desiredReaction: "reply"
visuals:
  hero: "./assets/braden-desk.jpg"
  screenshots:
    - "./assets/agent-plan.png"
platforms:
  linkedin: true
  x: true
  reddit:
    - "r/ClaudeAI"
    - "r/programming"
  shortVideo: true
  medium: true
  substack: true
---

## Thesis

AI agents are already good enough to produce lots of plausible code. The weak point is whether humans can review the output.

## Proof

I keep seeing plans that are too long to read, so people approve them without actually checking the assumptions.

## Diagram

```txt
agent writes plan
  -> human skims
  -> human approves
  -> bug ships
```

## Takeaway

Better formatting helps, but the real product surface is verification.
```

## Field Guidance

`title`: Article title and search-friendly base title.

`hook`: The strongest short-form opening claim. This may become the first slide, LinkedIn opening line, X first post, or video first frame.

`audience`: Name the reader specifically enough that the renderer can preserve context.

`desiredReaction`: Use one of `save`, `argue`, `try`, `reply`, `share`, `click`, or `subscribe`.

`visuals`: Prefer existing photos, screenshots, code, diagrams, or spec excerpts. AI may assist with cropping, captions, cleanup, layout, and overlays.

`platforms`: A routing hint, not a publication guarantee.

## Minimum Viable Source

If the author is moving fast, this is enough:

```md
---
title: ""
hook: ""
visuals:
  hero: ""
---

## Thesis

## Proof

## Takeaway
```

## Rule

The source file is the author's thinking artifact. Platform files are compiled wrappers.
