# Browser connection diagnostics

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-connection-diagnostics.test.tsx](browser-connection-diagnostics.test.tsx).

Batch 38 accepted 01, 02, 03 and 05.03. Selected ID 06 remains pending.

## browser-connection-diagnostics-01

Original test `A bridge bootstrap failure keeps safe CDP facts in its semantic startup report`.

Registered test `A bridge bootstrap failure keeps safe CDP facts in its semantic startup report`.

- **Given** The native event bridge fails during browser startup.
- **When** The viewer cannot complete startup.
- **Then** The viewer is marked unavailable and input is disabled. The external report identifies the failed stage and safe code without private connection or worker details.

## browser-connection-diagnostics-02

Original test `Revalidating an opening viewer retains its native startup and keeps cancellation quiet`.

Registered test `Revalidating an opening viewer retains its native startup and keeps cancellation quiet`.

- **Given** The browser viewer is still opening.
- **When** Session details refresh while the native connection is pending.
- **Then** Input becomes available when the original connection opens, without a duplicate connection or cancellation report.

## browser-connection-diagnostics-03

Original test `A handled background lookup stays quiet while the selected page remains usable`.

Registered test `A handled background lookup stays quiet while the selected page remains usable`.

- **Given** The user has a usable selected page.
- **When** A background lookup for a duplicate page fails, and the user navigates the selected page.
- **Then** Navigation succeeds, input stays available, and the handled lookup emits no product exception.

## browser-connection-diagnostics-04

Original test `A native %s retains local feedback without a product exception`.

- **Given** The viewer is ready.
- **When** The user submits a destination that the native browser rejects, then submits a working destination.
- **Then** The first attempt shows local feedback once without a product exception. Input stays usable, and the successful navigation clears the message.

Examples

- `browser-connection-diagnostics-04.01` Navigation is aborted
  Registered test `A native net::ERR_ABORTED retains local feedback without a product exception`.
- `browser-connection-diagnostics-04.02` The client blocks navigation
  Registered test `A native net::ERR_BLOCKED_BY_CLIENT retains local feedback without a product exception`.
- `browser-connection-diagnostics-04.03` An administrator blocks navigation
  Registered test `A native net::ERR_BLOCKED_BY_ADMINISTRATOR retains local feedback without a product exception`.

## browser-connection-diagnostics-05

Original test `$label reports safe attribution and leaves the viewer usable`.

- **Given** The viewer is ready.
- **When** The user submits a destination that fails unexpectedly, then submits a working destination.
- **Then** The first attempt shows local feedback and one external report with a safe reason and no private URL detail. Input stays available and successful navigation clears the notice.

Examples

- `browser-connection-diagnostics-05.01` Known name resolution failure retains its safe reason
  Registered test `A known native failure reports safe attribution and leaves the viewer usable`.
- `browser-connection-diagnostics-05.02` Unknown error containing a private URL is classified as unknown
  Registered test `An unknown native failure reports safe attribution and leaves the viewer usable`.
- `browser-connection-diagnostics-05.03` An abort token with extra private text is classified as unknown
  Registered test `An expected token with extra native text reports safe attribution and leaves the viewer usable`.

## browser-connection-diagnostics-06

Original test `An unhandled navigation request failure still reports without disconnecting`.

Registered test `An unhandled navigation request failure still reports without disconnecting`.

- **Given** The viewer is ready.
- **When** An unhandled provider failure interrupts navigation.
- **Then** The viewer gives local feedback and remains usable. External diagnostics retain the safe classification and request details without the private provider message.
