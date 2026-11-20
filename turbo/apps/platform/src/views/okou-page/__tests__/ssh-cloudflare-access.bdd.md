# Ssh cloudflare access

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [ssh-cloudflare-access.test.tsx](ssh-cloudflare-access.test.tsx).

## ssh-cloudflare-access-001

Original test `A retained protected host requires explicit shared Access selection before saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-cloudflare-access.test.tsx#L114).

- **Given** A retained protected SSH host needs rebinding, and a permitted shared Cloudflare Access configuration is available.
- **When** The user edits the host, selects the shared configuration, and saves.
- **Then** Saving is disabled until the user explicitly selects a permitted configuration or Direct. The update uses the retained host, credential, generation 3, and selected shared configuration.

## ssh-cloudflare-access-002

Original test `Direct recovery is an explicit choice and does not replace the saved credential`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-cloudflare-access.test.tsx#L160).

- **Given** A retained protected SSH host needs rebinding, and no Cloudflare Access configurations are available.
- **When** The user explicitly chooses Direct and saves the host.
- **Then** Saving is disabled until Direct is chosen. The update uses the retained host and saved credential, expects generation 3, and selects Direct rather than replacing the credential.

## ssh-cloudflare-access-003

Original test `Direct and protected mode retain their port and configuration drafts but submit only active fields`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-cloudflare-access.test.tsx#L197).

- **Given** A Direct SSH host uses port 22 and a Cloudflare Access configuration is available.
- **When** The user drafts port 2222, switches to Cloudflare Access, enters the published hostname and selects a configuration, then switches between Direct and Cloudflare Access before saving.
- **Then** The port draft remains 2222 when switching back to Direct, and the selected Access configuration remains when switching back to protected mode. The saved protected connection submits port 443 and the selected configuration, not the inactive port draft.

## ssh-cloudflare-access-004

Original test `Access API unavailability blocks protected mutations without silently changing transport`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-cloudflare-access.test.tsx#L240).

- **Given** A protected SSH host and a Direct SSH host are listed, but the Cloudflare Access API is unavailable.
- **When** The user tries to edit, reset the host key, or delete the protected host, then navigates to and saves the Direct host.
- **Then** Protected-host edit, reset, and delete are disabled rather than silently changing its transport. The Direct host remains editable and saves with its existing host, port 443, credential, and Direct transport.

## ssh-cloudflare-access-005

Original test `An eligible protected host can explicitly change to Direct`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-cloudflare-access.test.tsx#L303).

- **Given** An eligible protected SSH host has an available Cloudflare Access configuration and uses port 22.
- **When** The user explicitly changes the connection type to Direct, saves, and reopens the editor.
- **Then** The port remains 22, and the saved connection is shown as Direct.

## ssh-cloudflare-access-006

Original test `A concurrent host update preserves the binding draft and blocks stale saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-cloudflare-access.test.tsx#L333).

- **Given** A protected SSH host has two available Access configurations, and the user edits its name and selects the alternate configuration.
- **When** A concurrent host update causes the save to fail with a generation conflict.
- **Then** The edited name and selected binding remain in the draft, saving is disabled because the host changed, and the attempted update uses generation 1 and the alternate configuration.

## ssh-cloudflare-access-007

Original test `Pending protected host save is cancelled and its private key cleared on owner loss`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-cloudflare-access.test.tsx#L381).

- **Given** A user is creating a protected SSH connection with a private-key draft, and the save request is pending.
- **When** The authenticated owner changes before the request completes.
- **Then** The pending request is cancelled and the private-key field is cleared; the draft key is no longer present in the page.
