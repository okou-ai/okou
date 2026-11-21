# Vnc settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [vnc-settings.test.tsx](vnc-settings.test.tsx).

## vnc-settings-001

Original test `Native cloudflare_access RFB and detached KDC routes preserve identity and open an explicit rebind editor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L281).

- **Given** A saved VNC connection uses Cloudflare Access for RFB and has a detached KDC route marked for rebind.
- **When** The owner opens its details and edits the connection.
- **Then** The card preserves the Cloudflare Access route and origin TLS identity, and shows the Tailscale KDC route and RFB server identity. The edit form explicitly shows both routes, and Save is disabled until the KDC route is rebound.

## vnc-settings-002

Original test `Native direct RFB and detached KDC routes preserve identity and open an explicit rebind editor`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L281).

- **Given** A saved VNC connection uses a direct RFB route and has a detached KDC route marked for rebind.
- **When** The owner opens its details and edits the connection.
- **Then** The card preserves the direct RFB route and shows the Tailscale KDC route and RFB server identity. The edit form explicitly shows both routes, and Save is disabled until the KDC route is rebound.

## vnc-settings-003

Original test `A conflicting VNC edit preserves the draft and blocks saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L353).

- **Given** An owner edits a VNC connection and changes its name while another update changes the saved connection generation.
- **When** The owner saves the draft and the server reports a generation conflict.
- **Then** The draft name remains visible, an error is shown, Save is disabled, and only one update request was made.

## vnc-settings-004

Original test `VNC settings show a current-generation failure and its observation time`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L385).

- **Given** A VNC host has a current-generation observation reporting authentication failure.
- **When** The owner opens the host details and then refreshes observations for the active organization.
- **Then** The authentication or server identity failure and its observation time are shown initially. A refresh event for another organization does not clear the warning; the active organization's refresh clears it while retaining the host card.

## vnc-settings-005

Original test `VNC settings do not render a previous generation's failure as current`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L444).

- **Given** A VNC host has an authentication-failure observation for an older generation, while another host has a current network-failure observation.
- **When** The owner opens the first host after visiting the second host.
- **Then** The current network failure is shown on the second host, but the older-generation authentication failure is not shown as current on the first host.

## vnc-settings-006

Original test `VNC settings do not render a previous creation instance's failure as current`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L444).

- **Given** A VNC host has an authentication-failure observation from an earlier creation instance, despite its generation matching the current host; another host has a current network failure.
- **When** The owner opens the first host after visiting the second host.
- **Then** The current network failure is shown on the second host, but the prior creation instance's authentication failure is not shown as current on the first host.

## vnc-settings-007

Original test `VNC settings refresh observations when their SSH carrier changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L486).

- **Given** An SSH-backed VNC host currently displays an authentication-failure observation.
- **When** The saved SSH carrier changes generation and an SSH change event triggers an observation refresh that has not yet completed.
- **Then** The stale authentication-failure warning disappears before the refreshed observations return, while the VNC host remains displayed.

## vnc-settings-008

Original test `A local SSH carrier reset invalidates retained VNC diagnostics before realtime delivery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L537).

- **Given** An SSH-backed VNC host displays an authentication-failure warning, and its saved SSH carrier has a learned host key.
- **When** The owner resets the SSH host key, then reopens the VNC host while refreshed observations are still pending.
- **Then** The retained VNC diagnostic warning is cleared before the refreshed observations return.

## vnc-settings-009

Original test `VNC settings distinguish successful and unobserved hosts from failed hosts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L612).

- **Given** One VNC host has a successful observation, one has no observation, and one has a network-failure observation.
- **When** The owner visits each host's details.
- **Then** The failed host shows a transport-failure warning. The successful and unobserved hosts show no status warning, and all host cards remain visible.

## vnc-settings-010

Original test `VNC settings retain the current owner's warning while observations refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L667).

- **Given** The current owner sees an authentication-failure warning on a VNC host.
- **When** The active organization's observation refresh begins and is delayed before returning success.
- **Then** The warning remains visible while refresh is pending, then disappears when the successful observation arrives; the host remains displayed.

