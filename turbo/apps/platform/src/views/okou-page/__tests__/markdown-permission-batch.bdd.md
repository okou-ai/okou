# Markdown permission batch

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [markdown-permission-batch.test.tsx](markdown-permission-batch.test.tsx).

## markdown-permission-batch-001

Original test `A markdown batch link renders grouped permissions without duplicate rows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L72).

- **Given** The user views Markdown containing a batch authorization link with Slack `files:read` listed twice and GitHub `repos.read` once; neither permission is already allowed.
- **When** The user opens the link and reviews the permissions.
- **Then** The card shows 2 permissions to allow, without duplicating the repeated Slack permission; the dialog lists the Slack and GitHub permission descriptions and each permission once, while the surrounding Markdown remains visible.

## markdown-permission-batch-002

Original test `A batch card shows three service logos and exposes every service in its overflow tooltip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L177).

- **Given** The user views a batch authorization link listing one permission each for Slack, GitHub, Google Drive, Notion, and Linear, with none already allowed.
- **When** The user views the card and hovers over its service-logo button.
- **Then** The card shows 5 permissions to allow, displays three service logos and a `+2` indicator, and the tooltip lists all five services.

## markdown-permission-batch-003

Original test `A partially allowed batch shows the remaining permission count`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L210).

- **Given** The user views a batch authorization link for Slack `files:read` and GitHub `repos.read`; Slack's permission is already allowed.
- **When** The batch card loads.
- **Then** It shows 1 permission to allow and 1 already allowed, and the Review permissions button is enabled.

## markdown-permission-batch-004

Original test `A batch stays reviewable while service details load and enables duration only when ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L235).

- **Given** The user views a batch authorization link for two Slack permissions and one GitHub permission while service details are still loading.
- **When** The user opens the review dialog before the details finish loading, then the details become available.
- **Then** The card and dialog remain reviewable during loading, the dialog shows two loading groups containing two and one permissions, and duration selection and allowing all three are disabled. Once ready, both services and all three permissions appear, and duration selection and allowing all three are enabled.

## markdown-permission-batch-005

Original test `A batch card reports saving and then allowed after the user confirms`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L294).

- **Given** The user views a batch authorization link for two permissions that are not yet allowed.
- **When** The user reviews the permissions and confirms allowing both.
- **Then** The card reports Saving... while the request is pending and the duration selector is disabled; after success it reports Permissions allowed, and closing the dialog leaves an enabled View permission details button.

## markdown-permission-batch-006

Original test `An invalid batch query renders the unavailable action instead of partial permissions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L383).

- **Given** The user views a batch authorization URL with a duplicated `action=allow` query parameter while batch permissions are enabled.
- **When** The Markdown link is processed.
- **Then** An unavailable action card appears instead of a partially rendered permissions card.

## markdown-permission-batch-007

Original test `A batch link stays an ordinary markdown link while the feature is disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/markdown-permission-batch.test.tsx#L392).

- **Given** The user views a batch authorization link while the batch-permissions feature is disabled.
- **When** The Markdown is rendered.
- **Then** The link remains an ordinary Markdown link with its original URL.
