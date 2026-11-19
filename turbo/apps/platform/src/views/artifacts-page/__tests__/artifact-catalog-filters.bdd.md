# Artifact catalog filters

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-catalog-filters.test.tsx](artifact-catalog-filters.test.tsx).

## artifact-catalog-filters-001

Original test `Artifact kind filters remain available while switching catalogs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-filters.test.tsx#L21).

- **Given** The catalog shows a presentation artifact and the kind filters are available.
- **When** The user selects Avatars while the avatar catalog request is still pending, then the request completes.
- **Then** All seven filters—Presentations, Websites, Images, Videos, Avatars, Shared chats, and Files—remain available. Avatars stays selected during loading; afterward the avatar video is shown and the prior presentation is no longer shown.

## artifact-catalog-filters-002

Original test `Artifact kind filters remain available for an empty catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-filters.test.tsx#L82).

- **Given** The catalog is empty.
- **When** The user selects Files.
- **Then** All seven kind filters remain available, Files is selected, and the empty-catalog message remains visible.

## artifact-catalog-filters-003

Original test `A shared conversation links directly to its shared thread with sidebar preview false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-filters.test.tsx#L120).

- **Given** The artifact catalog initially shows a presentation and has a shared conversation available after its catalog request completes. Sidebar preview is disabled.
- **When** The user selects Shared chats and waits for the results.
- **Then** The shared conversation is a link to its shared-thread destination that opens in a new tab with safe link attributes, within a list item in a list.

## artifact-catalog-filters-004

Original test `A shared conversation links directly to its shared thread with sidebar preview true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-filters.test.tsx#L120).

- **Given** The artifact catalog initially shows a presentation and has a shared conversation available after its catalog request completes. Sidebar preview is enabled.
- **When** The user selects Shared chats and waits for the results.
- **Then** The shared conversation is a link to its shared-thread destination that opens in a new tab with safe link attributes, within a list item in a list.

## artifact-catalog-filters-005

Original test `A routed shared conversation opens its shared thread with sidebar preview false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-filters.test.tsx#L187).

- **Given** A shared conversation is available in the catalog and its details can be loaded. Sidebar preview is disabled.
- **When** The user opens the artifact route for that shared conversation.
- **Then** The browser is directed to the shared thread destination.

## artifact-catalog-filters-006

Original test `A routed shared conversation opens its shared thread with sidebar preview true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-filters.test.tsx#L187).

- **Given** A shared conversation is available in the catalog and its details can be loaded. Sidebar preview is enabled.
- **When** The user opens the artifact route for that shared conversation.
- **Then** The browser is directed to the shared thread destination.
