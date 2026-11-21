# Team permissions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [team-permissions.test.tsx](team-permissions.test.tsx).

## team-permissions-001

Original test `A user can apply a temporary connector policy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L297).

- **Given** A user is editing Axiom permissions, where annotations|create is denied.
- **When** They allow it for 24 hours and apply the policy.
- **Then** The policy update succeeds and submits an allow grant for annotations|create with a 24-hour expiry.

## team-permissions-002

Original test `A user can restore the saved connector-policy baseline`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L308).

- **Given** A user has saved Axiom policies that deny annotations|create and allow other endpoints.
- **When** They change both policies, restore the saved baseline, and apply.
- **Then** The policies return to allow annotations|create and deny other endpoints. The update replaces the connector's grants with an empty list.

## team-permissions-003

Original test `Closing connector permissions discards unapplied changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L333).

- **Given** A user has saved Axiom permissions with annotations|create denied.
- **When** They change it to allow for 24 hours, cancel, and reopen permissions.
- **Then** No update is submitted; the saved deny policy remains, the temporary duration is absent, and Apply is disabled.

## team-permissions-004

Original test `An expired allow grant falls back to the connector's current default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L370).

- **Given** A Slack allow grant for channels:join expired before the current time, and the connector default is deny.
- **When** The user opens the Misc permission group.
- **Then** channels:join is shown as denied, not allowed, and Restore is disabled.

## team-permissions-005

Original test `Grouped and individual connector policies submit together`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L469).

- **Given** A user edits Slack permissions, with channels:read already allowed and the connector default set to deny.
- **When** They allow the Read group for seven days, change bookmarks:read to one hour and then back to seven days, allow channels:join first for seven days then permanently, allow other endpoints for one hour, and apply.
- **Then** The grouped and individual changes submit together. The request includes bookmarks:read, channels:read, channels:join, and the unknown-permissions grant; the unknown grant is allowed for one hour.

## team-permissions-006

Original test `A user can change one connector permission from temporary to permanent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L502).

- **Given** Axiom has annotations|create allowed for one hour and datasets|read allowed until two days later; saved grants also include retired|write denied and an expired allow for expired|read.
- **When** The user changes annotations|create to allow always and applies.
- **Then** The update succeeds with a patch containing only annotations|create allowed permanently; the other saved grants are not included in the submitted change.

## team-permissions-007

Original test `A user can find and save a permission beyond the initially visible list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L568).

- **Given** Cloudflare has 111 permissions, and memberships.read is beyond the initially visible list; permissions default to allow.
- **When** The user searches for memberships.read, denies it, and applies.
- **Then** The permission becomes visible and the update succeeds with a patch denying memberships.read for the Research Agent.

## team-permissions-008

Original test `Other endpoints starts from and can return to the connector default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-permissions.test.tsx#L613).

- **Given** Cloudflare's known permissions default to allow, while unknown endpoints default to deny.
- **When** The user opens permissions, allows other endpoints, then restores the default.
- **Then** Other endpoints initially shows denied with Allow unselected and Restore disabled; after changing it to allow, Restore is enabled, and restoring returns it to denied and disables Restore.
