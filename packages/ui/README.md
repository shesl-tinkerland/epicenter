# UI Package - shadcn-svelte Management Guide

This guide explains how we manage shadcn-svelte components in our monorepo setup, including our custom configuration and best practices.

## Component Library Overview

This UI package contains a combination of:

- **shadcn-svelte** components (core design system components)
- **shadcn-svelte-extras** components (additional utility components)

### Dialog vs Modal Usage Guidelines

We use different component types based on the interaction pattern:

**Use Dialog + AlertDialog for:**

- Confirmations and simple yes/no prompts
- Display-only content (viewing information)
- Simple action confirmations (delete, cancel, etc.)
- Non-interactive content presentation

**Use Modal for:**

- Forms with user input (text fields, dropdowns, etc.)
- Complex interactions requiring typing
- Multi-step workflows with form data
- Any component where users need to input data

**Decision Rule:** If the user needs to type or input data → use Modal. Otherwise, use Dialog/AlertDialog.

**Examples:**

- `ConfirmationDialog` ✅ (just yes/no buttons)
- `CreateWorkspaceModal` ✅ (multiple form inputs)
- `EditRecordingModal` ✅ (text inputs and editing)
- `DeleteWorkspaceButton` ✅ (uses AlertDialog for confirmation)

## Key Differences from Standard shadcn-svelte

### 1. Path Aliases Configuration

Our `components.json` uses a flattened structure with the `#` symbol mapping directly to the `src` folder:

```json
{
	"aliases": {
		"components": "#",
		"utils": "#/utils",
		"ui": "#",
		"hooks": "#/hooks",
		"lib": "#/lib"
	}
}
```

**What this means:**

- `#` maps to `./src` (configured via Node.js subpath imports in `package.json`)
- `#/button` resolves to `./src/button`
- All components and utils live directly in the `src` folder (no nested `components` directory)

### Why We Use # Instead of @

