# Ssh settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [ssh-settings.test.tsx](ssh-settings.test.tsx).

## ssh-settings-001

Original test `Password credentials preserve whitespace, clear mode-switched secrets, and discard late key reads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L66).

- **Given** The user is creating an SSH credential and begins reading a private-key file, then switches between private-key and password authentication modes.
- **When** The user enters a password with surrounding spaces and saves after the earlier key-file read resolves late.
- **Then** The late key read does not populate the key field, switching modes clears the prior secret, and the saved password preserves its surrounding spaces. The dialog closes and the secret is not shown on the page.

## ssh-settings-002

Original test `A known credential rejection leaves the retained input editable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L119).

- **Given** The user is creating a password credential and has entered a password.
- **When** The server rejects the credential with a known invalid-input error.
- **Then** An alert appears, the password remains editable with its entered value, and the server's private error detail is not shown.

## ssh-settings-003

Original test `A concurrent shared-credential edit preserves its draft and blocks stale saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L147).

- **Given** A shared credential is used by two hosts, and the user edits its SSH username.
- **When** Another edit changes the credential before the user's save, producing a revision conflict.
- **Then** The page shows the new credential name and a changed-credential warning. The edit dialog remains open with the user's draft, saving is disabled, and the private server detail is not shown; the request used expected revision 1.

## ssh-settings-004

Original test `An unused credential can be deleted with confirmation and the rendered revision`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L199).

- **Given** An SSH credential has no associated hosts and is listed at revision 1.
- **When** The user confirms its deletion after seeing the warning that its stored secret cannot be recovered.
- **Then** The credential is removed, the page shows zero configured credentials and the empty-state message, and the dialog and delete action disappear. The deletion uses revision 1.

## ssh-settings-005

Original test `Connection warnings explain the failure and recover through notifications`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L233).

- **Given** An SSH connection has a learned host key, and its latest observation reports a host-key mismatch.
- **When** The user views the connection warning, then the observation changes to no failure and a notification arrives.
- **Then** The warning explains the mismatch and advises independently verifying the server; host-key reset is available. After the update, the warning disappears and the connection remains visible.

## ssh-settings-006

Original test `A retained tailscale host explains its actual recovery availability`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L308).

- **Given** A retained SSH host uses Tailscale and needs rebinding; its learned host-key fingerprint is SHA256:retained.
- **When** The user views the host's recovery information and expands its server identity and chat permissions.
- **Then** The alert says a new Tailscale network is needed and directs the user to edit the host to select or create one. The fingerprint is visible, and edit, host-key reset, and delete actions are enabled without opening a dialog.

## ssh-settings-007

Original test `A retained cloudflare_access host explains its actual recovery availability`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L308).

- **Given** A retained SSH host uses Cloudflare Access and needs rebinding; its learned host-key fingerprint is SHA256:retained.
- **When** The user views the host's recovery information and expands its server identity and chat permissions.
- **Then** The alert says a new Cloudflare Access configuration is needed, explains that the host will not connect until rebound or changed to Direct, and directs the user to edit it. The fingerprint is visible, and edit, host-key reset, and delete actions are enabled without opening a dialog.

## ssh-settings-008

Original test `SSH host settings update the chat remote access default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L361).

- **Given** An SSH connection is not enabled by default for chats.
- **When** The user enables its chat remote-access default in the connection settings.
- **Then** The switch becomes checked, and the update targets the SSH protocol and that connection.

## ssh-settings-009

