# Vnc native settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [vnc-native-settings.test.tsx](vnc-native-settings.test.tsx).

## vnc-native-settings-001

Original test `A rejected native configuration preserves the draft and both trust layers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-native-settings.test.tsx#L175).

- **Given** A saved VNC connection uses Cloudflare Access and has custom CA trust for its inner VNC certificate. The network update service rejects changes with a 404.
- **When** The user changes the connection name, device address, and origin TLS server name, then saves.
- **Then** The update is attempted once with the edited values, the existing inner certificate trust, and system trust for origin TLS. The rejected save shows an alert, preserves the draft and both trust layers, and leaves Save disabled.

## vnc-native-settings-002

Original test `Mac Cloudflare setup requires origin TLS and keeps its protective controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-native-settings.test.tsx#L271).

- **Given** The user is adding an Apple screen-sharing connection with classic Mac VNC password login through a saved Cloudflare Access network.
- **When** The user reaches connection settings, tries to disable Origin TLS, and returns to the VNC login method step.
- **Then** Origin TLS remains checked and disabled, its server name is required, and no VNC certificate-name field is shown. The protocol and security details include the protection against other clients reaching the device.

## vnc-native-settings-003

Original test `Mac Cloudflare setup requires independently named origin TLS and keeps the RFB authentication profile`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-native-settings.test.tsx#L298).

- **Given** No VNC connections are saved, and a scoped Cloudflare Access network and saved login are available.
- **When** The user starts Apple screen-sharing setup with classic Mac VNC password login, enters a gateway address and a different origin TLS server name, switches to certificate-based VNC and back, then saves the Mac connection.
- **Then** The gateway address and origin TLS server name persist across the service-type changes, and origin TLS remains enabled. The created connection uses port 443, Apple VNC password authentication, the selected saved login, and the independently named origin TLS server with system trust.

## vnc-native-settings-004

Original test `Native cloudflare_access creation selects a scoped network without an SSH dependency`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-native-settings.test.tsx#L396).

- **Given** No VNC connections are saved, a scoped Cloudflare Access network is available, and there are no SSH hosts.
- **When** The user creates a native VNC connection through Cloudflare Access using the saved network, gateway.example.com, and a saved login.
- **Then** The form requires a saved network before continuing, shows no SSH host field, and defaults the port to 443. The review identifies the provider and network by name without exposing the network ID; the created connection uses the selected network, gateway.example.com, port 443, and system-trusted VNC certificate settings.

## vnc-native-settings-005

Original test `Native tailscale creation selects a scoped network without an SSH dependency`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-native-settings.test.tsx#L396).

- **Given** No VNC connections are saved, a scoped Tailscale network is available, and there are no SSH hosts.
- **When** The user creates a native VNC connection through Tailscale using the saved network, 100.100.10.2, and a saved login.
- **Then** The form requires a saved network before continuing, shows no SSH host field, and defaults the port to 5900. The review identifies the provider and network by name without exposing the network ID; the created connection uses the selected network, 100.100.10.2, port 5900, and system-trusted VNC certificate settings.

## vnc-native-settings-006

Original test `Detached native editing preserves both trust layers and requires explicit rebind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-native-settings.test.tsx#L482).

- **Given** A detached Cloudflare Access VNC connection has custom CA certificates for both origin TLS and the inner VNC certificate, and requires rebinding to a network.
- **When** The user opens the connection for editing, selects a saved Cloudflare Access network, and saves.
- **Then** The edit form preserves both certificate names and both custom CA bundles, and Save is disabled until a network is selected. The update retains both trust layers and the saved credential, binds the selected network, and completes without the edit form or a reconfiguration warning.

## vnc-native-settings-007

Original test `Independent native KDC rebinding keeps the Direct desktop route and Kerberos credential`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-native-settings.test.tsx#L564).

- **Given** A Direct VNC connection has Kerberos authentication and a separate Tailscale KDC route that requires rebinding. Its saved Kerberos credential has realm EXAMPLE.COM and initiator component operator.
- **When** The user selects a saved Tailscale network for the KDC route and saves the connection.
- **Then** The desktop route remains Direct, the separate KDC route remains Tailscale, and Save is disabled until a network is selected. The update keeps the Kerberos credential, Direct desktop transport, KDC host kdc.tailnet on port 88, service realm EXAMPLE.COM and components vnc and desktop.example.com, system trust, and ticket lifetimes of 1200 and 7200 seconds, while binding the selected network to the KDC route.
