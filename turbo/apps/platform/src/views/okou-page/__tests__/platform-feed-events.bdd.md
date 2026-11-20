# Platform feed events

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [platform-feed-events.test.tsx](platform-feed-events.test.tsx).

## platform-feed-events-001

Original test `A fast event destination replaces its initially hidden loading status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L172).

- **Given** A member opens a platform event for a disabled automation, and its destination loads quickly.
- **When** They select View automation.
- **Then** The loading status is initially hidden and disappears after access resolves. The exact hourly automation is selected and remains disabled.

## platform-feed-events-002

Original test `A pending event destination shows a lightweight status until access resolves`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L190).

- **Given** A member opens a platform event for a disabled automation while its destination request is pending.
- **When** They select View automation before access resolves.
- **Then** A visible busy loading status appears. Once access resolves, the exact hourly automation is selected and remains disabled.

## platform-feed-events-003

Original test `A failed destination can retry through the loading status and reach the same automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L210).

- **Given** A member visits the destination for a disabled automation, but the first load fails with a server error.
- **When** They choose Try again and the retry remains pending before succeeding.
- **Then** The page offers a Back to workflows link, shows a loading status during the retry, and reaches the same hourly automation without enabling it.

## platform-feed-events-004

Original test `View automation rechecks access and focuses the exact current automation without enabling it or its sibling`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L237).

- **Given** A member opens an event for one disabled hourly automation; the workflow also has a separate enabled two-hour automation.
- **When** They select View automation.
- **Then** Access is checked again, the exact hourly automation is focused and selected, and neither automation's enabled state changes. The destination retains the exact automation and workspace in its URL.

## platform-feed-events-005

Original test `A valid event destination hands Instructions over to the normal workflow page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L258).

- **Given** A member opens a valid automation destination and its Instructions tab.
- **When** They select Instructions, then return to Automations.
- **Then** The normal workflow page shows the workflow instructions, selects the Instructions tab, and uses the instructions route without query parameters. Returning to Automations shows the hourly automation still disabled and uses the automations route without query parameters.

## platform-feed-events-006

Original test `A valid event destination hands Settings over to the normal workflow page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L258).

- **Given** A member opens a valid automation destination and its Settings tab.
- **When** They select Settings, then return to Automations.
- **Then** The normal workflow page shows the workflow name in Settings, selects the Settings tab, and uses the info route without query parameters. Returning to Automations shows the hourly automation still disabled and uses the automations route without query parameters.

## platform-feed-events-007

Original test `An automation API 403 produces safe no-access feedback rather than a recovery action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L289).

- **Given** A member visits an automation destination whose API access returns 403 Forbidden.
- **When** The automation destination loads.
- **Then** The page reports that the automation was not found or the member lacks access, offers Back to workflows, and shows no tabs or workflow or automation IDs. It does not offer a recovery action.

## platform-feed-events-008

Original test `An automation API 404 produces safe no-access feedback rather than a recovery action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L289).

- **Given** A member visits an automation destination whose API response is 404 Not Found.
- **When** The automation destination loads.
- **Then** The page reports that the automation was not found or the member lacks access, offers Back to workflows, and shows no tabs or workflow or automation IDs. It does not offer a recovery action.

## platform-feed-events-009

Original test `A cross-workspace event uses the normal explicit workspace switch and preserves the exact destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L312).

- **Given** A member is in the Research workspace and opens an automation destination belonging to their Design workspace membership.
- **When** They explicitly choose Switch workspace.
- **Then** The automation opens with its hourly switch still off, the exact destination path and workspace query are preserved, and the selected automation receives focus.

## platform-feed-events-010

Original test `A removed workspace membership does not grant access from a event's structural IDs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L341).

- **Given** A member visits an automation destination whose workspace ID is not among their memberships.
- **When** The destination attempts to load using that structural workspace ID.
- **Then** The page reports that the automation was not found or the member lacks access, and does not display the removed workspace ID.

## platform-feed-events-011

Original test `A recovered Official Workflow automation opens read-only with its current enabled state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L353).

- **Given** A member opens a recovered Official Workflow automation that is read-only and currently enabled.
- **When** The automation destination loads.
- **Then** The page explains that the system manages the automation, shows its enabled switch as checked and disabled, and opens the automations route.

## platform-feed-events-012

Original test `A failed dismissal stays visible and can be retried without changing its automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L380).

- **Given** A member sees an automation-disabled platform event, and dismissing it initially fails.
- **When** They dismiss it, then retry dismissal after the failure.
- **Then** The failed attempt leaves the event and its heading visible with an alert. The retry succeeds and the page reports that everything is caught up.

## platform-feed-events-013

Original test `An event preserves its actual disable time in the member's timezone and exact automation link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx#L401).

- **Given** A member in the Asia/Shanghai timezone sees an automation-disabled platform event for Daily work summary, disabled at 2026-11-05T03:00:00Z.
- **When** They inspect the event details and its automation link.
- **Then** The event displays the actual disable timestamp, including 11:00 AM in the member's timezone, and the link points to the exact automation destination. The workspace ID is not shown in the event card.
