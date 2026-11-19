# Tailscale settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [tailscale-settings.test.tsx](tailscale-settings.test.tsx).

## tailscale-settings-001

Original test `Creating a network saves the entered tags and clears credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L115).

- **Given** An organization member is creating a personal Tailscale network.
- **When** They enter the name “New network,” tags tag:okou and tag:build, and credentials, then save.
- **Then** The network appears with both tags, the request includes the entered credentials, and the password field and page no longer expose the secret.

## tailscale-settings-002

Original test `Credential replacement clears discarded secrets and updates tags against the current revision`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L154).

- **Given** A personal network is at revision 1 and its editor contains credentials that may be replaced.
- **When** The user toggles replacement off after entering a discarded secret, toggles it on again, enters rotated credentials and tag:build, and saves.
- **Then** The discarded secret is cleared when replacement is turned off; the new secret field starts empty. The update uses expected revision 1 and saves tag:build with the rotated credentials.

## tailscale-settings-003

Original test `Realtime impact refresh invalidates an old acknowledgement without discarding deletion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L195).

- **Given** An administrator is deleting a shared network and has acknowledged an impact preview showing two other hosts.
- **When** A live change refreshes the preview to three other hosts with a new impact snapshot.
- **Then** The old acknowledgement is unchecked and deletion is disabled until the new impact is acknowledged; the shared network remains shown in the dialog.

## tailscale-settings-004

Original test `Shared deletion acknowledges fresh impact without exposing other host identities`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L219).

- **Given** An administrator is deleting a shared network with a fresh impact preview for two other hosts.
- **When** They acknowledge that members' hosts remain saved but cannot connect until their owners rebind them, then confirm deletion.
- **Then** Deletion closes the dialog and submits expected revision 1 with the preview's impact snapshot.

## tailscale-settings-005

Original test `A refreshed shared revision is deleted only after acknowledging its current impact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L243).

- **Given** An administrator acknowledged the impact preview for a shared network at revision 1.
- **When** A live change refreshes the network to revision 2 and a new impact snapshot, and the administrator acknowledges the refreshed impact before confirming deletion.
- **Then** The old acknowledgement is cleared, deletion stays disabled until the refreshed impact is acknowledged, and the request uses revision 2 and the refreshed snapshot.

## tailscale-settings-006

Original test `An unconfirmed network creation keeps the credential draft frozen without exposing provider details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L291).

- **Given** A user has entered a new Tailscale network name and credentials.
- **When** Saving the network receives a server error.
- **Then** The credential draft remains present but disabled, saving is disabled, and provider error details are not shown.

## tailscale-settings-007

Original test `Changing organizations unmounts the draft and clears secrets`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L309).

- **Given** A user has an unsaved Tailscale network draft containing a secret in one organization.
- **When** They switch to another organization.
- **Then** The draft is unmounted and its secret is cleared; no secret field remains visible.

## tailscale-settings-008

Original test `Leaving the network editor clears a secret draft before starting again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L328).

- **Given** A user has entered a secret in a new Tailscale network draft.
- **When** They leave the editor and start a new network draft.
- **Then** The previous secret is cleared and the new draft has its independently entered secret.

## tailscale-settings-009

Original test `Changing organizations during save clears secrets and fences a late response`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L341).

- **Given** A user is saving a new network when they switch organizations before the server responds.
- **When** They return to the original organization, start a second draft, and the delayed creation response arrives.
- **Then** The first draft is unmounted and its secret cleared on the organization switch. The late response does not overwrite the second draft's name or secret.

## tailscale-settings-010

Original test `An impact conflict rejects an outdated network restriction without exposing provider details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/tailscale-settings.test.tsx#L389).

- **Given** An administrator edits a shared network and chooses to make it available only to themselves; the impact preview identifies another owner.
- **When** They acknowledge the preview, but the conversion request conflicts because the impact is outdated.
- **Then** The draft is kept with a message to reopen and review current settings, the conversion action is disabled, and provider error details are not exposed. The request uses expected revision 1 and the preview snapshot.
