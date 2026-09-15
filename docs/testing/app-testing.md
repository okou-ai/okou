# Platform Testing Patterns

This guide describes the canonical testing patterns for
`turbo/apps/platform`.

## Test Categories

Platform Vitest tests are page-level integration tests by default. Enter
through the same bootstrapped Router used by production and assert behavior a
user can observe. Keep page tests in the relevant `views/**/__tests__`
directory with a `.test.tsx` or `.test.ts` suffix.

Use a signal bootstrap test only when the behavior has no page-visible surface
and still needs the production Platform bootstrap path. Follow the
[external behavior boundary](testing-external-behavior.md) when a state cannot
be constructed through a production interface.

Do not add helper-only, component-only, or static-configuration unit tests when
a rendered page can cover the behavior.

## Canonical Page Test

`setupPage` is the canonical public helper that starts Platform. It initializes
the requested locale, awaits finite production bootstrap/setup, renders the
complete Router, and resolves after the first page content is observable.
Background loops are owned by their shared starters; ordinary setup does not
detach a pending route setup. Always await it before the first page assertion.

Startup belongs to the test context's original abort signal. Cancelling that
lifetime rejects `setupPage()` and a pending `startPage().ready`; cancellation
is not page readiness. Tests that inspect blocked startup may leave
`startPage().ready` unawaited: the shared helper owns its cancellation rejection
and observer cleanup.

Every page test follows this order:

1. Configure fixtures and external mocks.
2. Call `setupPage`.
3. Observe the smallest rendered or accessible state that proves the page is ready.
4. Perform one user-visible action.
5. Wait for and assert the resulting behavior.
6. Repeat the action/result cycle for any remaining steps.

```typescript
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function getButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

test("A user confirms the billing upgrade", async () => {
  context.mocks.api(someContract.get, ({ respond }) => {
    return respond(200, fixture);
  });

  await setupPage({
    context,
    path: "/settings?tab=billing",
    host: "app.okou.ai",
    auth: {
      user: { id: "user_123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_123", name: "Test Organization" },
        memberships: [{ id: "org_123" }],
      },
    },
  });

  expect(await screen.findByText("Billing")).toBeInTheDocument();

  click(getButtonByName("Upgrade"));

  const dialog = await screen.findByRole("dialog", {
    name: "Confirm upgrade",
  });
  expect(within(dialog).getByText("$20/month")).toBeInTheDocument();
  await waitFor(() => {
    expect(getButtonByName("Confirm", dialog)).toBeEnabled();
  });
});
```

Install every mock before `setupPage`. Keep the loaded-state wait and first
action on separate lines, and execute each action exactly once.

## `setupPage` Options

`context` and `path` are required. `path` may include a query string and hash.
`host` is a hostname without a scheme, path, or port and defaults to
`localhost`; localhost uses HTTP and other hosts use HTTPS. Use `host` and
`path` for the initial page URL. Lower-level browser URL mocks are reserved for
pure URL or runtime-environment tests that need a port, complete URL, or custom
API-origin marker.

Initial authentication and organization state belongs in `auth`:

- Omitting `auth` creates the standard signed-in user, session, active
  organization, and membership.
- `auth: null` creates a complete signed-out state with no user, session,
  active organization, or memberships.
- An auth object requires a user. Omitted organization and session values use
  the standard signed-in defaults.
- `session: null` inside an auth object means a known user without a token. It
  is not the signed-out state.

Use `featureSwitches` to configure the mocked authoritative API response.
Before that response arrives, the App uses repository defaults rather than
browser-persisted switch state. `debugLoggers` and the documented
shared-database lifecycle options are also owned by the page's test context.

## Synchronization and Queries

Wait for the smallest observable state that proves readiness for the next
action. Do not wait for a generic bootstrap promise, unrelated skeleton,
arbitrary delay, or sleep.

Testing Library's accessible-name calculation is slow for roles whose name is
normally derived from subtree text. Do not use `getByRole`, `getAllByRole`,
`findByRole`, or `findAllByRole` for these roles:

```text
button
link
menuitem
menuitemcheckbox
menuitemradio
radio
tab
cell
columnheader
rowheader
gridcell
```

Use `queryAllByRoleFast` and match exact trimmed `textContent` or `aria-label`.
Pass the narrowest available container. Wrap a throwing getter in `waitFor`
only when that element is itself the synchronization point.

Regular `findByRole` remains appropriate for structural, form, and status
roles such as `dialog`, `heading`, `alert`, `status`, `region`, `form`,
`textbox`, `combobox`, `option`, `switch`, `group`, and `article`. Use
`findByLabelText` for form controls, `findByText` for ordinary content, and
`findByTestId` only when no stable accessible query exists.

