# Cloudflare access parity

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [cloudflare-access-parity.test.tsx](cloudflare-access-parity.test.tsx).

## cloudflare-access-parity-001

Original test `An unchanged save returns to details without updating the configuration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-parity.test.tsx#L87).

- **Given** A user is viewing Cloudflare Access settings for a network named Protected applications. Updating the configuration would fail.
- **When** The user edits the name but enters the same name with surrounding spaces, then saves.
- **Then** The details view returns with the Edit settings action available, without requiring a successful configuration update.

## cloudflare-access-parity-002

Original test `Shared deletion refreshes changed impact on cloudflare-access:changed and requires fresh confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-parity.test.tsx#L103).

- **Given** An admin is confirming deletion of a shared Cloudflare Access configuration affecting one member and two hosts, and has checked the confirmation box.
- **When** A cloudflare-access:changed event refreshes the impact to one member and three hosts.
- **Then** The dialog displays the updated impact, clears the confirmation checkbox, and disables deletion until confirmation is given again.

## cloudflare-access-parity-003

Original test `Shared deletion refreshes changed impact on ssh:changed and requires fresh confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-parity.test.tsx#L103).

- **Given** An admin is confirming deletion of a shared Cloudflare Access configuration affecting one member and two hosts, and has checked the confirmation box.
- **When** An ssh:changed event refreshes the impact to one member and three hosts.
- **Then** The dialog displays the updated impact, clears the confirmation checkbox, and disables deletion until confirmation is given again.

## cloudflare-access-parity-004

Original test `Shared deletion keeps confirmation when a refreshed impact snapshot is unchanged`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-parity.test.tsx#L127).

- **Given** An admin is confirming deletion of a shared Cloudflare Access configuration and has checked the confirmation box.
- **When** A cloudflare-access:changed event refreshes the affected owner’s display name but leaves the impact snapshot unchanged.
- **Then** The dialog shows the updated owner name, keeps the confirmation checked, and leaves deletion enabled.

## cloudflare-access-parity-005

Original test `A network-only removal refreshes SSH rebind requirements and preserves default access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-parity.test.tsx#L145).

- **Given** A user is viewing an SSH host protected by a shared Cloudflare Access configuration, and the host is enabled by default for chats.
- **When** The Cloudflare Access configuration is removed and a cloudflare-access:changed event refreshes the host details.
- **Then** The page warns that the host needs a new Cloudflare Access configuration and will not connect until it is rebound or changed to Direct. The default-for-chats switch remains enabled.