## vnc-settings-011

Original test `VNC settings never retain the previous owner's diagnostic warning`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L715).

- **Given** The current owner sees an authentication-failure warning on a VNC host.
- **When** The signed-in owner changes and the new owner's host list loads while observations are pending.
- **Then** The previous owner's warning is removed before the new owner's host is displayed.

## vnc-settings-012

Original test `Returning to Connectors refreshes VNC hosts changed elsewhere`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L808).

- **Given** The owner is viewing remote-control connectors, and a VNC host is changed elsewhere while they are away from the Connectors page.
- **When** The owner leaves for Connectors and returns to the remote-control scope.
- **Then** The updated host name is shown and the old name is absent.

## vnc-settings-013

Original test `X509None is an explicit credentialless choice with persistent client-authentication warning`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L829).

- **Given** A saved VNC connection uses X509None with no credential.
- **When** The owner opens its identity details and chooses X509None while adding another connection.
- **Then** The saved connection warns that it does not authenticate the owner to the VNC server. The setup warns that anyone who can reach the server may connect, and saving creates a direct, credentialless X509None connection.

## vnc-settings-014

Original test `Owner explicitly selects Client certificate without VNC password (X509None) without leaking the key to metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L906).

- **Given** The owner is adding a VNC connection and explicitly chooses a client certificate without a VNC password.
- **When** The owner enters a certificate chain and unencrypted PKCS#8 key, reviews, and saves.
- **Then** The setup warns that the client certificate does not prove the VNC server checks it. The saved authentication includes the selected client-certificate method and certificate chain, with no password; the private key is not included in connection metadata.

## vnc-settings-015

Original test `Owner explicitly selects Client certificate with VNC password (X509Vnc) without leaking the key to metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L906).

- **Given** The owner is adding a VNC connection and explicitly chooses a client certificate with a VNC password.
- **When** The owner enters a certificate chain, unencrypted PKCS#8 key, and password, then saves.
- **Then** The setup warns that the client certificate does not prove the VNC server checks it. The saved authentication includes the selected certificate method and password, while the private key is not included in connection metadata.

## vnc-settings-016

Original test `An owner creates an SSH-backed route with a distinct RFB destination and certificate identity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L962).

- **Given** The owner is adding an encrypted VNC connection and has a saved SSH gateway available.
- **When** The owner switches between the SSH route and direct route, chooses the gateway, reuses saved login details, enters a distinct RFB certificate identity, and saves.
- **Then** The device destination remains second.example.com, port 5900, with the SSH gateway as transport, the reused credential, and desktop.internal.example.com as the certificate identity.

## vnc-settings-017

Original test `A VNC host explains its retained cloudflare_access SSH carrier and recovers after SSH refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1026).

- **Given** A VNC host uses a retained SSH carrier on Cloudflare Access at gateway.example.com:443, and the carrier requires rebind.
- **When** The owner views the VNC host, then the SSH carrier is refreshed to a valid Cloudflare Access configuration.
- **Then** The host initially explains that the saved SSH host must be rebound or changed to Direct, while preserving the SSH topology, 127.0.0.1:5901 destination, saved login, and certificate identity. After refresh the warning clears and those details remain.

## vnc-settings-018

Original test `A VNC host explains its retained tailscale SSH carrier and recovers after SSH refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1026).

- **Given** A VNC host uses a retained SSH carrier on Tailscale at 100.100.10.2:22, and the carrier requires rebind.
- **When** The owner views the VNC host, then the SSH carrier is refreshed to a valid Tailscale configuration.
- **Then** The host initially explains that the saved SSH host must be rebound to a Tailscale network, while preserving the SSH topology, 127.0.0.1:5901 destination, saved login, and certificate identity. After refresh the warning clears and those details remain.

## vnc-settings-019

Original test `An SSH-backed card shows topology and a missing saved SSH host blocks edits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1093).

