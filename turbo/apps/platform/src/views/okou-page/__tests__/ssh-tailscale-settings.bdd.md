# Ssh tailscale settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [ssh-tailscale-settings.test.tsx](ssh-tailscale-settings.test.tsx).

## ssh-tailscale-settings-001

Original test `The connection selector supports keyboard selection and Escape returns focus`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L136).

- **Given** A saved Tailscale SSH connection is being edited.
- **When** The user opens the connection selector, presses Escape, then reopens it with Enter and selects the last option with End and Enter.
- **Then** Escape returns focus to the selector. The last option displays a System username field.

## ssh-tailscale-settings-002

Original test `A tailscale_ssh authentication warning explains its own login type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L151).

- **Given** A Tailscale SSH host has an authentication-failure observation.
- **When** The user views the host details.
- **Then** A warning explains that Tailscale SSH authentication failed and advises checking the system username, enabling Tailscale SSH on the tagged destination, and allowing the login in the tailnet SSH accept policy.

## ssh-tailscale-settings-003

Original test `A tailscale authentication warning explains its own login type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L151).

- **Given** A Tailscale host using a saved SSH credential has an authentication-failure observation.
- **When** The user views the host details.
- **Then** A warning explains that SSH authentication failed and advises checking the credential username, key or password, and server authorization; it also explains that the credential can be edited or replaced.

## ssh-tailscale-settings-004

Original test `Tailscale host creation uses saved login details with a saved network`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L210).

- **Given** A saved Tailscale network is available, and the user is creating an SSH host with saved login details.
- **When** The user selects the saved credential and adds the host at 100.64.0.2 on port 2022.
- **Then** The host is created using that network and credential, with the address as its display name and host. The password is not shown in the page.

## ssh-tailscale-settings-005

Original test `Tailscale host creation uses new login details with a saved network`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L210).

- **Given** A saved Tailscale network is available, and the user is creating an SSH host with new login details.
- **When** The user enters username operator and a password, then adds the host at 100.64.0.2 on port 2022.
- **Then** The host is created using that network and a new password credential named 100.64.0.2. The password is not shown in the page.

## ssh-tailscale-settings-006

Original test `A saved Tailscale host retains its port, credential and learned key during editing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L266).

- **Given** A saved Tailscale SSH host has port 2022, username deploy, a saved credential, and a learned SSH key.
- **When** The user edits its name and saves the changes.
- **Then** The update retains the host address, port, saved credential, and Tailscale network. The learned key fingerprint SHA256:preserved remains visible in the server identity and chat permissions section.

## ssh-tailscale-settings-007

Original test `A retained Tailscale host requires an explicit network selection to rebind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L306).

- **Given** A retained Tailscale SSH host is marked as needing rebind and still has its saved address and port.
- **When** The user tries to save before choosing a network, then selects the saved network.
- **Then** Saving is initially disabled and becomes enabled after network selection; the host address remains unchanged.

## ssh-tailscale-settings-008

Original test `Changing carriers preserves endpoint drafts and the independently selected network`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L323).

- **Given** A saved Tailscale SSH connection is being edited with an existing name, address, port, and network.
- **When** The user switches the connection carrier to Direct and then back to Tailscale.
- **Then** The connection name and address draft are preserved across the switches, and the Tailscale address, port 2022, and independently selected saved network remain populated.

## ssh-tailscale-settings-009

Original test `An unconfirmed SSH creation keeps its draft frozen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L342).

- **Given** The user has entered new SSH login details for a Tailscale host.
- **When** The first creation attempt fails with a server error after the host has been created remotely.
- **Then** An alert appears, the Add connection button is disabled, and the draft cannot be submitted again.

## ssh-tailscale-settings-010

Original test `A retained tailscale VNC dependency opens its exact SSH host for rebind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L372).

- **Given** A VNC desktop depends on a retained Tailscale SSH host that needs rebind, and another unrelated SSH host is also listed.
- **When** The user chooses to rebind the SSH host from the desktop entry.
- **Then** The form opens for the exact dependent host, showing its existing name, deploy username, Tailscale address, and port 2022. Saving is disabled until rebind requirements are met.

## ssh-tailscale-settings-011

Original test `A retained cloudflare_access VNC dependency opens its exact SSH host for rebind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-tailscale-settings.test.tsx#L372).

- **Given** A VNC desktop depends on a retained Cloudflare Access SSH host that needs rebind, and another unrelated SSH host is also listed.
- **When** The user chooses to rebind the SSH host from the desktop entry.
- **Then** The form opens for the exact dependent host, showing its existing name, deploy username, published hostname, and port 443. Saving is disabled until rebind requirements are met.