`waitFor` callbacks may run many times. They contain queries and assertions
only: never actions, fixture mutation, mock triggers, or deferred resolution.
Await one representative sentinel and synchronously assert other state from
the same transition. Retain an element before passing it to
`waitForElementToBeRemoved`. A negative assertion must follow a positive causal
completion point.

## User Actions

- Use the synchronous `click(element)` helper for ordinary clicks. Do not await
  it.
- Use `await fill(element, value)` to replace input or contenteditable content.
- Use `userEvent` only when full keyboard, hover, upload, focus, pointer, or
  clipboard behavior matters. Await every `userEvent` operation.
- Use `fireEvent` only for an exact low-level submit, scroll, load,
  composition, drag, transition, or controlled-input event.
- Trigger realtime, popup, visibility, and similar external events through
  `context.mocks`, then wait for their observable page result.
- Use `act` only when an external source bypasses Testing Library and
  synchronously schedules a React update.
- Do not replace a page action with `context.store.set` when the page exposes
  the action.

## Assertions

Default to `toBeInTheDocument()` when checking that content, a toast, a dialog,
or a control has rendered. For asynchronous content, await the appropriate
`findBy*` query and assert presence:

```typescript
await expect(screen.findByText("Changes saved")).resolves.toBeInTheDocument();
```

Once the expected content is found, do not add `toBeVisible()` or another
`waitFor` solely to confirm that it rendered. Text can already exist in the DOM
while an enter effect still leaves its container at `opacity: 0`. A presence
assertion avoids unnecessary computed-style checks and animation-dependent
synchronization.

Use `toBeVisible()` or `.not.toBeVisible()` only when showing or hiding an
element is itself the behavior under test, including content that stays in the
DOM while hidden. If that visibility changes asynchronously, wait for the
visibility assertion with `waitFor`.

Assert content, value, selected state, enabled or disabled state, focus,
accessibility relationships, navigation, opened destinations, clipboard writes,
and downloads when required by the contract. Presence alone does not establish
that a control is ready for interaction. Scope assertions with
`within(container)` after locating a dialog, form, card, or sidebar.

Capture a request body only when request construction is part of the behavior.
Assert third-party calls only when the call itself is the external contract.
Never assert internal signal, store, service, helper, request-count, DOM
identity, or cache-protocol details. Do not use snapshots in Platform page
tests.

## Network and External Boundaries

All application HTTP traffic is intercepted by MSW, and unhandled requests
fail the test. Prefer a typed contract mock:

```typescript
context.mocks.api(agentContract.get, ({ respond }) => {
  return respond(200, agentFixture);
});
```

Use `context.mocks.http` only when no typed contract exists. Do not mock
`fetch`, import the global MSW server into a page test, or call `server.use`
directly. Return realistic status codes and contract-valid shapes. Keep
stateful fixture ownership within the test mock lifecycle.

Module mocks are limited to external packages that cannot run in the test
environment, such as Clerk SDKs, analytics, error reporting, and
browser-incompatible adapters. Never mock an internal relative import. Use a
top-level `vi.mock`, `vi.hoisted` for factory state, typed `vi.importActual`
for partial external replacement, and a local `vi.spyOn` for a single browser
capability. Vitest and `testContext` own cleanup; do not add file-level cleanup
hooks.

## Time

Use Platform's production clock abstraction with an explicit reference value:

```typescript
const NOW = new Date("2026-06-11T16:00:00.000Z");

mockNow(NOW, context.signal);
```

`mockNow` always receives the value first and owning signal second. Derive
time-dependent fixtures from that value. Production and test code use `now()`
or `nowDate()` rather than `Date.now()`; only `lib/time.ts` may call
`Date.now()`. Do not use fake timers, `vi.setSystemTime`, or a `Date.now()`
spy. Continue using real timers with Testing Library queries and `waitFor`.

For a race that crosses a clock boundary between synchronous reads, `mockNow`
also accepts a `() => number` reader. Install it at the relevant external
response boundary and pass `context.signal` so the shared lifecycle removes
the override. Control only the returned time; keep timers and application
commands real.

## Test Context and Cleanup

Create one `testContext()` at file scope. It provides a fresh store and worker
store, an abort signal, and external mocks. Bind external resources to
`context.signal`. Do not manually clear detached work, browser storage, spies,
globals, or mocks in file-level cleanup hooks; the shared Vitest setup and test
context own that lifecycle.

`testContext` aborts the test's root signal. The existing global `afterEach` in
`src/test/setup.ts` then calls `clearAllDetached()` before resetting MSW handlers.
This is the single detached-work cleanup mechanism. Do not create a separate
promise registry or call `clearAllDetached()` from test cases or their hooks.
During the test, await the operation or its observable completion instead.