- **Given** A VNC host routes through a saved SSH host that is no longer available, and its destination is a private loopback address.
- **When** The owner edits the connection, switches to a direct route, changes the address to a public hostname, and saves.
- **Then** The card shows the SSH topology, private destination, certificate identity, and missing-host warning. The missing SSH host and private address prevent saving; after changing to the public hostname, saving succeeds as a direct route with the existing credential and security settings.

## vnc-settings-020

Original test `Editing an Apple IPv6 loopback host preserves its SSH route and custom port`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1157).

- **Given** An Apple screen-sharing host uses IPv6 loopback ::1 on port 5905 through a saved SSH host.
- **When** The owner opens and saves the edit form without changing its connection details.
- **Then** The form preserves the host name, ::1 address, port 5905, and SSH route, and the update request retains the Apple screen-sharing security and saved credential.

## vnc-settings-021

Original test `Direct route explains canonical IPv6 loopback and private mapped literals`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1213).

- **Given** The owner is adding a VNC host using a direct route.
- **When** The owner enters 127.0.0.1., expanded IPv6 loopback, ::1., IPv4-mapped loopback, IPv4-mapped private address, fc00::1, or febf::1 as the destination, then tries ::ffff:8.8.8.8.
- **Then** Each loopback or private literal shows a warning that a supported private-network route or saved SSH host is required and disables Continue. The public IPv4-mapped address clears the warning and enables Continue.

## vnc-settings-022

Original test `Inline password creation preserves spaces and sends the selected custom certificate trust`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1241).

- **Given** The owner is adding a password-protected encrypted VNC connection.
- **When** The owner enters the password with leading and trailing spaces, selects custom certificate authorities, supplies a CA bundle, and saves.
- **Then** The exact spaced password and custom CA trust are sent with the new connection, and the password field is cleared after saving.

## vnc-settings-023

Original test `Inline X509Plain creation sends exact username/password and custom_ca trust`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1286).

- **Given** The owner is adding an encrypted username-and-password VNC connection with custom certificate trust.
- **When** The owner enters a username and password with surrounding spaces, supplies a CA bundle, and saves.
- **Then** The exact username, password, and custom CA bundle are sent with the new connection, and the password field is cleared after saving.

## vnc-settings-024

Original test `QEMU SCRAM creates only its explicit X509SASL pair and keeps its password out of state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1338).

- **Given** The owner is adding a QEMU SCRAM-SHA-256 connection using X509SASL.
- **When** The owner enters a valid username and a password with surrounding spaces, selects custom CA trust, and saves.
- **Then** The request contains the explicit QEMU SCRAM authentication and X509SASL security pair with the exact credentials and CA bundle. The password is cleared from the field and is not visible in page text.

## vnc-settings-025

Original test `Kerberos password saves independent explicit identities and KDC policy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1392).

- **Given** The owner is adding a Kerberos-password VNC connection with separate VNC service and initiator identities.
- **When** The owner enters service realm EXAMPLE.INVALID, service instance desktop.identity.invalid, KDC kdc.example.com, initiator realm EXAMPLE.INVALID with component Alice, and a password with surrounding spaces, then saves.
- **Then** The request preserves the separate service and initiator identities, direct KDC route and policy, and exact password. The password field is cleared after saving.

## vnc-settings-026

Original test `A supplied service ticket is imported without saving and retains its exact service on Save`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1557).

- **Given** The owner has a service-ticket file to import for the service EXAMPLE.INVALID/vnc/host.example.invalid.
- **When** The owner selects the file and saves the import.
- **Then** No request is sent before Save, the form does not ask for a KDC host, and saving sends the ticket bytes with the exact initiator and service identity.

## vnc-settings-027

Original test `Changing a ticket's service away and back invalidates its pending import`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1595).

- **Given** The owner has selected a service-ticket file while its file read is pending for host.example.invalid.
- **When** The owner changes the service instance to other.example.invalid and back, lets the old read finish, and tries to save.
- **Then** The stale import is rejected with an alert and no request is sent. Selecting a new file for the restored service allows the import to be saved.

