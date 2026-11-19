# Shared thread attachments

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-thread-attachments.test.tsx](shared-thread-attachments.test.tsx).

## shared-thread-attachments-001

Original test `Signed-out visitors see prompt thumbnails stored as png and open original files`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-attachments.test.tsx#L14).

- **Given** A signed-out visitor views a shared prompt containing a PNG screenshot and a PDF attachment.
- **When** They view the attachments.
- **Then** Both attachments link to their original files and open in a new tab safely. The screenshot thumbnail is shown using the 480-by-320 thumbnail variant.

## shared-thread-attachments-002

Original test `Shared Markdown images use thumbnails and preserve their destination (linked=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-attachments.test.tsx#L67).

- **Given** A visitor views an unlinked shared Markdown image.
- **When** The image loads.
- **Then** An 800-by-720 thumbnail is shown, and its link destination remains the image URL.

## shared-thread-attachments-003

Original test `Shared Markdown images use thumbnails and preserve their destination (linked=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-attachments.test.tsx#L67).

- **Given** A visitor views a shared Markdown image linked to a report URL.
- **When** The image loads.
- **Then** An 800-by-720 thumbnail is shown, and its link destination remains the report URL rather than the image URL.

## shared-thread-attachments-004

Original test `Attachment-only prompts remain visible and active content is a file link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-attachments.test.tsx#L100).

- **Given** A visitor views a prompt with no text and an SVG attachment.
- **When** They view the attachment.
- **Then** The attachment remains available as a link to the original file in a new tab, without rendering it as an image.

## shared-thread-attachments-005

Original test `A shared website without a cover previews in an iframe and preserves its destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-thread-page/__tests__/shared-thread-attachments.test.tsx#L133).

- **Given** A visitor views a shared website without a cover image.
- **When** The website preview loads.
- **Then** A card shows its title and previews the site in an iframe. The card preserves the destination, opens it in a new tab safely, and is not rendered inside a paragraph.
