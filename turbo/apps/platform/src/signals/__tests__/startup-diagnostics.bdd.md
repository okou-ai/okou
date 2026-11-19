# Startup diagnostics

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [startup-diagnostics.test.tsx](startup-diagnostics.test.tsx).

## startup-diagnostics-001

Original test `A failed stylesheet keeps Loading visible without reporting completed startup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/startup-diagnostics.test.tsx#L55).

- **Given** The main stylesheet fails to load while the member visits the Agents page.
- **When** Startup renders the route.
- **Then** The Agents heading is visible but inert, and the Loading status remains visible. No completed-startup or bootstrap-phase timing event is reported.

## startup-diagnostics-002

Original test `Startup releases keyboard isolation with the skeleton fade, without waiting for transitionend`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/startup-diagnostics.test.tsx#L90).

- **Given** The Agents page is rendered while its stylesheet is still loading; the heading is inert and the bootstrap skeleton is not hidden from assistive technology.
- **When** The stylesheet finishes loading and startup becomes ready.
- **Then** Keyboard isolation is released and the skeleton becomes aria-hidden without waiting for a transition-end event.

## startup-diagnostics-003

Original test `Startup timing is bounded and anonymous`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/startup-diagnostics.test.tsx#L122).

- **Given** A member opens a chat whose server snapshot and event response contain no conversation, with bootstrap timing initialized and PostHog enabled.
- **When** Startup completes and first-skeleton-paint telemetry is captured and passed through the analytics sanitizer.
- **Then** One bootstrap-phase timing event reports the chat route and not-found metadata source, with finite nonnegative durations and no thread ID. Paint timing reports the rounded navigation and paint measurements without private URL data; sanitized analytics uses the anonymous app-bootstrap identity and allows only the specified paint fields, with no private values.