## vnc-settings-028

Original test `A replacement keytab is saved without a late file overwriting it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1624).

- **Given** The owner has selected an old keytab file whose read is pending.
- **When** The owner selects a replacement keytab before the old read finishes, then saves.
- **Then** The late old file does not overwrite the replacement; the saved import contains the replacement keytab bytes.

## vnc-settings-029

Original test `Changing an initiator away and back invalidates a pending keytab import`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1657).

- **Given** The owner has selected a keytab while its read is pending for initiator realm EXAMPLE.INVALID.
- **When** The owner changes the realm to OTHER.INVALID and back, lets the old read finish, and tries to save.
- **Then** The stale import is rejected with an alert and no request is sent. Selecting a new keytab for the restored identity allows the import to be saved.

## vnc-settings-030

Original test `A closed dialog cannot deliver its pending keytab into a new dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1690).

- **Given** The owner has selected a keytab in an open import dialog while its read is pending.
- **When** The owner closes that dialog, opens a new keytab dialog, lets the old read finish, and tries to save the new dialog.
- **Then** The old file is not delivered into the new dialog; saving is rejected with an alert and no import request is sent.

## vnc-settings-031

Original test `A keytab read failure is reported and a newly selected file can be saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1716).

- **Given** The owner selects a keytab file whose read fails.
- **When** The owner selects a readable replacement file and saves.
- **Then** The read failure is reported and no request is sent for the unreadable file; the replacement file can be saved successfully.

## vnc-settings-032

Original test `Switching authentication profiles away and back discards a pending keytab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1741).

- **Given** The owner has selected a keytab while its read is pending in the Kerberos keytab profile.
- **When** The owner switches to Kerberos password and back to Kerberos keytab, fills the initiator details, lets the old read finish, and saves.
- **Then** The pending keytab import is discarded, saving shows an alert, and no import request is sent.

## vnc-settings-033

Original test `Changing owners discards a pending keytab even after the original owner returns`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1769).

- **Given** The owner has selected a keytab while its read is pending.
- **When** The signed-in owner changes, then returns to the original owner and opens a new keytab dialog before the old read finishes.
- **Then** The original owner's pending file is discarded; saving the new dialog shows an alert and sends no import request.

## vnc-settings-034

Original test `Kerberos metadata can be read and its stored password replaced without revealing it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1805).

- **Given** A saved Kerberos-password credential has initiator EXAMPLE.INVALID/Alice and a stored password.
- **When** The owner opens credential editing, opts to change login details, enters a replacement password, and saves.
- **Then** The stored password is not revealed, the initiator realm remains read-only, and the update preserves the initiator while replacing the password. The password field is cleared and the new password is absent from page text.

## vnc-settings-035

Original test `Mac classic password defaults to SSH loopback with risk disclosure and bounded password`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1862).

- **Given** The owner is adding a Mac classic VNC-password connection and has a saved SSH host.
- **When** The owner uses the protective route, selects the SSH host, enters a nine-character password and then a six-character password, and saves.
- **Then** The setup has no certificate-name or certificate-trust fields, defaults the destination to 127.0.0.1 without a localhost option, and does not ask for a username. The nine-character password is invalid, while the six-character password saves with the SSH route and Apple classic-password security.

## vnc-settings-036

Original test `Mac VNC (Apple DH) saves SSH loopback selection without X509 trust`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1939).

- **Given** A Mac VNC connection is being added with an Apple DH login, a saved credential, and an available SSH gateway.
- **When** I select the gateway and switch the loopback destination between ::1 and 127.0.0.1, then save using the existing login.
- **Then** The connection is created through SSH to 127.0.0.1 with Apple DH security and the selected credential. Certificate name and certificate-trust controls are absent.

## vnc-settings-037

Original test `Mac VNC (Apple Direct SRP) saves SSH loopback selection without X509 trust`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1939).

- **Given** A Mac VNC connection is being added with an Apple Direct SRP login, a saved credential, and an available SSH gateway.
- **When** I select the gateway and switch the loopback destination between ::1 and 127.0.0.1, then save using the existing login.
- **Then** The connection is created through SSH to 127.0.0.1 with Apple Direct SRP security and the selected credential. Certificate name and certificate-trust controls are absent.

## vnc-settings-038

Original test `Mac VNC (Apple RSA/SRP) saves SSH loopback selection without X509 trust`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L1939).

- **Given** A Mac VNC connection is being added with an Apple RSA/SRP login, a saved credential, and an available SSH gateway.
- **When** I select the gateway and switch the loopback destination between ::1 and 127.0.0.1, then save using the existing login.
- **Then** The connection is created through SSH to 127.0.0.1 with Apple RSA/SRP security and the selected credential. Certificate name and certificate-trust controls are absent.

## vnc-settings-039

Original test `Mac VNC (Apple DH) creates credentials with its username limits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2003).

