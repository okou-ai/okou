# Preview access

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [preview-access.test.tsx](preview-access.test.tsx).

## preview-access-001

Original test `A lookalike host cannot forward preview access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/preview-access/__tests__/preview-access.test.tsx#L11).

- **Given** A user opens an export page on the lookalike host pr-431-app.omby.ai.evil.example with a preview-access query parameter.
- **When** The export page requests the user's export status.
- **Then** The Export data heading is visible, and the preview-access secret is not forwarded to the API.

## preview-access-002

Original test `Trusted preview access reaches the matching preview API`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/preview-access/__tests__/preview-access.test.tsx#L30).

- **Given** A user opens an export page on the trusted preview host pr-431-app.omby.ai with a preview-access query parameter.
- **When** The export page requests the user's export status.
- **Then** The Export data heading is visible, and the preview-access secret is forwarded to the matching preview API at pr-431-api.vm6.ai.
