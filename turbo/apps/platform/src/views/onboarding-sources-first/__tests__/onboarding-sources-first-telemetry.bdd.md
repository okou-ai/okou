# Onboarding sources first telemetry

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [onboarding-sources-first-telemetry.test.tsx](onboarding-sources-first-telemetry.test.tsx).

## onboarding-sources-first-telemetry-001

Original test `Skipping sources reports the step skip and keeps a single onboarding start`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-telemetry.test.tsx#L106).

- **Given** A user who needs onboarding is choosing an industry and has not connected a source.
- **When** They skip the sources step, dismiss the confirmation by choosing to connect a tool, then skip again and choose to skip for now.
- **Then** They reach the experience question. The sources skip is reported once with the sources step, its route, and owner status; the onboarding-start marketing event is recorded only once, and dismissing the confirmation records no skip.

## onboarding-sources-first-telemetry-002

Original test `Each step reports its position in the flow without an invitation step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-telemetry.test.tsx#L174).

- **Given** A user who needs onboarding starts the source-first flow and has a connector catalog available.
- **When** They select Marketing & content, continue through sources, then choose Start with Okou.
- **Then** Analytics reports the industry step at position 0 of 6, sources at position 1 of 6, and experience at position 2 of 6, with no invitation step viewed. It reports the selected marketing industry and that the user has not experienced Okou, with no provider.

## onboarding-sources-first-telemetry-003

Original test `A source card starts OAuth directly and reports a successful connect (mobile=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-telemetry.test.tsx#L247).

- **Given** A user who needs onboarding is on the sources step with Notion unconnected and the app is not in mobile layout.
- **When** They choose Connect Notion and complete the OAuth connection.
- **Then** OAuth starts directly for Notion with add-account intent, and the authorization page opens without a Notion dialog. Analytics reports the grid-origin connection start and successful connection; the page shows Connected and enables Continue.

## onboarding-sources-first-telemetry-004

Original test `A source card starts OAuth directly and reports a successful connect (mobile=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-telemetry.test.tsx#L247).

- **Given** A user who needs onboarding is on the sources step with Notion unconnected and the app is in mobile layout.
- **When** They choose Connect Notion and complete the OAuth connection.
- **Then** OAuth starts directly for Notion with add-account intent, and the authorization page opens without a Notion dialog. Analytics reports the grid-origin connection start and successful connection; the page shows Connected and enables Continue.

## onboarding-sources-first-telemetry-005

Original test `The starting prompt reports its length, never the request itself`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/onboarding-sources-first/__tests__/onboarding-sources-first-telemetry.test.tsx#L350).

- **Given** A user who needs onboarding is on the first-task page.
- **When** They enter “Summarise last week for me” and start their first task.
- **Then** PromptEdited and StartClicked analytics events report that the prompt was edited and its length, but neither event data nor the serialized analytics events contain the prompt text.
