# Artifact catalog sidebar

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-catalog-sidebar.test.tsx](artifact-catalog-sidebar.test.tsx).

## artifact-catalog-sidebar-001

Original test `Text artifacts use the sidebar only when sidebar previews are enabled (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-sidebar.test.tsx#L51).

- **Given** The catalog contains the text file launch-plan.txt and sidebar previews are disabled.
- **When** The user opens the file.
- **Then** The preview shows “The launch plan is ready” in the attachment lightbox, not the artifact sidebar. Closing it returns to the catalog with the file available.

## artifact-catalog-sidebar-002

Original test `Text artifacts use the sidebar only when sidebar previews are enabled (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-sidebar.test.tsx#L51).

- **Given** The catalog contains the text file launch-plan.txt and sidebar previews are enabled.
- **When** The user opens the file.
- **Then** The preview shows “The launch plan is ready” in the artifact sidebar, not the attachment lightbox. Closing it returns to the catalog with the file available.

## artifact-catalog-sidebar-003

Original test `HEIC catalog previews convert extensionless image sources (sidebar=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-sidebar.test.tsx#L92).

- **Given** The catalog contains iPhone.heic with an extensionless private image URL, and sidebar previews are disabled.
- **When** The user opens the image.
- **Then** The lightbox image source uses the CDN image-conversion URL with fit=scale-down, format=auto, quality=85, and metadata=none wrapped around the original URL.

## artifact-catalog-sidebar-004

Original test `HEIC catalog previews convert extensionless image sources (sidebar=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-sidebar.test.tsx#L92).

- **Given** The catalog contains iPhone.heic with an extensionless private image URL, and sidebar previews are enabled.
- **When** The user opens the image.
- **Then** The sidebar image source uses the CDN image-conversion URL with fit=scale-down, format=auto, quality=85, and metadata=none wrapped around the original URL.

## artifact-catalog-sidebar-005

Original test `A routed website preview opens in the sidebar and Close returns to its catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-sidebar.test.tsx#L119).

- **Given** The catalog is showing the routed Release website preview in the sidebar at its release URL.
- **When** The user enters fullscreen, exits fullscreen, then closes the preview.
- **Then** Fullscreen can be entered and exited; closing returns the URL to the hosted-site catalog without an artifact query, hides the sidebar, and leaves Release website available in the catalog.

## artifact-catalog-sidebar-006

Original test `Binary artifacts open a download-capable sidebar instead of downloading on click`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-sidebar.test.tsx#L160).

- **Given** The catalog contains the binary file release-bundle.zip and sidebar previews are enabled.
- **When** The user opens the file.
- **Then** A sidebar displays the filename and a Download artifact button. No download starts on open, and no attachment lightbox appears.

## artifact-catalog-sidebar-007

Original test `An avatar sidebar reuses the private video URL already shown by its card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-sidebar.test.tsx#L178).

- **Given** The avatar.mp4 card displays its private video URL resolved from the artifact reference.
- **When** The user opens the avatar card.
- **Then** The sidebar video preview uses the same private URL already displayed by the card, without resolving a different URL, and no attachment lightbox appears.

## artifact-catalog-sidebar-008

Original test `Closing a loading sidebar cancels its preview and allows a later reopen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-sidebar.test.tsx#L220).

- **Given** The catalog contains pending.pdf, and loading its artifact details has not completed.
- **When** The user opens the sidebar and closes it before details load, then allows the pending request to finish and opens the file again.
- **Then** The first sidebar closes. Reopening loads the PDF preview at its artifact URL with #navpanes=0, and no attachment lightbox appears.