- **Given** A Mac VNC connection is being added with an Apple DH login, no saved credentials, and an available SSH gateway.
- **When** I enter username operator and a password, then save through the gateway.
- **Then** The created connection uses SSH to 127.0.0.1 and creates a credential with the Apple DH authentication method and those login details. The username field is limited to the Apple DH profile's configured maximum length.

## vnc-settings-040

Original test `Mac VNC (Apple Direct SRP) creates credentials with its username limits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2003).

- **Given** A Mac VNC connection is being added with an Apple Direct SRP login, no saved credentials, and an available SSH gateway.
- **When** I enter username operator and a password, then save through the gateway.
- **Then** The created connection uses SSH to 127.0.0.1 and creates a credential with the Apple Direct SRP authentication method and those login details. The username field is limited to the Apple Direct SRP profile's configured maximum length.

## vnc-settings-041

Original test `Mac VNC (Apple RSA/SRP) creates credentials with its username limits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2003).

- **Given** A Mac VNC connection is being added with an Apple RSA/SRP login, no saved credentials, and an available SSH gateway.
- **When** I enter username operator and a password, then save through the gateway.
- **Then** The created connection uses SSH to 127.0.0.1 and creates a credential with the Apple RSA/SRP authentication method and those login details. The username field is limited to the Apple RSA/SRP profile's configured maximum length.

## vnc-settings-042

Original test `QEMU SCRAM credential rotation preserves its exact profile without revealing secrets`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2066).

- **Given** A QEMU SCRAM-SHA-256 credential is saved for a host.
- **When** I enable changing login details, enter a new password, and save.
- **Then** The update uses the credential's current revision and preserves its QEMU SCRAM-SHA-256 method and username. The password field is cleared and the new secret is not displayed in the page.

## vnc-settings-043

Original test `Plain credential cards and edits expose only password-free metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2119).

- **Given** A username-and-password credential is saved for a host.
- **When** I rename it without enabling login-detail changes, then enable that option and replace the username and password.
- **Then** The credential card and edit form expose the username and other password-free metadata, but no saved password. Renaming sends no authentication details; the later update sends the new username and exact password, then clears the password field and does not display the secret in the page.

## vnc-settings-044

Original test `Plain oversized UTF-8 password validation fails before an API write`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2202).

- **Given** I am creating a plain username-and-password credential with otherwise valid details.
- **When** I enter a password of 342 copies of 界 and save.
- **Then** The form reports a validation error and sends no credential creation request.

## vnc-settings-045

Original test `An X509Plain host edit preserves its exact profile and compatible credential`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2228).

- **Given** A host uses X509Plain security and a compatible username-and-password credential.
- **When** I edit the connection name and save without changing its login or security profile.
- **Then** The update uses generation 4, retains the compatible credential, and keeps the exact X509Plain profile with system certificate trust.

## vnc-settings-046

Original test `Host edits send the reviewed generation and explicit certificate trust changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2276).

- **Given** A host uses X509 VNC security with a custom CA certificate bundle.
- **When** I change certificate trust to system certificate authorities and save the edit.
- **Then** The update uses the displayed generation 4 and explicitly sends X509 VNC security with system trust; the CA bundle field disappears after the trust change.

