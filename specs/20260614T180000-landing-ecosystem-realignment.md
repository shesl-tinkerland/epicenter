# Landing Ecosystem Realignment

**Date**: 2026-06-14
**Status**: Implemented (pending owner assets: founder letter final text, demo recording; pending visual review)
**Owner**: Braden
**Branch**: `landing/public-realignment`
**Supersedes**: `specs/20260612T063520-landing-page-public-realignment.md` (Whispering-led root). That spec's research and copy are still useful; its core IA decision (root = Whispering funnel) is reversed here.

## One Sentence

Turn epicenter.so from a single long Whispering page into an ecosystem site: the root `/` sells the direction (purpose-built apps that write to one folder you own), a persistent top switcher browses the apps with view-transition motion, and each app gets its own routed page carrying an honest status badge, with Whispering as the only live download.

## Why This Changes

The committed root (`apps/landing/src/pages/index.astro`) became two pages fighting: a Whispering conversion funnel and an Epicenter overview, interleaved. It also drifted off the prior spec (named unshipped apps Fuji/Honeycrisp as if real, leaked `epicenter.config.ts` and "Markdown" above the fold).

Owner decision (2026-06-14): the public story is the **family of apps and where it is going**, not one tool. The bet flips from "convert on what ships tonight" to "sell the direction, anchored by one real download." This is a deliberate reversal of the realignment spec's research finding; the risk it creates (vaporware read) is paid down by the status-badge gate below.

## Locked Decisions

| Decision | Choice | Source |
| --- | --- | --- |
| Root subject | Epicenter the ecosystem, not Whispering | Owner, 2026-06-14 |
| Tabs mechanism | Routed pages (`/whispering`, `/honeycrisp`, `/vocab`) + Astro View Transitions; persistent switcher | Owner, 2026-06-14 |
| Unshipped apps | Named publicly, each with a truthful status badge; Whispering is the only "Download now" | Owner, 2026-06-14 |
| Positioning doc | Rewrite `docs/positioning.md` to a vision-forward public stance | Owner, 2026-06-14 |
| App set (first cut) | Whispering (Live), Honeycrisp (In progress), Vocab (Planned, seeded from the `apps/zhongwen` experiment) | Owner, 2026-06-14 |

## Status Taxonomy (the honesty gate)

