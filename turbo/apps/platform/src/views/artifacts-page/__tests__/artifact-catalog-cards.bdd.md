# Artifact catalog cards

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-catalog-cards.test.tsx](artifact-catalog-cards.test.tsx).

## artifact-catalog-cards-001

Original test `Artifact cards identify their kind and show available previews`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-cards.test.tsx#L14).

- **Given** The catalog contains a text file, a hosted site with a thumbnail, and an avatar video.
- **When** The user views the artifact cards.
- **Then** The hosted site is identified as a hosted-site artifact and shows its available thumbnail preview; the video is identified as an avatar artifact. The text file is available as an artifact action.

## artifact-catalog-cards-002

Original test `A video artifact without a poster uses its source as the catalog preview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-cards.test.tsx#L57).

- **Given** The Video catalog contains a video artifact named product-tour.mp4 without a poster and with a video source URL.
- **When** The user views the catalog card.
- **Then** The card uses the video source URL, with a 0.001-second start offset, as its preview.

## artifact-catalog-cards-003

Original test `Re-read the catalog when one of the member's artifacts changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-catalog-cards.test.tsx#L82).

- **Given** The catalog initially contains launch-plan.txt.
- **When** The member's artifact changes and the catalog receives an artifact-change event.
- **Then** The catalog is read again and shows synced-plan.txt.
