# Marp And Remotion Pipeline

Use Marp and Remotion together:

```txt
Markdown writes the idea.
Marp lays out the idea.
Remotion performs the idea.
```

## Marp

Use Marp for thinking artifacts:

```txt
markdown
  -> slides
  -> carousel
  -> still frames
  -> article visuals
```

Good Marp inputs:

- Claims.
- Diagrams.
- Screenshots.
- Before and after.
- Code snippets.
- Short captions.
- One idea per slide.

Default slide structure:

```txt
Slide 1: Hook
Slide 2: Problem
Slide 3: Concrete artifact
Slide 4: Pattern
Slide 5: Better workflow or product mechanic
Slide 6: Question or CTA
```

## Remotion

Use Remotion for motion artifacts:

```txt
Marp frames
  + photos
  + screenshots
  + captions
  + voiceover
  + timing
  -> vertical video
```

Good Remotion responsibilities:

- 9:16 exports.
- Captions.
- Cuts and pacing.
- Zooms and pans on screenshots.
- Platform-specific hook frame swaps.
- Voiceover timing.

## Short Video Contract

The same core video should serve TikTok, Instagram Reels, and YouTube Shorts when possible:

```txt
0.0s to 1.5s:
  Strong hook frame.

1.5s to 8.0s:
  Problem or contradiction.

8.0s to 25.0s:
  Proof, screenshot, diagram, or example.

25.0s to 40.0s:
  Takeaway and question.
```

## Authenticity Rules

- Use real photos, screenshots, diagrams, code, and voice by default.
- AI can crop, resize, caption, clean, arrange, and generate variants.
- Do not use pure AI images or pure AI videos unless the user explicitly asks for generated visuals.
- If using synthetic voice, label it in the workflow and prefer the author's real voice for trust-sensitive content.

## Export Targets

```txt
carousel.pdf:
  LinkedIn document, Instagram carousel.

frames/*.png:
  LinkedIn image, X image, article images, Remotion inputs.

shorts.mp4:
  TikTok, Reels, YouTube Shorts.

linkedin-video.mp4:
  Optional slower variant if LinkedIn video becomes a priority.
```