## vnc-settings-047

Original test `Deleting a host requires confirmation and uses its displayed generation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2320).

- **Given** A host is displayed with generation 4.
- **When** I choose to delete it and confirm in the deletion dialog.
- **Then** No deletion request is sent before confirmation. After confirmation, the host is removed and the request uses generation 4.

## vnc-settings-048

Original test `A reusable credential explains bound-host impact and only replaces its password explicitly`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2351).

- **Given** A reusable VNC credential is bound to two hosts.
- **When** I open its edit form and explicitly enable changing login details, then enter a new password and save.
- **Then** The edit explains the impact on the second bound host, does not initially expose the saved password, and disables credential deletion. Saving sends the new password with revision 3, and the password field is cleared.

## vnc-settings-049

Original test `Renaming a credential keeps its stored password without sending authentication`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2405).

- **Given** A VNC credential has a stored password.
- **When** I change only its name and save.
- **Then** The update uses revision 3 and sends the new name without authentication details, preserving the stored password.

## vnc-settings-050

Original test `Deleting an unused credential sends the reviewed revision after confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2426).

- **Given** A VNC credential is unused and displayed at revision 3.
- **When** I select deletion and confirm it.
- **Then** The credential is removed only after confirmation, and the deletion request uses revision 3.

## vnc-settings-051

Original test `An uncertain host creation preserves its frozen draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2459).

- **Given** I have completed a host-creation draft with a VNC password.
- **When** I save, but the request receives no response.
- **Then** The form reports that saving failed while preserving the password and draft; the password, connection name, and save action are disabled.

## vnc-settings-052

Original test `An unsupported password 密码 remains intact and cannot be saved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2483).

- **Given** I am creating a VNC password credential.
- **When** I enter the unsupported password 密码 and try to save.
- **Then** The value remains in the invalid password field, the form remains open, and no create request is sent.

## vnc-settings-053

Original test `A known invalid credential response retains an editable draft without leaking server details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2508).

- **Given** I am creating a VNC password credential with a draft password.
- **When** The server returns a known invalid-input response containing private details.
- **Then** An alert appears while the draft password remains editable and saving remains enabled. The server's private error details are not shown.

## vnc-settings-054

Original test `Changing owner while token acquisition is pending cancels the save and clears the secret`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2533).

- **Given** I have reviewed a host-creation draft containing password old-pass, and token acquisition is pending when I save.
- **When** The signed-in owner changes before the old owner's token resolves.
- **Then** The draft closes, the secret is cleared, and no host creation request is sent.

## vnc-settings-055

Original test `RSA-AES rsa_aes_ra2/rsa_aes_password saves an independent pin and exact route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2579).

- **Given** I am adding an RSA-AES connection with security type rsa_aes_ra2 and password-only authentication.
- **When** I enter password of 85 copies of 界, review the connection, enter the server RSA key pin, and save a direct connection.
- **Then** The connection is created with RA2 AES-128 security, the exact pin, direct transport, and a password-only credential. The password field allows 255 characters and is cleared after saving.

## vnc-settings-056

Original test `RSA-AES rsa_aes_ra2/rsa_aes_username_password saves an independent pin and exact route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2579).

- **Given** I am adding an RSA-AES connection with security type rsa_aes_ra2 and username-and-password authentication.
- **When** I enter username 用户名 and password of 85 copies of 界, review the connection, enter the server RSA key pin, and save a direct connection.
- **Then** The connection is created with RA2 AES-128 security, the exact pin, direct transport, and a credential containing both login details. The password field allows 255 characters and is cleared after saving.

## vnc-settings-057

Original test `RSA-AES rsa_aes_ra2_256/rsa_aes_password saves an independent pin and exact route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2579).

- **Given** I am adding an RSA-AES connection with security type rsa_aes_ra2_256 and password-only authentication.
- **When** I enter password of 85 copies of 界, review the connection, enter the server RSA key pin, and save a direct connection.
- **Then** The connection is created with RA2_256 AES-256 security, the exact pin, direct transport, and a password-only credential. The password field allows 255 characters and is cleared after saving.

