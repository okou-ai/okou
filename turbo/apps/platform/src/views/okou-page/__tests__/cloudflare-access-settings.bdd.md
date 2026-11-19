# Cloudflare access settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [cloudflare-access-settings.test.tsx](cloudflare-access-settings.test.tsx).

## cloudflare-access-settings-001

Original test `An admin can edit and delete a shared configuration through scoped mutations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L105).

- **Given** An admin is viewing a shared Cloudflare Access configuration.
- **When** They rename it, save, then delete it after reviewing its impact.
- **Then** The update uses revision 1 and the delete uses revision 2 with the reviewed impact snapshot; the private-network directory shows no networks.

## cloudflare-access-settings-002

Original test `Switching organizations navigates away from an open shared Access editor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L183).

- **Given** An admin is editing a shared Access configuration in one organization.
- **When** They switch to another organization.
- **Then** The editor closes and navigation returns to the home page.

## cloudflare-access-settings-003

Original test `Returning to Private networks starts a fresh Access draft after leaving the editor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L204).

- **Given** A user enters a name and credentials in a new Access draft.
- **When** They leave the editor and open a new draft from Private networks.
- **Then** The new draft has an empty name and secret, and the abandoned secret has been cleared.

## cloudflare-access-settings-004

Original test `The private network directory refreshes from the neutral realtime event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L217).

- **Given** The private-network directory shows an Access configuration.
- **When** A neutral Cloudflare Access changed event arrives for the active organization after the configuration is renamed.
- **Then** The directory refreshes and shows the new name.

## cloudflare-access-settings-005

Original test `Pasted Service Token headers create a network and clear credentials before personal deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L229).

- **Given** A user is creating a personal Access network.
- **When** They paste Service Token headers, save the network, then delete it.
- **Then** The pasted client ID and secret populate their respective fields, the secret is masked, and creation sends those credentials. The secret field clears after save, and deletion returns the directory to its empty state.

## cloudflare-access-settings-006

Original test `An unconfirmed Access creation preserves its frozen credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L283).

- **Given** A user has entered an Access network name and credentials.
- **When** They save, but the service responds with an internal error.
- **Then** A save-failed message appears; the secret remains present but disabled, and the save action is disabled.

## cloudflare-access-settings-007

Original test `Changing the owner clears Access secrets`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L303).

- **Given** A user has entered credentials in a new Access draft.
- **When** The signed-in owner changes.
- **Then** The form closes, navigation goes to the connectors page, and the secret is cleared and no longer shown.

## cloudflare-access-settings-008

Original test `Access load failure does not expose provider details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L324).

- **Given** The Access configuration list request fails with an internal error containing provider details.
- **When** The user opens Private networks.
- **Then** A generic Cloudflare Access load-failure message appears, and the provider details are not exposed.

## cloudflare-access-settings-009

Original test `Deletion preview permission loss blocks shared deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L335).

- **Given** An admin views a shared Access configuration, but the impact-preview request is denied for lack of permission.
- **When** They open the deletion dialog.
- **Then** The dialog says the resource is no longer available and does not offer a deletion action.

## cloudflare-access-settings-010

Original test `Reviewed shared deletion rejects a changed host set and protects member identities`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L353).

- **Given** An admin reviews deletion of a shared configuration affecting three hosts and two members, one without a display name.
- **When** They acknowledge the impact and confirm deletion, but the service reports that the affected hosts changed.
- **Then** The dialog identifies the named member and shows “Name unavailable” with only the former member ID suffix; the full ID and provider error details are hidden. The delete request carries revision 1 and the reviewed snapshot, and the dialog reports the changed-host conflict.

## cloudflare-access-settings-011

Original test `A restriction rejected with CLOUDFLARE_ACCESS_IN_USE preserves its draft and protects provider details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L425).

- **Given** An admin edits a shared Access configuration affecting one other host and selects “Only me.”
- **When** They confirm the scope change, but the service rejects it with CLOUDFLARE_ACCESS_IN_USE (409).
- **Then** The dialog shows the specific still-in-use message, the network name remains unchanged, the confirmation action is disabled, and provider details are hidden. The request includes revision 1 and the reviewed impact snapshot.

## cloudflare-access-settings-012

Original test `A restriction rejected with CLOUDFLARE_ACCESS_IMPACT_CONFLICT preserves its draft and protects provider details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L425).

- **Given** An admin edits a shared Access configuration affecting one other host and selects “Only me.”
- **When** They confirm the scope change, but the service rejects it with CLOUDFLARE_ACCESS_IMPACT_CONFLICT (409).
- **Then** The dialog says linked settings changed and the draft is kept for review; the network name remains unchanged, the confirmation action is disabled, and provider details are hidden. The request includes revision 1 and the reviewed impact snapshot.

## cloudflare-access-settings-013

Original test `A restriction rejected with INTERNAL_ERROR preserves its draft and protects provider details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L425).

- **Given** An admin edits a shared Access configuration affecting one other host and selects “Only me.”
- **When** They confirm the scope change, but the service responds with INTERNAL_ERROR (500).
- **Then** The dialog says the change could not be confirmed and saved settings are unverified; the network name remains unchanged, the confirmation action is disabled, and provider details are hidden. The request includes revision 1 and the reviewed impact snapshot.

## cloudflare-access-settings-014

Original test `Restriction preview permission loss blocks the scope change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-settings.test.tsx#L473).

- **Given** An admin edits a shared Access configuration, but the impact-preview request is denied for lack of permission.
- **When** They select “Only me” and try to save the scope change.
- **Then** The dialog says the network is unavailable or administrator permission is missing, and the “Make personal” action is disabled.
