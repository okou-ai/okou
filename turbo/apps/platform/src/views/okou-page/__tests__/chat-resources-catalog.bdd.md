# Chat resources catalog

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-resources-catalog.test.tsx](chat-resources-catalog.test.tsx).

## chat-resources-catalog-001

Original test `Browse artifacts without source URLs in the popover and sidebar without showing message links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L37).

- **Given** A chat has a file artifact with no source URL, and message text contains links.
- **When** The user browses artifacts and opens the artifact from the resource panel and sidebar.
- **Then** The artifact title reveals on hover, its detail shows the downloaded filename, download action, and preview, and the artifact list can be revisited. The list does not show message-link tabs.

## chat-resources-catalog-002

Original test `Render the hosted-site resource title as Quarterly report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L137).

- **Given** The resource catalog contains a hosted-site artifact titled “Quarterly report” with an alias URL.
- **When** The user browses the resources.
- **Then** The artifact is listed as “Quarterly report.”

## chat-resources-catalog-003

Original test `Render the presentation resource title as Report presentation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L137).

- **Given** The resource catalog contains a presentation artifact titled “Report presentation” with an alias URL.
- **When** The user browses the resources.
- **Then** The artifact is listed as “Report presentation.”

## chat-resources-catalog-004

Original test `Render the hosted-site resource title as Private report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L137).

- **Given** The resource catalog contains a hosted-site artifact titled “Private report” without an alias URL.
- **When** The user browses the resources.
- **Then** The artifact is listed as “Private report.”

## chat-resources-catalog-005

Original test `Copy an artifact's on-demand detail URL without opening its preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L168).

- **Given** A file artifact has no source URL, but its detail has a usable file URL.
- **When** The user chooses Copy link without opening the preview.
- **Then** The app reports “Link copied,” writes the artifact URL to the clipboard, and does not open the artifact preview.

## chat-resources-catalog-006

Original test `Copying a private artifact reports failure without exposing its signed or authenticated URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L184).

- **Given** A private artifact detail resolves to signed storage URLs and has no public URL.
- **When** The user chooses Copy link.
- **Then** The app reports “Could not copy the link,” writes nothing to the clipboard, does not open the preview, and leaves the artifact available. It does not expose the signed or authenticated URL.

## chat-resources-catalog-007

Original test `Copying an unavailable artifact reports failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L228).

- **Given** The artifact detail request returns not found.
- **When** The user chooses Copy link for the listed artifact.
- **Then** The app reports “Could not copy the link,” and writes nothing to the clipboard.

## chat-resources-catalog-008

Original test `Copying an artifact reports a browser clipboard failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L252).

- **Given** The browser clipboard rejects a write with a permission error.
- **When** The user chooses Copy link for an artifact.
- **Then** The app reports “Could not copy the link” and does not open the preview.

## chat-resources-catalog-009

Original test `Show more resources until the last page, then collapse with the same control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L282).

- **Given** The resource catalog contains 125 artifacts, and three are initially shown.
- **When** The user uses Show more through successive pages, then collapses and expands the list again.
- **Then** The list grows to 120 and then 125 unique items; the control changes to Collapse only at the last page. Collapsing returns to three items, and expanding again restores all 125.

## chat-resources-catalog-010

Original test `Disable show more while loading and keep resource pages unique`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L333).

- **Given** The resource catalog contains 125 artifacts, with the next page request held pending.
- **When** The user requests another page and repeatedly activates Show more while it loads, then the request completes.
- **Then** Show more is disabled and busy during loading, the existing 60 items remain unique, and focus stays on the control. After loading, 120 unique items are shown, the control is enabled, and item 121 is absent.

## chat-resources-catalog-011

Original test `Retain loaded resources after a paging failure and retry with show more`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L385).

- **Given** The first page of 60 resources loads, but the next page request fails.
- **When** The user retries Show more after the request becomes available.
- **Then** The failure is reported without removing the 60 loaded resources, and Show more remains enabled. Retrying succeeds, displays all 65 resources, clears the error, and changes the control to Collapse.

## chat-resources-catalog-012

Original test `Copy link tooltips follow resource focus and close when their row collapses`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L427).

- **Given** Four resources are available, with three initially shown and the fourth shown after expansion.
- **When** The user hovers one row’s Copy link button, focuses another, collapses the list, then focuses and activates a remaining row’s Copy link button.
- **Then** The tooltip follows the focused button and closes when its row is collapsed. Activating the remaining row copies its link.

## chat-resources-catalog-013

Original test `Copy the focused resource after moving between open copy tooltips`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L474).

- **Given** Four resources are shown, and the first resource’s Copy link tooltip is open.
- **When** The user focuses the fourth resource’s Copy link button and presses Enter.
- **Then** Only the focused resource’s tooltip remains open, the fourth resource’s URL is copied, and focus remains on its Copy link button.