## vnc-settings-058

Original test `RSA-AES rsa_aes_ra2_256/rsa_aes_username_password saves an independent pin and exact route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2579).

- **Given** I am adding an RSA-AES connection with security type rsa_aes_ra2_256 and username-and-password authentication.
- **When** I enter username 用户名 and password of 85 copies of 界, review the connection, enter the server RSA key pin, and save a direct connection.
- **Then** The connection is created with RA2_256 AES-256 security, the exact pin, direct transport, and a credential containing both login details. The password field allows 255 characters and is cleared after saving.

## vnc-settings-059

Original test `RSA-AES rsa_aes_ra2ne/rsa_aes_password saves an independent pin and exact route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2579).

- **Given** I am adding an RSA-AES connection with security type rsa_aes_ra2ne and password-only authentication, with an SSH gateway available.
- **When** I select the gateway, enter password of 85 copies of 界, review the connection, enter the server RSA key pin, and save.
- **Then** The connection is created through SSH to 127.0.0.1 with RA2ne authentication-only security, the exact pin, and a password-only credential. The page explains that SSH protects only its hop; the password field allows 255 characters and is cleared after saving.

## vnc-settings-060

Original test `RSA-AES rsa_aes_ra2ne/rsa_aes_username_password saves an independent pin and exact route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2579).

- **Given** I am adding an RSA-AES connection with security type rsa_aes_ra2ne and username-and-password authentication, with an SSH gateway available.
- **When** I select the gateway, enter username 用户名 and password of 85 copies of 界, review the connection, enter the server RSA key pin, and save.
- **Then** The connection is created through SSH to 127.0.0.1 with RA2ne authentication-only security, the exact pin, and a credential containing both login details. The page explains that SSH protects only its hop; the password field allows 255 characters and is cleared after saving.

## vnc-settings-061

Original test `RSA-AES rsa_aes_ra2ne_256/rsa_aes_password saves an independent pin and exact route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2579).

- **Given** I am adding an RSA-AES connection with security type rsa_aes_ra2ne_256 and password-only authentication, with an SSH gateway available.
- **When** I select the gateway, enter password of 85 copies of 界, review the connection, enter the server RSA key pin, and save.
- **Then** The connection is created through SSH to 127.0.0.1 with RA2ne_256 authentication-only security, the exact pin, and a password-only credential. The page explains that SSH protects only its hop; the password field allows 255 characters and is cleared after saving.

## vnc-settings-062

Original test `RSA-AES rsa_aes_ra2ne_256/rsa_aes_username_password saves an independent pin and exact route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2579).

- **Given** I am adding an RSA-AES connection with security type rsa_aes_ra2ne_256 and username-and-password authentication, with an SSH gateway available.
- **When** I select the gateway, enter username 用户名 and password of 85 copies of 界, review the connection, enter the server RSA key pin, and save.
- **Then** The connection is created through SSH to 127.0.0.1 with RA2ne_256 authentication-only security, the exact pin, and a credential containing both login details. The page explains that SSH protects only its hop; the password field allows 255 characters and is cleared after saving.

## vnc-settings-063

Original test `Trusted RSA public-key import only fills the pin and does not save or establish provenance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2680).

- **Given** I am adding an RSA-AES connection and have entered its independently trusted RSA public PEM.
- **When** I import the public key.
- **Then** The returned SHA-256 pin and 2048-bit key size are displayed, and the form explains that conversion does not establish identity or save the connection. Only the PEM is sent to the import operation; the form stays open.

## vnc-settings-064

Original test `A late RSA import cannot associate its old pin with a newer public-key draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-settings.test.tsx#L2722).

- **Given** I am adding an RSA-AES connection with pin ab repeated 32 times and have started importing an old public-key draft.
- **When** I replace that PEM with a newer draft before the old import responds.
- **Then** An alert appears; the original pin and newer PEM remain unchanged, and no imported-key size is shown.