Every app surface carries a status `Badge`. Each label must be provable in the repo (same rule as positioning's Core Claims table). No app gets a public page or tile whose badge overstates it.

| Badge | Means | Today |
| --- | --- | --- |
| **Live** | Installable through a normal release channel | Whispering (`7.11.0`) |
| **In progress** | Code exists in the repo, built in public, not yet a shipped product | Honeycrisp (`0.0.1`) |
| **Planned** | Announced direction, no code yet | Vocab, seeded from the `apps/zhongwen` experiment |

Hard rule: exactly one **Live** download anchor exists across the whole site (Whispering). Every other app CTA is "Follow the build" or a link to its page/GitHub, never "Download".

## Sitemap

```txt
Persistent shell (top switcher, transition:persist, looks like tabs)
  /             Ecosystem    promise + where it's going + app browser + founder note
  /whispering   Live         deep product page; the only "Download now"
  /honeycrisp   In progress  thin honest page; "follow the build"
  /vocab        Planned      thin honest page; links to the zhongwen experiment
  /blog         unchanged
  /404          unchanged
```

Matter and Fuji stay out of the first cut (not named, no tile, no page) until owner promotes them. Adding an app later = one tile entry + one routed page; the shell does not change.

## Architecture

### The shell and the "feels like tabs" motion

- `BaseLayout.astro` adds `<ClientRouter />` from `astro:transitions` (Astro 6 name; not the old `ViewTransitions`).
- A single `AppSwitcher` nav lists the apps. It is marked `transition:persist` so the bar stays fixed while the page body cross-fades between routes. Real URLs underneath (shareable, SEO, the README's developer door); the motion reads as tabbing inside one app.
- Respect `prefers-reduced-motion`: view transitions degrade to plain navigation.

### Shared component layer (resolve the bespoke-vs-shadcn fork)

Today `/` is hand-rolled warm-paper CSS and `/whispering` is shadcn/style-vega. A multi-page shell needs one language. Decision: keep the warm-paper visual identity (it is the brand), but extract the repeated pieces into small landing-local components so every app page is coherent:

- `AppSwitcher.astro` (the persistent routed tab bar)
- `AppsFolder.astro` (fused app browser plus one-folder visual: icon, name, one line, status, and generated file)
- `AppFooter.astro` (shared footer links)
- `StatusBadge.astro` (Live / In progress / Planned)
- `AppPageHeader.astro` (per-app header: name, status, one line, primary action)

`@epicenter/ui` is wired already (`BaseLayout` sets `class="style-vega"` + imports `app.css`). Use `@epicenter/ui/badge`, `card`, `button`, `tooltip`, `tree-view`, `separator`, `github-button` where they fit the warm-paper theme; do not use `@epicenter/ui/tabs` for the switcher (that is in-page panels, not routed nav).

## Page Specs

### `/` (Ecosystem)

1. **Umbrella hero (direction).** Headline is the place we are heading, e.g. "Purpose-built apps. One folder you own." No per-app download in the headline. Proof line satisfied lower down (Whispering named, "ready today", platforms) to keep it honest.
2. **Ecosystem browser plus folder visual.** `AppsFolder` fuses the app browser with the one-folder picture: Whispering (Live), Honeycrisp (In progress), and Vocab (Planned) each lands a file into the same folder. The tree shows each app folder as its own Epicenter root with a muted `epicenter.config.ts` before the generated file, so the topology is honest without making developer detail the visual headline.
3. **Shared guarantee.** "Apps come and go. Your files shouldn't." The export gag lives here after the fused folder visual, so the joke lands after the reader has seen where the files are.
4. **Founder note.** Moves here (it is about the whole project). Owner text still outstanding; keep the "if we disappeared tomorrow" beat here and nowhere else.
5. **Footer.**

Above the fold on `/`: no Markdown, SQLite, local-first, CRDT, Yjs, `epicenter.config.ts`, or hype words.

### `/whispering` (Live, deep)

Absorbs the Whispering depth currently bloating root, rewritten to the spine voice and the warm-paper visual language (the current page is the old shadcn look, off-spine):

- Hero: "Say it once. Keep it forever." + the capture demo (moved from root).
- "Types into any app" demo (moved from root).
- Providers, keyboard shortcuts, AI processing.
- Pricing + "How is it free?" (`#pricing` anchor; the root/footer link already targets it).
- Optional sync explanation (moved off root), framed honestly: optional, encrypted, self-host or hosted.
- Downloads per platform, setup video, FAQ.
- The only "Download now" on the site.

### `/honeycrisp` (In progress), `/vocab` (Planned)

`AppPageHeader` (name, status badge, one line) + a short honest "what it is / where it's at" body + source or experiment link. No download, no pricing, no shipped-product framing. Vocab's body explains that it is planned, not installable, and that the closest repo artifact today is the `apps/zhongwen` experiment reframed around vocabulary.

## `docs/positioning.md` Edits

Targeted, not a teardown:

- **Proof Line section:** flip "roadmap language stays out of heroes" to "roadmap is the public root's subject, governed by status staging." Add: unshipped apps may be named publicly only with a truthful status badge, and the surface must keep exactly one Live download anchor.
- **The Spine, public cut:** broaden from the single ownership line to the ecosystem promise; "apps come and go, your files shouldn't" survives as the guarantee, not the whole pitch.
- **Earned Vocabulary / What Epicenter Is / Core Claims:** unchanged.

## Implementation Plan

### Wave 1: Foundation (shell + shared components)
- [x] `BaseLayout.astro`: add `<ClientRouter />`; keep `style-vega` + font slot.
- [x] `StatusBadge.astro`, `AppSwitcher.astro` (`transition:persist`), `AppsFolder.astro`, `AppFooter.astro`, `AppPageHeader.astro`.
- [x] Single source of truth for the app registry (name, slug, status, one-line, icon) so `/`, the switcher, and per-app pages stay in sync.

### Wave 2: Root rebuild
- [x] Rebuild `/` as the ecosystem page (umbrella hero, app browser, shared guarantee, founder note). Move Whispering-specific beats out.

### Wave 3: App pages
- [x] Rewrite `/whispering` to the warm-paper language + spine voice; absorb moved depth; keep the only "Download now".
- [x] Add `/honeycrisp` (thin, honest, In progress) and `/vocab` (thin, honest, Planned).

### Wave 4: Positioning + cleanup
- [x] Apply `docs/positioning.md` edits.
- [x] Add a dated "superseded" note to the prior landing spec.
- [x] Banned-word + above-the-fold sweep on `/`; reduced-motion check; no-JS read check; `apps/landing` builds clean.

## Open Questions / Owner Input

- Founder letter final text (still outstanding from the prior spec).
- Real 20-second Whispering demo recording (still outstanding).
- Umbrella hero headline wording (draft proposed; owner approves).
- Whether Matter/Fuji join the ecosystem grid in a later cut.
- Hosted-sync pricing line, when hosted sync is public (existing `TODO(owner)` in the sync beat).

## Success Criteria

- [x] `/` reads as the ecosystem, not a Whispering funnel; no per-app download in the hero.
- [x] Persistent switcher routes between `/`, `/whispering`, `/honeycrisp`, `/vocab` with view-transition motion; degrades to plain nav under reduced motion and no JS.
- [x] Every app tile and page carries a status badge; only Whispering offers "Download now".
- [x] Above the fold on `/` contains no banned vocabulary or `epicenter.config.ts`.
- [x] `/whispering` is on-spine and visually coherent with `/`.
- [x] `docs/positioning.md` reflects the vision-forward stance; prior spec marked superseded.
- [x] `apps/landing` builds clean; pages read with JS disabled.
```
