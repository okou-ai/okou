# Custom connector create lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [custom-connector-create-lifecycle.test.tsx](custom-connector-create-lifecycle.test.tsx).

## custom-connector-create-lifecycle-001

Original test `A completed creation preserves a newer connector draft and directory search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-create-lifecycle.test.tsx#L15).

- **Given** An organization admin is viewing custom connectors with no connectors listed.
- **When** They start creating an HTTP connector named “First API” with the prefix http://api.acme.test/v1/ and API authentication, close the pending creation, search for “first,” and open a new connector form with the name “Second API draft.” The first creation then completes.
- **Then** The new “First API” connector appears. The second creation form remains open with “Second API draft,” and the directory search still contains “first.”

## custom-connector-create-lifecycle-002

Original test `Reveal and focus a newly created connector in the directory`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-connector-create-lifecycle.test.tsx#L82).

- **Given** An organization admin is viewing an empty custom connector directory.
- **When** They create an HTTP connector named “First API” with the prefix http://api.acme.test/v1/ and API authentication.
- **Then** The creation form closes, and focus moves to content containing “First API.”
