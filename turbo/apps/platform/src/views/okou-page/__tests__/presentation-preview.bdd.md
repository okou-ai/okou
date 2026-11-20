# Presentation preview

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [presentation-preview.test.tsx](presentation-preview.test.tsx).

## presentation-preview-001

Original test `Selecting a slide preserves its authored layout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-preview.test.tsx#L149).

- **Given** A saved presentation template has two authored slides, with the second slide hidden and its layout styled as flex inside a grid wrapper.
- **When** The user selects slide 2 for preview.
- **Then** The preview contains only slide 2; its wrapper and slide are visible, not inert, and marked as not hidden from assistive technology. Their authored grid and flex layouts remain intact, and slide 2 is marked selected.

## presentation-preview-002

Original test `A generically authored deck still previews`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-preview.test.tsx#L222).

- **Given** A presentation template uses generic slide elements rather than the presentation-specific slide marker.
- **When** The user selects slide 2 for preview.
- **Then** The preview contains only the second generic slide and its content. The content is associated with slide 2 and has an editor edit identifier.

## presentation-preview-003

Original test `A presentation slide fills its preview frame cleanly`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-preview.test.tsx#L255).

- **Given** A presentation slide and nested stage are authored at viewport dimensions with rounded corners, shadows, and stage maximum dimensions.
- **When** The presentation is opened in preview.
- **Then** The slide and stage fill the frame at 100% width and height; their shadows and corner radii are removed, and the stage maximum dimensions are unset.

## presentation-preview-004

Original test `Presentation previews preserve the selected theme`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/presentation-preview.test.tsx#L290).

- **Given** A presentation template has a selected theme with palette colors and Studio fonts applied by its script.
- **When** The presentation is opened in preview.
- **Then** The preview retains the theme colors and Fraunces and Inter fonts, materializes the theme, removes the script, and displays the themed slide content.
