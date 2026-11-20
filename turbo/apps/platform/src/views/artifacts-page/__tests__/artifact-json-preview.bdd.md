# Artifact json preview

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-json-preview.test.tsx](artifact-json-preview.test.tsx).

## artifact-json-preview-001

Original test `An Artifacts catalog JSON file shares the source-aware tree viewer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-json-preview.test.tsx#L15).

- **Given** The Artifacts file catalog contains catalog.json with JSON source `{"catalog":{"items":[1,2],"version":1.00}}`.
- **When** The user opens the JSON preview, expands catalog and items, then selects Source.
- **Then** The tree shows the numeric value as 1.00 and the items array as [1]. Source view displays the exact original JSON text.
