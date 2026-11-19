# Integrations teams

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integrations-teams.test.tsx](integrations-teams.test.tsx).

## integrations-teams-001

Original test `Works reconciles Teams through focus without leaving its prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L30).

- **Given** The user is on /works?prompt=Retain+my+work, and Microsoft Teams is not installed or connected.
- **When** The user starts installation, closes the popup, and Teams becomes installed and connected; the page receives a focus event.
- **Then** The installation URL preserves the prompt “Retain my work,” and the install action remains available after the popup closes. The card updates to Connected (Verified team), and the user stays on /works with the prompt preserved.

## integrations-teams-002

Original test `Works reconciles Teams through visibility without leaving its prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L30).

- **Given** The user is on /works?prompt=Retain+my+work, and Microsoft Teams is not installed or connected.
- **When** The user starts installation, closes the popup, and Teams becomes installed and connected; the page becomes hidden and visible again.
- **Then** The installation URL preserves the prompt “Retain my work,” and the install action remains available after the popup closes. The card updates to Connected (Verified team), and the user stays on /works with the prompt preserved.

## integrations-teams-003

Original test `Works reconciles Teams through realtime without leaving its prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L30).

- **Given** The user is on /works?prompt=Retain+my+work, and Microsoft Teams is not installed or connected.
- **When** The user starts installation, closes the popup, and Teams becomes installed and connected; a Teams change notification arrives.
- **Then** The installation URL preserves the prompt “Retain my work,” and the install action remains available after the popup closes. The card updates to Connected (Verified team), and the user stays on /works with the prompt preserved.

## integrations-teams-004

Original test `Works opens the prepared bot installation separately from account connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L85).

- **Given** Microsoft Teams has a pending bot installation and is not connected.
- **When** The user starts installation from Works.
- **Then** The opened URL specifies the install flow. The card does not show Connected, and the user remains on /works.

## integrations-teams-005

Original test `Returning to Works retries a failed Teams read without hiding the other integrations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L100).

- **Given** The Teams status request fails while the user opens Works.
- **When** The user returns focus to Works after the Teams request becomes available again.
- **Then** The initial page load reports a fetch failure, and the Teams card says it cannot check the connection. Slack remains visible. On focus, the Teams card recovers and offers the enabled Install in Teams action.

## integrations-teams-006

Original test `Teams actions preserve prompt and protected preview access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L127).

- **Given** The user is on a protected preview Works URL with prompt=Retain+my+work and a preview-bypass value; the Teams installation URL uses a separate API host.
- **When** The user selects Install in Teams.
- **Then** The new tab opens on the API host, retaining the prompt and preview-bypass query values. The user remains on /works.

## integrations-teams-007

Original test `An overlapping focus refresh keeps later realtime notifications active`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L159).

- **Given** Microsoft Teams is not installed or connected, and a Teams change notification has started a status refresh that is still pending.
- **When** A focus refresh overlaps it, the first refresh completes, and a later Teams change notification reports installation and connection.
- **Then** The card offers Install in Teams after the focus refresh and later updates to Connected (Later installation) after the subsequent notification.

## integrations-teams-008

Original test `Members can connect a Teams identity without an organization bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L210).

- **Given** A non-admin member can connect a Teams identity, but has no organization bot installation URL.
- **When** The member selects Connect.
- **Then** The new tab opens the connection URL with connectState=verified-identity.

## integrations-teams-009

Original test `An independent Teams identity remains connected after bot removal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-teams.test.tsx#L230).

- **Given** Microsoft Teams has no installed organization bot, but an independent identity is connected to Personal identity tenant.
- **When** The user views the card and starts installation.
- **Then** The card remains Connected (Personal identity tenant). The installation action opens a URL with connectState=admin-install.
