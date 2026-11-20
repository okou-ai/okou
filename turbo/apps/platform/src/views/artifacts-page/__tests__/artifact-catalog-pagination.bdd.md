# Artifact catalog pagination

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-catalog-pagination.test.tsx](artifact-catalog-pagination.test.tsx).

## artifact-catalog-pagination-001

Original test `A deep-linked artifact preview opens over its catalog and closes back to it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-pagination.test.tsx#L26).

- **Given** The user opens a deep link to an image artifact in the Images catalog; the selected image is on a later catalog page.
- **When** The deep-linked preview opens, then the user closes it.
- **Then** The image preview displays the artifact URL while the catalog remains at /artifacts with the image tab and artifact ID in the URL. The image is also present in the catalog. Closing removes the artifact parameter, keeps the image tab and catalog path, and leaves the image available in the catalog.

## artifact-catalog-pagination-002

Original test `Scrolling through artifacts appends later results without losing earlier ones`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-pagination.test.tsx#L105).

- **Given** The Files catalog has a first page containing first-page.txt and a later page containing second-page.txt.
- **When** The user scrolls near the end of the catalog.
- **Then** The later result is appended, and both second-page.txt and the earlier first-page.txt remain available.
