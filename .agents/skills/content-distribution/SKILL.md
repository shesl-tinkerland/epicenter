---
name: content-distribution
description: Turn one real idea, Fuji markdown entry, article, photo, screenshot, code diff, spec excerpt, or diagram into platform-native content for LinkedIn, X, Reddit, TikTok, Instagram Reels, YouTube Shorts, Medium, Substack, or The Ark publishing workflows.
---

# Content Distribution

Use this skill when the user wants to make one piece of thinking travel farther across platforms without becoming a full-time creator.

Follow [writing-voice](../writing-voice/SKILL.md) for tone. Use [social-media](../social-media/SKILL.md) when drafting final LinkedIn, X, or Reddit post copy.

## Core Philosophy

The goal is not to become a full-time creator. The goal is to make existing thinking travel farther.

Use one markdown source. Use real artifacts. AI adapts, packages, resizes, rewrites, captions, and formats. AI does not pretend to be the author.

```txt
real idea
  -> Fuji markdown source
  -> platform-native renderings
  -> performance notes
  -> next ideas from replies
```

## Default Workflow

1. Identify the source artifact: Fuji entry, article draft, photo, screenshot, code diff, ASCII diagram, spec excerpt, voice note, or product decision.
2. Distill one content atom: thesis, tension, proof, visual, audience, and desired reaction.
3. Choose renderers by platform, not by rewriting the idea from scratch.
4. Preserve the human thesis and concrete examples. Let AI adapt structure and phrasing.
5. Produce wrappers for each platform: hook, caption, title, CTA, and format.
6. Keep performance notes simple: hook, visual type, platform, replies, saves, shares, profile clicks, and next variant.

## Content Atom

Before rendering, reduce the source to this shape:

```txt
Thesis:
  The claim the post is making.

Tension:
  Why the claim matters or what common belief it pushes against.

Proof:
  Concrete artifact, example, diff, screenshot, metric, failure, or quote.

Visual:
  Real photo, screenshot, diagram, code, spec excerpt, or Marp slide.

Audience:
  Who should feel seen, challenged, or helped.

Desired reaction:
  save, argue, try, reply, share, click, subscribe.
```

## Renderer Decision Tree

```txt
Is there one clear source article?
  -> Use references/fuji-source-format.md.

Does the user need platform versions?
  -> Use references/platform-renderers.md.

Does the output need strong opening lines?
  -> Use references/hooks.md.

Does the output include carousels or short video?
  -> Use references/marp-remotion-pipeline.md.
```

## Platform Grouping

Treat TikTok, Instagram Reels, and YouTube Shorts as one short-video renderer with small platform wrappers:

```txt
Same:
  core idea, slides, photos, screenshots, voiceover, captions.

Different:
  first hook frame, title, caption, CTA, pacing if needed.
```

Treat Medium and Substack as one article renderer with different relationship posture:

```txt
Medium:
  discovery and searchable article.

Substack:
  relationship, continuity, and personal context.
```

Treat LinkedIn and X as related but not identical:

```txt
LinkedIn:
  canonical concise public argument with one strong visual.

X:
  fragments, threads, sharper hooks, higher frequency.
```

Treat Reddit separately:

```txt
Reddit:
  native subreddit post or comment. Rewrite around the community. Do not dump recycled promo.
```

## Source Of Truth

Prefer a Fuji markdown source when possible:

```txt
apps/fuji/content/YYYY-MM-DD-slug.md
  -> article
  -> LinkedIn
  -> X thread
  -> Reddit variants
  -> Marp carousel
  -> Remotion short video
  -> Medium/Substack
```

If Fuji storage is not implemented for file-backed content yet, use the same markdown shape in the nearest working content folder and keep the format compatible with Fuji.

## Do Not

- Do not generate pure AI images or pure AI videos when the user asked for authentic content from existing materials.
- Do not turn every platform into a separate original writing task.
- Do not optimize for raw volume before a platform wrapper preserves the author's taste.
- Do not add fake vulnerability, fake lessons, fake metrics, or invented personal stories.
- Do not let platform advice override the source thesis.

## Related Specs

- `specs/20260525T130000-creative-os-composition-map.md`
- `specs/20260518T160639-theark-marp-shortform-content-engine.md`