We switched from `@` to `#` for path aliases because of how Node.js handles module resolution in monorepos. The `#` symbol is the standard prefix for [Node.js subpath imports](https://nodejs.org/api/packages.html#subpath-imports), which provides better compatibility with build tools and TypeScript in monorepo environments.

This change was necessary to avoid conflicts with package name conventions (which often use `@` for scoped packages) and to ensure proper module resolution across different tools in our build pipeline. For more context on this issue, see the [Turborepo discussion on module resolution](https://github.com/vercel/turborepo/discussions/620).

### 2. Package Exports Structure

Our `package.json` uses a pattern-based export system with subpath imports:

```json
{
	"exports": {
		"./*": "./src/*/index.ts",
		"./utils": "./src/utils.ts",
		"./app.css": "./src/app.css"
	},
	"imports": {
		"#*": ["./src/*", "./src/*.ts", "./src/*/index.ts"]
	}
}
```

The `imports` field enables the `#` prefix for internal module resolution, allowing multiple resolution patterns for flexibility.

This allows consumers to import components like:

```typescript
import { Button } from '@epicenter/ui/button';
import { cn } from '@epicenter/ui/utils';
```

### 3. Styling Override Pattern

When extending shadcn-svelte components with custom styles, we use a specific pattern that separates base styles from our overrides:

```svelte
<SelectPrimitive.Content
	class={cn(
		'base-shadcn-styles-here',
		// Custom override: prevents dropdown from expanding
		'max-w-min',
		className,
	)}
/>
```

**Why use separate arguments in `cn()`?**

- **Clear separation**: First argument contains shadcn's base styles, second argument contains our overrides
- **Better diffs**: When updating shadcn components, changes to base styles appear in the first argument, making it obvious what shadcn changed vs. what we customized
- **Comments**: We can add comments above our overrides explaining why they're needed
- **Easier updates**: During `shadcn-svelte` updates, if our override (second argument) disappears in the diff, we know we need to re-apply it

This pattern makes component updates much clearer: shadcn's style updates show in the first `cn()` argument, while our customizations remain visually separate in subsequent arguments.

## Theming

Theming lives in [`src/app.css`](./src/app.css). Every component reads CSS variables (`var(--primary)`, `var(--radius)`, etc.) — never hard-coded colors. To change the look, change the variables. No CLI, no recompute, no component edits.

### Adjust a color or radius

Edit the variable in `:root` (light mode) and/or `.dark` (dark mode). Hot reload picks it up.

```css
:root {
    --radius: 0.625rem;     /* one value drives all radius sizes */
    --primary: oklch(0.214 0.009 43.1);
    --background: oklch(1 0 0);
}
```

The radius scale is derived once in `@theme inline`:

```css
--radius-sm: calc(var(--radius) - 4px);
--radius-md: calc(var(--radius) - 2px);
--radius-lg: var(--radius);
--radius-xl: calc(var(--radius) + 4px);
--radius-2xl: calc(var(--radius) * 1.8);
--radius-3xl: calc(var(--radius) * 2.2);
--radius-4xl: calc(var(--radius) * 2.6);
```

So a single `--radius` change cascades into button (`rounded-4xl`), badge (`rounded-3xl`), dialog (`rounded-4xl`), and everything else proportionally.

### Swap fonts

Fonts are not managed by the shadcn-svelte CLI. We import them via `@fontsource-variable/*` packages and reference them in `@theme inline`:

```css
@import "@fontsource-variable/inter";
@import "@fontsource-variable/lora";

@theme inline {
    --font-sans: "Inter Variable", sans-serif;
    --font-heading: "Lora Variable", serif;
}
```

Headings are wired via the registry's per-component `class="font-heading"` (CardTitle, AlertDialogTitle, etc.) — that's the idiomatic Luma pattern, no global `h1–h6` rule needed.

### Wholesale restyle (rare)

When a single-variable edit isn't enough — switching base color family (taupe → mauve), changing styles (Luma → New York), or adopting a brand-new preset — re-run the CLI. This rewrites `app.css`'s palette and (depending on flags) registry components, so it's destructive on purpose.

```bash
# Single base-color swap
bun x shadcn-svelte@latest init --overwrite --no-deps \
  --base-color mauve --css src/app.css \
  --components-alias '#' --lib-alias '#/lib' \
  --utils-alias '#/utils' --hooks-alias '#/hooks' --ui-alias '#'

# Whole new preset (build one at https://shadcn-svelte.com/create)
bun x shadcn-svelte@latest init --overwrite --no-deps \
  --preset PRESET_ID --css src/app.css \
  --components-alias '#' --lib-alias '#/lib' \
  --utils-alias '#/utils' --hooks-alias '#/hooks' --ui-alias '#'
```

Available base colors: `neutral`, `stone`, `zinc`, `mauve`, `olive`, `mist`, `taupe`.

**Always commit before running this.** The CLI will wipe Epicenter customizations: custom `--warning`/`--success` tokens, the dark-mode `--sidebar-primary` retint, font imports, the `prose.css` import, etc. After the rewrite, `git diff` shows what got clobbered. Restore by grepping for `// Custom:` and `// Custom override:` comments in the diff — those mark every intentional Epicenter deviation.

### What not to edit

Component class strings (`rounded-4xl`, `bg-primary`, etc.) reference theme variables. Don't search-and-replace them — change the underlying variable instead. The whole point of the variable layer is that one edit propagates everywhere.

## Component Management Workflow

### Adding New Components

```bash
# Add a new component
bunx shadcn-svelte@latest add dialog

# The component will be added to packages/ui/src/dialog/
```

### Updating Components

1. Run the add command with the `--overwrite` flag:

   ```bash
   bunx shadcn-svelte@latest add dialog --overwrite
   ```

2. Review the diff carefully, especially:
   - Custom style overrides (marked with comments)
   - Import path changes
   - Any custom props or functionality

### Import Path Convention

Always use the `#/` alias for internal imports within the UI package:

```typescript
// ❌ Don't use relative imports
import { Button } from '../button';

// ✅ Do use # alias
import { Button } from '#/button';
```

## Directory Structure

```
packages/ui/
├── src/
│   ├── accordion/
│   │   ├── accordion.svelte
│   │   ├── accordion-content.svelte
│   │   ├── accordion-item.svelte
│   │   ├── accordion-trigger.svelte
│   │   └── index.ts
│   ├── button/
│   │   ├── button.svelte
│   │   └── index.ts
│   ├── utils.ts
│   └── app.css
├── components.json
├── package.json
└── tsconfig.json
```

## Best Practices

1. **Keep Components Pure**: Don't add business logic to UI components
2. **Use Barrel Exports**: Each component folder should have an `index.ts`
3. **Document Overrides**: Always comment custom style additions
4. **Test After Updates**: Verify components work after shadcn updates
5. **Consistent Imports**: Use `#/` alias throughout the package

## TypeScript Path Resolution

The `#` symbol is configured in `tsconfig.json`:

```json
{
	"compilerOptions": {
		"paths": {
			"#": ["./src"],
			"#/*": ["./src/*"]
		}
	}
}
```

This configuration:

- Maps `#` to the `src` directory
- Enables autocomplete in your IDE
- Ensures consistent import paths
- Works with both TypeScript and bundlers
- Aligns with the Node.js subpath imports defined in `package.json`

## Troubleshooting

### Import Resolution Issues

If imports aren't resolving:

1. Check `tsconfig.json` paths configuration
2. Ensure your IDE recognizes the TypeScript config
3. Restart the TypeScript language server

### Style Conflicts

If custom styles aren't applying:

1. Check the order in the `cn()` function
2. Ensure custom styles come after base styles
3. Use more specific selectors if needed

### Component Updates

When updating breaks functionality:

1. Check the shadcn-svelte changelog
2. Review our custom overrides
3. Test thoroughly before committing
