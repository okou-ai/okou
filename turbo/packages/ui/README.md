# @okouai/ui

Shared React components, semantic styles, and utilities for Okou applications.

## Package Interface

Use the exports declared in [package.json](package.json). For example:

```tsx
import { Button } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui/lib/utils";
```

The shared stylesheet is available as `@okouai/ui/styles/globals.css`; import it
at the application's style entry point. Component exports and variants live in
[src/index.ts](src/index.ts) and [src/components/ui](src/components/ui). Check the
current component API before adding a parallel implementation.

## Styles

[The App style guide](../../../docs/app/styles.md) defines token ownership,
Tailwind usage, and the exact global/third-party exception boundary. The actual
theme contract lives in [globals.css](src/styles/globals.css). Keep palette and
font values there instead of copying them into this README.

Use semantic Tailwind utilities in consuming components. Shared components use
`cn()` for class composition and Lucide for icons. Do not add component-local
stylesheets, first-party selectors, or a second token system.

## Development

Install workspace dependencies from `turbo/`. Package scripts in
[package.json](package.json) define lint, type checks, tests, and component
generation. Select the checks and consumers relevant to the change using
[project verification](../../../CLAUDE.md#development-and-verification).