Original test `Shows configured credentials independently of hosts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L421).

- **Given** Two SSH credentials are configured with no associated hosts, and there are no connections.
- **When** The user opens the credential settings.
- **Then** The page shows two configured credentials and an enabled Add credential action.

## ssh-settings-010

Original test `Create a credential from paste, then rename without replacing its secret`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L444).

- **Given** No SSH credentials are configured, and the user creates a private-key credential by pasting a key with leading whitespace and a trailing newline plus a passphrase with surrounding spaces.
- **When** The user saves it, then edits its name without changing login details.
- **Then** The credential is created with the pasted key and passphrase preserved, while secrets are not shown on the page. The rename succeeds without a key field or secret replacement, using expected revision 1.

## ssh-settings-011

Original test `Create a credential from file, then rename without replacing its secret`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L444).

- **Given** No SSH credentials are configured, and the user creates a private-key credential by uploading a file whose contents have leading whitespace and a trailing newline, plus a passphrase with surrounding spaces.
- **When** The user saves it, then edits its name without changing login details.
- **Then** The credential is created with the file contents and passphrase preserved, while secrets are not shown on the page. The rename succeeds without a key field or secret replacement, using expected revision 1.

## ssh-settings-012

Original test `An oversized key file shows a recoverable error without submitting credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L517).

- **Given** The user is creating a private-key credential and has entered a previously pasted key.
- **When** The user uploads a key file larger than 64 KiB, then enters a replacement key by pasting.
- **Then** An alert says the file must be non-empty and no larger than 64 KiB; the key field is cleared and invalid. Pasting a replacement clears the alert and leaves the new key in the field.

## ssh-settings-013

Original test `Credential replacement saves the selected key and clears secrets on close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L543).

- **Given** The user edits a credential and enables changing its login details.
- **When** The user enters a key and cancels, reopens the form, uploads a different key, saves, then reopens login-detail editing.
- **Then** Canceling clears the earlier secret. The saved replacement contains the uploaded key, null passphrase, and expected revision 1; reopening shows an empty key field.

## ssh-settings-014

Original test `Direct reset keeps its trust warning and uses the original generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L641).

- **Given** A Direct SSH host has a learned host key and generation 1.
- **When** The user resets the host key and confirms the warning to independently verify the new server identity, then deletes the connection.
- **Then** The warning remains available with its full accessible description. Reset removes the displayed fingerprint and uses expected generation 1; after deletion, the unavailable-configuration message appears.

## ssh-settings-015

Original test `Cloudflare Access reset keeps its trust warning and uses the original generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L641).

- **Given** A Cloudflare Access SSH host has a learned host key and generation 1.
- **When** The user resets the host key and confirms the warning to independently verify the new server identity, then deletes the connection.
- **Then** The warning remains available with its full accessible description. Reset removes the displayed fingerprint and uses expected generation 1; after deletion, the unavailable-configuration message appears.

## ssh-settings-016

Original test `Tailscale reset keeps its trust warning and uses the original generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L641).

- **Given** A Tailscale SSH host has a learned host key and generation 1.
- **When** The user resets the host key and confirms the warning to independently verify the new server identity, then deletes the connection.
- **Then** The warning remains available with its full accessible description. Reset removes the displayed fingerprint and uses expected generation 1; after deletion, the unavailable-configuration message appears.

## ssh-settings-017

Original test `Tailscale needs rebind reset keeps its trust warning and uses the original generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L641).

- **Given** A Tailscale SSH host needs rebinding, has a learned host key, and is at generation 1.
- **When** The user resets the host key and confirms the warning to independently verify the new server identity, then deletes the connection.
- **Then** The warning remains available with its full accessible description. Reset removes the displayed fingerprint and uses expected generation 1; after deletion, the unavailable-configuration message appears.

## ssh-settings-018

Original test `Changing owner while an SSH token is pending prevents the old mutation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L719).

- **Given** The user is adding an SSH connection and the mutation is waiting for an authentication token.
- **When** The signed-in owner changes before the token resolves.
- **Then** The connection form closes and no connection is created.

## ssh-settings-019

Original test `Changing owner closes the credential form and clears its fields`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-settings.test.tsx#L769).

- **Given** The user opens a new SSH credential form and enters a private key.
- **When** The signed-in owner changes.
- **Then** The form closes and the entered key is no longer present on the page.
