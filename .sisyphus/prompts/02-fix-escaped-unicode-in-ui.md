# Fix Escaped Unicode Characters in UI

## Task

Investigate and fix escaped unicode characters appearing literally in the UI across multiple Epicenter apps (tab-manager, zhongwen, whispering). Users see things like `\u0027`, `\u003c`, `&#x27;` as literal text instead of decoded characters.

## Context

Three files render markdown from LLM/API responses using the same pipeline:

**File 1: `apps/tab-manager/src/lib/components/chat/MessageParts.svelte`**

```svelte
{@html DOMPurify.sanitize(marked.parse(part.content, { breaks: true, gfm: true }) as string)}
```

**File 2: `apps/zhongwen/src/lib/components/AssistantMessagePart.svelte`**

```svelte
<script lang="ts">
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';
  const PURIFY_CONFIG = { ADD_TAGS: ['ruby', 'rt', 'rp'] };
  const html = $derived.by(() => {
    const raw = marked.parse(content, { breaks: true, gfm: true }) as string;
    const annotated = showPinyin ? annotateHtml(raw) : raw;
    return DOMPurify.sanitize(annotated, PURIFY_CONFIG);
  });
</script>
<div class="prose prose-sm">{@html html}</div>
```

**File 3: `apps/whispering/src/lib/components/UpdateDialog.svelte`**

```typescript
function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown) as string;
  return DOMPurify.sanitize(html);
}
```

Then used as: `{@html renderMarkdown(updateDialog.update.body)}`

All three do: `marked.parse()` → `DOMPurify.sanitize()` → `{@html}`.

## Investigation Steps

1. Determine the actual root cause. Three hypotheses:
   - DOMPurify double-escaping HTML entities (e.g., `&#x27;` → `&amp;#x27;`)
   - LLM returning JS-style `\u0027` escape sequences that marked doesn't decode
   - Content being `JSON.stringify`'d somewhere upstream and not parsed back
2. Check how message content flows into these components—look at the data source (API responses, Yjs storage) to see if escaping happens before render.
3. Write a minimal reproduction to confirm the mechanism.

## Fix Approach

Once root cause is confirmed:

- If it's DOMPurify double-escaping: add a decode step after sanitization, or configure DOMPurify appropriately
- If it's upstream data: fix the data serialization/deserialization
- Ideally extract a shared `renderMarkdown()` utility so the fix lives in one place rather than patched across 3 files

## Tech Stack

- Svelte 5 (runes: `$state`, `$derived`, `$props`)
- `marked` for markdown → HTML
- `dompurify` for HTML sanitization
- `{@html}` for raw HTML rendering in Svelte
- All apps are in the Epicenter monorepo at `/Users/braden/Code/epicenter/`

## MUST DO

- Confirm the root cause before writing any fix
- Fix all three files (or extract a shared utility)
- Test that the fix doesn't introduce XSS vulnerabilities
- Keep DOMPurify sanitization intact—it's there for security
- Use Svelte 5 patterns (`$derived`, `$props`)—no legacy syntax

## MUST NOT DO

- Do not remove DOMPurify sanitization
- Do not install new dependencies
- Do not modify files outside the three listed apps
- Do not change the markdown parsing options (`breaks: true`, `gfm: true`)
- Do not use `as any` or `@ts-ignore`
