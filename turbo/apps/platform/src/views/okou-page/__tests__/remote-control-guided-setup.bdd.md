# Remote control guided setup

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [remote-control-guided-setup.test.tsx](remote-control-guided-setup.test.tsx).

## remote-control-guided-setup-001

Original test `The empty remote directory starts setup from its empty-state action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L145).

- **Given** The remote directory has no devices and shows its empty state.
- **When** The user selects Add connection.
- **Then** The add-connection page offers Computer use, running commands, and screen control; Computer use links to its installation step.

## remote-control-guided-setup-002

Original test `The remote directory waits for ssh before showing an add action with saved connections=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L175).

- **Given** The user opens the remote directory while the SSH connection list is still loading and it will contain no connections.
- **When** The SSH list finishes loading.
- **Then** The empty state appears with exactly one Add connection action; the loading indicator is gone.

## remote-control-guided-setup-003

Original test `The remote directory waits for vnc before showing an add action with saved connections=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L175).

- **Given** The user opens the remote directory while the VNC connection list is still loading and it will contain a saved connection.
- **When** The VNC list finishes loading.
- **Then** The saved connection appears with exactly one Add connection action; the loading indicator is gone.

## remote-control-guided-setup-004

Original test `Computer use opens its download guide from the parallel connection choices`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L222).

- **Given** The user is on the add-connection page with parallel connection choices.
- **When** They open Computer use and continue through its guide, then use browser Back and Previous before closing the guide.
- **Then** The guide advances from installation to permissions to chat, browser Back returns to permissions, and Previous returns to installation. Escape closes the guide and returns to the add-connection choices, where the SSH form remains available.

## remote-control-guided-setup-005

Original test `A Computer use URL restores the installation guide`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L273).

- **Given** The user opens a URL for the Computer use installation step.
- **When** The guide loads and the user closes it with Escape.
- **Then** The installation guide shows the Apple silicon requirement and installation illustration; after closing, the Computer use link still targets the installation step and the command-running choice is available.

## remote-control-guided-setup-006

Original test `A Computer use URL restores the final chat step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L298).

- **Given** The user opens a URL for the final Computer use chat step.
- **When** The guide loads.
- **Then** The chat step appears with “This Mac.”

## remote-control-guided-setup-007

Original test `A VNC URL restores the review step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L308).

- **Given** The user opens a VNC setup URL specifying the trust review step, X.509 VNC profile, and direct route.
- **When** The setup page loads.
- **Then** The Review and save step appears and the URL retains the trust step.

## remote-control-guided-setup-008

Original test `VNC steps follow browser history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L316).

- **Given** The user opens VNC setup at the profile step.
- **When** They continue to the connection step, then use browser Back.
- **Then** The connection step appears with the connection step in the URL; browser Back returns to the VNC login-method choice.

## remote-control-guided-setup-009

Original test `An SSH URL restores the connection form`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L329).

- **Given** The user opens an SSH setup URL at the login step.
- **When** They enter a password.
- **Then** The SSH username form remains available and the password is not added to the URL.

## remote-control-guided-setup-010

Original test `A saved ssh URL restores the persisted connection rather than an empty success screen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L338).

- **Given** A saved SSH connection exists and the user opens its saved-connection setup URL.
- **When** The saved step loads.
- **Then** The Connection added screen shows the persisted connection’s display name, and View connection links to that SSH connection in the remote directory.

## remote-control-guided-setup-011

Original test `A saved vnc URL restores the persisted connection rather than an empty success screen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L338).

- **Given** A saved VNC connection exists and the user opens its saved-connection setup URL.
- **When** The saved step loads.
- **Then** The Connection added screen shows the persisted connection’s display name, and View connection links to that VNC connection in the remote directory.

## remote-control-guided-setup-012

Original test `An unavailable saved connection cannot show a success screen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L360).

- **Given** The user opens an SSH saved-connection URL for a connection that is unavailable.
- **When** The saved step loads.
- **Then** An alert says the configuration is unavailable or access has been lost, and no Connection added screen appears.

## remote-control-guided-setup-013

Original test `A saved computer-setup link can return from network creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L372).

- **Given** The user opens computer setup at the preparation step with no saved network.
- **When** They open the Tailscale setup guide, close it, and go Back twice.
- **Then** The guide offers a Tailscale download link and no in-guide Back or Previous action; closing and navigating back returns first to computer preparation, then to the add-connection page. Cloudflare Access is not offered in the guide.

## remote-control-guided-setup-014

Original test `Computer setup waits for saved networks before showing setup actions: {"configs":[]}`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L403).

- **Given** Computer setup is waiting for the saved-network request, which will return no networks.
- **When** The request completes.
- **Then** The Tailscale setup action appears and there are no saved-network choices or Continue with this network actions.

## remote-control-guided-setup-015

Original test `Computer setup waits for saved networks before showing setup actions: {"configs":[{"id":"a0000000-0000-4000-8000-000000000001","name":"Office network","scope":"personal","tags":["tag:okou"],"revision":1,"generation":1,"sshHosts":[],"vncHosts":[],"createdAt":"2026-10-19T00:00:00.000Z","updatedAt":"2026-10-19T00:00:00.000Z"}]}`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L403).

- **Given** Computer setup is waiting for the saved-network request, which will return one Office network.
- **When** The request completes.
- **Then** The Tailscale setup action and one saved-network choice with one Continue with this network action appear.

## remote-control-guided-setup-016

Original test `Connecting my computer returns after creating a Tailscale network and uses the chosen network`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L433).

- **Given** The user is setting up computer access with no saved Tailscale networks; a Cloudflare network also exists.
- **When** They create a Tailscale network named Home network, select it, and continue to configure SSH.
- **Then** The new network is selected, the Continue action is initially disabled until selection, and Cloudflare is not offered. Continuing reaches the computer-action choice without a private-networks action; returning preserves Home network. The SSH form uses Home network, hides connection-method selection even in More settings, and starts with an empty device address.

## remote-control-guided-setup-017

Original test `A refreshed computer network setup returns to the computer guide, not the provider picker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L495).

- **Given** The user opens computer setup from the private-network page.
- **When** The computer setup page loads.
- **Then** The preparation guide and Set up Tailscale action appear; Cloudflare Access is not shown as a provider choice.

## remote-control-guided-setup-018

Original test `Computer SSH saves the chosen network without exposing route selection or depending on Cloudflare`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L522).

- **Given** The user configures computer SSH on the chosen Tailscale network, entering address 100.64.0.24, username, and password; Cloudflare is not needed.
- **When** They save the connection.
- **Then** The connection is added with address and display name 100.64.0.24, port 22, and the chosen Tailscale network. No connection-method selector is exposed.

## remote-control-guided-setup-019

Original test `Computer screen sharing saves the selected network and optional name ""`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L549).

- **Given** The user configures Apple screen sharing on the selected Tailscale network at 100.64.0.24, enters login credentials, and leaves the optional connection name blank.
- **When** They review and save the connection.
- **Then** The name is optional, review does not show certificate-trust guidance, and the saved VNC connection uses display name 100.64.0.24, port 5900, the chosen network, and Apple security.

## remote-control-guided-setup-020

Original test `Computer screen sharing saves the selected network and optional name "My Mac"`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L549).

- **Given** The user configures Apple screen sharing on the selected Tailscale network at 100.64.0.24, enters login credentials, and sets the optional connection name to My Mac.
- **When** They review and save the connection.
- **Then** The name is optional, review does not show certificate-trust guidance, and the saved VNC connection uses display name My Mac, port 5900, the chosen network, and Apple security.

## remote-control-guided-setup-021

Original test `Other computer screen-sharing services retain explicit authentication and certificate settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L608).

- **Given** The user configures computer screen sharing with Other VNC software and selects X509None, encrypted without a VNC password.
- **When** They continue through device and login steps to review.
- **Then** The review step shows the Server certificate trust setting.

## remote-control-guided-setup-022

Original test `An account can open its network list and count dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L630).

- **Given** A member account has a saved network and opens its network-connections link.
- **When** They close the Connections using this network dialog.
- **Then** The dialog is available and closing it reveals the Personal networks region.

## remote-control-guided-setup-023

Original test `Private network links to connection management without starting device setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L650).

- **Given** The user opens private-network setup with SSH in the URL.
- **When** They select Manage device connections.
- **Then** The remote directory’s empty state appears, and the Add remote connection setup page does not appear.

## remote-control-guided-setup-024

Original test `A tailscale network title is read-only and its Manage action opens details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L662).

- **Given** A Tailscale network is listed on the private-networks page.
- **When** The user clicks its plain title, then selects Manage and returns to the network list.
- **Then** The title itself is not a link or button and does not open details. Manage opens details with Edit settings, enabled Delete Tailscale, ownership shown as Only me, and no Add connection or delete-restriction action; returning leaves the title noninteractive and Manage links to that network’s details.

## remote-control-guided-setup-025

Original test `A cloudflare network title is read-only and its Manage action opens details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L662).

- **Given** A Cloudflare Access network is listed on the private-networks page.
- **When** The user clicks its plain title, then selects Manage and returns to the network list.
- **Then** The title itself is not a link or button and does not open details. Manage opens details with Edit settings, enabled Delete Cloudflare Access, ownership shown as Only me, and no Add connection or delete-restriction action; returning leaves the title noninteractive and Manage links to that network’s details.

## remote-control-guided-setup-026

Original test `The VNC entry opens protocol selection and Back returns to it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L704).

- **Given** The user opens VNC setup from the add-connection URL.
- **When** They choose screen control and then select Back.
- **Then** The VNC login-method choice appears, with a Remote control action; Back returns to the add-connection choices. No connection-method selector, Back action, private-network action, or Tailscale installation prompt appears on the initial add-connection page.

## remote-control-guided-setup-027

Original test `Manual SSH retains its selected tailscale network and clears login drafts when restarted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L757).

- **Given** A saved Tailscale network is available for manual SSH setup.
- **When** The user leaves VNC setup, starts SSH, enters login drafts and a device address, selects that Tailscale network, then backs out and restarts SSH.
- **Then** The selected network is retained, while the restarted SSH username, address, and password are blank. Leaving for Remote control returns to the empty remote directory.

## remote-control-guided-setup-028

Original test `Manual SSH retains its selected cloudflare network and clears login drafts when restarted`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L757).

- **Given** A saved Cloudflare Access network is available for manual SSH setup.
- **When** The user leaves VNC setup, starts SSH, enters login drafts and a device address, selects that Cloudflare network, then backs out and restarts SSH.
- **Then** The selected network is retained, while the restarted SSH username, address, and password are blank. Leaving for Remote control returns to the empty remote directory.

## remote-control-guided-setup-029

Original test `Manual VNC keeps its selected tailscale network during protective profile changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L802).

- **Given** A saved Tailscale network is available for manual VNC setup, and the user has selected Apple screen sharing and entered a device address.
- **When** They return to the login-method choice, change the profile to certificate-based VNC, and continue.
- **Then** The selected Tailscale network and device address remain in the connection step, with no Add SSH connection action. Leaving for Remote control returns to the empty remote directory.

## remote-control-guided-setup-030

Original test `Manual VNC keeps its selected cloudflare network during protective profile changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L802).

- **Given** A saved Cloudflare Access network is available for manual VNC setup, and the user has selected Apple screen sharing and entered a device address.
- **When** They return to the login-method choice, change the profile to certificate-based VNC, and continue.
- **Then** The selected Cloudflare Access network and device address remain in the connection step, with no Add SSH connection action. Leaving for Remote control returns to the empty remote directory.

## remote-control-guided-setup-031

Original test `Manual setup clears the chosen network when leaving for the remote directory`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L842).

- **Given** The user selects a saved Cloudflare Access network during manual SSH setup.
- **When** They leave to the private-networks page, then return to the remote directory and start adding a connection.
- **Then** The remote directory shows its empty state, and the new add-connection page has no Back action.

## remote-control-guided-setup-032

Original test `Manual SSH chooses a saved Tailscale SSH route and saves without SSH credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L859).

- **Given** Manual SSH setup offers Office and Home Tailscale networks, a Cloudflare Access network, and Tailscale SSH routes; the user enters address 100.64.0.25 and selects Home network’s Tailscale SSH route with system username ubuntu.
- **When** They switch between Cloudflare and the Tailscale SSH route, then save.
- **Then** Switching routes preserves the entered address and the relevant SSH credentials; Tailscale SSH disables the password and port controls and does not show an alert. The saved connection uses address 100.64.0.25, port 22, username ubuntu, and Home network’s Tailscale SSH route, without SSH credentials.

## remote-control-guided-setup-033

Original test `tailscale settings allow optional credential replacement without fetching saved secrets`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L942).

- **Given** The user edits Tailscale network settings and has not enabled credential replacement.
- **When** They enable replacement, enter a new client secret, reveal it, go Back, reopen settings, and enable replacement again.
- **Then** The saved secret is never prefilled; replacement requires a blank password-type secret field, which can be revealed as text. Reopening settings starts with replacement disabled and no secret field; enabling it again shows a blank password field.

## remote-control-guided-setup-034

Original test `cloudflare settings allow optional credential replacement without fetching saved secrets`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L942).

- **Given** The user edits Cloudflare Access network settings and has not enabled credential replacement.
- **When** They enable replacement, enter a new client secret, reveal it, go Back, reopen settings, and enable replacement again.
- **Then** The saved secret is never prefilled; replacement requires a blank password-type secret field, which can be revealed as text. Reopening settings starts with replacement disabled and no secret field; enabling it again shows a blank password field.

## remote-control-guided-setup-035

Original test `tailscale settings save with optional credential replacement=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L999).

- **Given** The user edits Tailscale network settings and enters the updated name Updated office network; credential replacement is disabled.
- **When** They save the settings.
- **Then** The updated name appears and the edit action remains available. The update includes the expected revision and Tailscale tags, but no replacement credentials; the network revision advances to 2 while generation stays 1.

## remote-control-guided-setup-036

Original test `tailscale settings save with optional credential replacement=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L999).

- **Given** A saved Tailscale network is open for settings editing.
- **When** The user changes its name and selects credential replacement, then saves valid OAuth credentials.
- **Then** The updated name is saved with the existing tags and replacement credentials; the network detail shows the new name.

## remote-control-guided-setup-037

Original test `cloudflare settings save with optional credential replacement=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L999).

- **Given** A saved Cloudflare Access network is open for settings editing.
- **When** The user changes its name without selecting credential replacement and saves.
- **Then** The updated name is saved without sending replacement credentials, and the network detail shows the new name.

## remote-control-guided-setup-038

Original test `cloudflare settings save with optional credential replacement=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L999).

- **Given** A saved Cloudflare Access network is open for settings editing.
- **When** The user changes its name, selects credential replacement, and saves valid service-token credentials.
- **Then** The updated name is saved with the replacement credentials, and the network detail shows the new name.

## remote-control-guided-setup-039

Original test `Direct SSH accepts an optional name, retains input through username help and saves through the contract`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1055).

- **Given** The user is adding a direct SSH connection, with an optional blank name and password login selected.
- **When** They enter a device address, username, password, and connection name, reveal and hide the password, and open then dismiss username help.
- **Then** The entered values are retained, the optional name is not required, and the connection saves with the entered name, address, and default port 22. A success view offers a link to the saved connection and no Open chat link.

## remote-control-guided-setup-040

Original test `An unnamed SSH connection uses the current device address after correcting a rejected save`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1122).

- **Given** The user is adding an unnamed direct SSH connection and enters a device address, username, and password.
- **When** The first save is rejected for an invalid host, they correct the address, and retry without entering a name.
- **Then** The blank optional name uses the corrected address as the displayed and credential name, and the retry saves the corrected host; the rejected host is not reused.

## remote-control-guided-setup-041

Original test `Empty private networks show disabled options and guidance only inside the network menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1170).

- **Given** The user is adding an SSH connection while no private networks are saved and the network list is still loading.
- **When** They open the connection-method menu, wait for loading to finish, and return to direct connection.
- **Then** Private networks is unavailable while loading and becomes disabled with guidance only inside the open menu once loading completes. Direct connection remains selected with its address field enabled, and the guidance disappears when the menu is closed.

## remote-control-guided-setup-042

Original test `Saved network loading failures leave direct access available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1202).

- **Given** The user is adding an SSH connection and the saved Tailscale network list fails to load.
- **When** They open the connection-method menu after the loading failure.
- **Then** A load-failure notice says form entries are saved. Direct connection remains selected and usable, with no private-network option or empty-state guidance.

## remote-control-guided-setup-043

Original test `The remote selector lists all saved networks without auto-selecting a single provider`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1223).

- **Given** The user is adding an SSH connection while two Tailscale networks and one Cloudflare Access network are saved.
- **When** They open the connection-method menu and choose the Home network Tailscale entry.
- **Then** The selector initially remains on Direct connection rather than auto-selecting a provider; the menu lists saved networks, and choosing Home network selects it without showing empty-state guidance.

## remote-control-guided-setup-044

Original test `VNC keeps empty SSH selection disabled and preserves the draft between steps`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1258).

- **Given** The user is adding VNC with a saved Tailscale network but no saved SSH connections.
- **When** They choose Apple screen sharing, continue, and then select Tailscale and a saved network before entering port 5901 and going back and forward.
- **Then** The empty SSH-host choice is disabled with guidance; dependent address and advanced fields are hidden until a usable network is selected. The VNC draft retains port 5901 across the step change, and no Add SSH connection action is offered.

## remote-control-guided-setup-045

Original test `VNC with no saved network hides dependent fields and preserves the address when switching back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1316).

- **Given** The user is adding a direct VNC connection and enters an address, with no Tailscale or Cloudflare Access networks saved.
- **When** They switch to Cloudflare Access, then Tailscale, and finally back to direct connection.
- **Then** Each provider's saved-network selector is disabled with provider-specific empty-state guidance; dependent address, advanced fields, and Continue are unavailable while a saved network is required. Switching back to direct connection restores the entered address and enables Continue.

## remote-control-guided-setup-046

Original test `VNC displays saved Cloudflare connection details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1360).

- **Given** The user is adding VNC and one Cloudflare Access network is saved.
- **When** They choose Apple screen sharing, select Cloudflare Access and the saved network, enter an address, open address help, and continue through the connection step.
- **Then** Origin TLS is checked and cannot be changed, the address-help dialog contains three items, and dismissing it preserves the address. After entering an origin TLS server name, the user can continue to device login information.

## remote-control-guided-setup-047

Original test `VNC can select an existing SSH host without empty-state guidance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1409).

- **Given** The user is adding VNC and an SSH host is already saved.
- **When** They choose the saved-SSH-host connection method and select that host.
- **Then** The SSH host is selectable, its display name is shown, and Continue is enabled without empty-state guidance or an Add SSH connection action.

## remote-control-guided-setup-048

Original test `tailscale network deletion explains its ssh dependency beside the disabled action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1442).

- **Given** A Tailscale network is used by an SSH host, so its Delete Tailscale action is disabled.
- **When** The user opens the explanation for why the network cannot be deleted.
- **Then** The explanation says SSH or VNC hosts still use the network and must be rebound or deleted first; it appears beside the disabled action in the dialog, and dismissing the dialog returns focus to the explanation control.

## remote-control-guided-setup-049

Original test `cloudflare network deletion explains its vnc dependency beside the disabled action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1442).

- **Given** A Cloudflare Access network is used by a VNC host, so its Delete Cloudflare Access action is disabled.
- **When** The user opens the explanation for why the network cannot be deleted.
- **Then** The explanation says SSH or VNC hosts still use the network and must be rebound or deleted first; it appears beside the disabled action in the dialog, and dismissing the dialog returns focus to the explanation control.

## remote-control-guided-setup-050

Original test `Changing category abandons setup and returns to management`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1488).

- **Given** The user has entered a username in the SSH setup flow.
- **When** They change the connector category to Private networks and then return to Remote control management.
- **Then** Setup is abandoned, the Remote control management page appears, and the SSH username field is no longer present.

## remote-control-guided-setup-051

Original test `SSH login methods are explicit keyboard choices that show only the matching secret fields`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1502).

- **Given** The user is adding direct SSH with password login selected and a username entered.
- **When** They use the keyboard to switch to SSH key login and then back to password login.
- **Then** Each choice shows only its matching required secret field: a required private key with file-import access and optional passphrase, or a required password. The username remains unchanged.

## remote-control-guided-setup-052

Original test `SSH private-key help explains key locations and what to do without a key`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1535).

- **Given** The user is adding direct SSH and has selected SSH key login.
- **When** They open private-key help and dismiss it.
- **Then** Help lists three items covering key locations, including Windows user-profile paths and .pem files, and explains the target account; the private-key field remains blank.

## remote-control-guided-setup-053

Original test `Selecting SSH key login submits the private key rather than the previous password`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1553).

- **Given** The user is adding direct SSH, has entered a password, and then selects SSH key login.
- **When** They enter a private key and passphrase, name the connection, and save.
- **Then** The connection is created using private-key authentication with the entered key and passphrase, not the previously entered password.

## remote-control-guided-setup-054

Original test `A rejected SSH save retains the entered name and does not show a success state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1592).

- **Given** The user is adding direct SSH and has entered a connection name, address, username, and password.
- **When** The server rejects the save because the host is invalid.
- **Then** An alert appears, the entered name remains, the Add connection action is enabled for another attempt, and no success state is shown.

## remote-control-guided-setup-055

Original test `VNC saves only after reviewing the connection and server identity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1615).

- **Given** The user is adding VNC with encrypted X509None security and no saved network.
- **When** They enter an address, provide a required connection name, continue to review, and save.
- **Then** No save request occurs before the review step. Review shows system certificate-authority trust, and saving creates the connection with the entered name, address, default port 5900, and X509None system trust.

## remote-control-guided-setup-056

Original test `VNC clears a rejected save when users edit and validates again on retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1702).

- **Given** The user is on the VNC review step and a save was rejected for an invalid host.
- **When** They edit the VNC certificate name and retry saving.
- **Then** The first alert clears when they edit, but retrying shows the invalid-host alert again and no connection-added success state appears.

## remote-control-guided-setup-057

Original test `VNC clears a rejected save when users select and validates again on retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1702).

- **Given** The user is on the VNC review step and a save was rejected for an invalid host.
- **When** They change server certificate trust to custom authorities, then back to system authorities, and retry saving.
- **Then** The first alert clears when they change the selection, but retrying shows the invalid-host alert again and no connection-added success state appears.

## remote-control-guided-setup-058

Original test `VNC clears a rejected save between steps without losing the draft or skipping validation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1748).

- **Given** The user is on the VNC review step after an invalid-host save rejection, with the address and connection name already entered.
- **When** They go back through the setup steps and return to review without changing the draft, then save again.
- **Then** The rejection alert clears on earlier steps and during continued navigation, while the entered address and name remain. The retry is validated and shows the invalid-host alert again without a success state.

## remote-control-guided-setup-059

Original test `VNC does not show a late save rejection on earlier setup steps`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1790).

- **Given** The user is saving a VNC connection and the request is still pending.
- **When** They go back to an earlier setup step before the request returns an invalid-host rejection.
- **Then** The save control is initially disabled as Saving; after the rejection arrives, no alert appears on the earlier steps, and the entered device address remains in the draft.

## remote-control-guided-setup-060

Original test `VNC shows rsa import errors only on their owning setup step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1820).

- **Given** The user is configuring RSA-AES VNC and reaches review with an invalid trusted public key entered.
- **When** They request import of the trusted RSA public key and then go back to the login step.
- **Then** An import-error alert says to check the VNC configuration and try again; the alert disappears on the login step.

## remote-control-guided-setup-061

Original test `VNC shows kerberos import errors only on their owning setup step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1820).

- **Given** The user is configuring QEMU or enterprise VNC authentication with Kerberos service-ticket login.
- **When** They upload an empty service-ticket file and go back to the connection step.
- **Then** An import-error alert says to check the VNC configuration and try again; the alert disappears on the connection step.

## remote-control-guided-setup-062

Original test `VNC keeps 500 failure notices on the save step while preserving the locked draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1904).

- **Given** The user is saving a VNC connection and the server returns HTTP 500.
- **When** They go back from the save step and then continue to review again.
- **Then** The save step shows “Save failed.”; the alert is absent on the earlier step while the connection-name draft is locked. On returning to review, the same alert remains and Save is disabled.

## remote-control-guided-setup-063

Original test `VNC keeps 409 failure notices on the save step while preserving the locked draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1904).

- **Given** The user is saving a VNC connection and the server returns HTTP 409.
- **When** They go back from the save step and then continue to review again.
- **Then** The save step says the resource could not be created; the alert is absent on the earlier step while the connection-name draft is locked. On returning to review, the same alert remains and Save is disabled.

## remote-control-guided-setup-064

Original test `Mac VNC review shows its network, address, and account method before saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1936).

- **Given** The user is adding Mac VNC through a saved Tailscale network using Apple screen sharing.
- **When** They enter the device address, username, password, and connection name, then continue to review.
- **Then** The review shows the address, the Tailscale network name, and Apple DH username-and-password authentication; Save is enabled.

## remote-control-guided-setup-065

Original test `Restarting VNC setup clears the previous draft but Back within setup preserves it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L1969).

- **Given** The user has entered an address, VNC password, and connection name during setup.
- **When** They use Back within setup, then leave setup and start a new VNC setup.
- **Then** Back within setup preserves the draft across steps. Starting a new setup clears the previous address, password, and name.

## remote-control-guided-setup-066

Original test `Switching protocols starts the matching editor instead of retaining the previous protocol form`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2029).

- **Given** The user has entered an SSH username and returns to the protocol chooser.
- **When** They start VNC setup.
- **Then** The VNC login-method step appears and the SSH username field is absent.

## remote-control-guided-setup-067

Original test `Leaving setup cancels pending credential loading`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2044).

- **Given** The user is in SSH setup while credential loading is pending.
- **When** They leave setup for Private networks, allow credential loading to finish, and return to Remote control management.
- **Then** No credential dialog remains after leaving setup, and the management page appears without the SSH username field.

## remote-control-guided-setup-068

Original test `An unknown SSH save outcome locks the connection draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2069).

- **Given** The user is adding direct SSH with an entered name, address, username, and password.
- **When** The server returns an unknown save outcome with HTTP 500.
- **Then** A “Save failed.” notice appears and the draft becomes locked: the name field and both login-method choices are disabled.

## remote-control-guided-setup-069

Original test `Guided SSH directory refreshes a connection changed in another window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2170).

- **Given** A member is viewing the guided SSH connection directory while another window changes a saved connection's display name.
- **When** A connection-changed event occurs for the member's organization.
- **Then** The directory refreshes and shows the renamed connection.

## remote-control-guided-setup-070

Original test `Guided SSH details refreshes a connection changed in another window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2170).

- **Given** A member is viewing the details of a guided SSH connection while another window changes its display name.
- **When** A connection-changed event occurs for the member's organization.
- **Then** The details view refreshes and shows the renamed connection.

## remote-control-guided-setup-071

Original test `An SSH deletion stays pending while its details refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2213).

- **Given** A member is viewing a saved SSH connection and has confirmed its deletion.
- **When** The connection details refresh while deletion is pending.
- **Then** The delete dialog remains visible and Cancel is disabled. After deletion completes, the dialog closes and the unavailable-or-no-access message appears.

## remote-control-guided-setup-072

Original test `The tailscale deletion dialog survives a pending and failed detail refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2273).

- **Given** A member is viewing a Tailscale network and its delete dialog is open.
- **When** A refresh remains pending and then fails with a service error.
- **Then** The dialog remains visible during the refresh and after failure; the network heading disappears and a Tailscale load error appears. Cancel closes the dialog.

## remote-control-guided-setup-073

Original test `The cloudflare deletion dialog survives a pending and failed detail refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2273).

- **Given** A member is viewing a Cloudflare Access network and its delete dialog is open.
- **When** A refresh remains pending and then fails with a service error.
- **Then** The dialog remains visible during the refresh and after failure; the network heading disappears and a Cloudflare Access load error appears. Cancel closes the dialog.

## remote-control-guided-setup-074

Original test `The guided ssh edit entry displays pending credentials and a failed load`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2329).

- **Given** A saved SSH connection is open and its credentials request is pending.
- **When** The user opens the connection editor, then the credentials request fails.
- **Then** The Edit connection action is disabled and marked busy while loading; a message says SSH settings could not be loaded after failure.

## remote-control-guided-setup-075

Original test `The guided vnc edit entry displays pending credentials and a failed load`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2329).

- **Given** A saved VNC connection is open and its credentials request is pending.
- **When** The user opens the connection editor, then the credentials request fails.
- **Then** The Edit connection action is disabled and marked busy while loading; a message says the VNC configuration could not be loaded after failure.

## remote-control-guided-setup-076

Original test `The guided ssh credentials list stays visible while a saved rename reloads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2375).

- **Given** The SSH credentials page shows a saved login.
- **When** The user renames it and its updated credentials reload is held pending.
- **Then** The old credential name remains visible during the reload, then the updated name appears.

## remote-control-guided-setup-077

Original test `The guided vnc credentials list stays visible while a saved rename reloads`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2375).

- **Given** The VNC credentials page shows a saved login.
- **When** The user renames it and its updated credentials reload is held pending.
- **Then** The old credential name remains visible during the reload, then the updated name appears.

## remote-control-guided-setup-078

Original test `Guided private network directory refreshes SSH usage changed in another window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2454).

- **Given** The private-network directory shows Office network with zero connections.
- **When** SSH usage changes in another window.
- **Then** Office network updates to show one connection.

## remote-control-guided-setup-079

Original test `The Cloudflare network list and connections dialog stay visible during a background refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2471).

- **Given** The Cloudflare network list shows Office network with one SSH connection, and its connections dialog is open.
- **When** A background refresh begins and then returns an updated server name.
- **Then** The network and dialog remain visible while refresh is pending with the old server name; the dialog then shows the updated server name.

## remote-control-guided-setup-080

Original test `A failed Tailscale network refresh removes stale data`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2523).

- **Given** The private-network directory shows a Tailscale network.
- **When** A refresh triggered by a change in another window fails with a service error.
- **Then** A Tailscale load error appears and the stale network disappears; the empty-state message does not appear.

## remote-control-guided-setup-081

Original test `A failed Cloudflare Access network refresh removes stale data`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2523).

- **Given** The private-network directory shows a Cloudflare Access network.
- **When** A refresh triggered by a change in another window fails with a service error.
- **Then** A Cloudflare Access load error appears and the stale network disappears; the empty-state message does not appear.

## remote-control-guided-setup-082

Original test `Switching account immediately removes the previous owner's network data`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2546).

- **Given** The directory shows the current account owner's Tailscale and Cloudflare networks.
- **When** The signed-in account changes while refreshed network requests are pending.
- **Then** Both networks belonging to the previous owner disappear immediately.

## remote-control-guided-setup-083

Original test `Switching workspace immediately removes the previous owner's network data`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2546).

- **Given** The directory shows the current workspace owner's Tailscale and Cloudflare networks.
- **When** The active workspace changes while refreshed network requests are pending.
- **Then** Both networks belonging to the previous owner disappear immediately.

## remote-control-guided-setup-084

Original test `Guided private network details refresh SSH usage changed in another window`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2612).

- **Given** A Cloudflare Access network's details show its delete action enabled and no SSH connection listed.
- **When** SSH usage changes in another window and the details refresh.
- **Then** The SSH connection appears and deleting the network becomes disabled.

## remote-control-guided-setup-085

Original test `Credentials have a separate page without adding controls to the connection list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2629).

- **Given** The remote-connections list contains SSH and VNC connections with saved credentials in use.
- **When** The user opens Manage credentials, switches to VNC credentials, and returns to remote connections.
- **Then** Credentials have a separate page showing login details for each protocol. Deletion is disabled for credentials in use, its explanatory message appears on request and closes on Escape, and the remote-connections list remains reachable without adding credential controls to it.

## remote-control-guided-setup-086

Original test `Editing ssh credentials keeps secrets hidden until replacement is selected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2667).

- **Given** A saved SSH credential is being edited and its saved password is hidden.
- **When** The user selects Change login details, enters a replacement password, hides the replacement fields, and selects them again.
- **Then** The replacement password field is required, masked, and initially blank; hiding removes it and reopening it starts blank. The existing login details remain visible and cancel closes the dialog.

## remote-control-guided-setup-087

Original test `Editing vnc credentials keeps secrets hidden until replacement is selected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2667).

- **Given** A saved VNC credential with Apple DH username-and-password authentication is being edited and its password is hidden.
- **When** The user selects Change login details, enters a replacement password, hides the replacement fields, and selects them again.
- **Then** The replacement password field is required, masked, and initially blank; hiding removes it and reopening it starts blank. The existing login details remain visible and cancel closes the dialog.

## remote-control-guided-setup-088

Original test `The standalone ssh credentials page supports adding, renaming, and deleting an unused credential`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2725).

- **Given** The standalone SSH credentials page has no saved credentials.
- **When** The user adds a password login named Reusable login, renames it Renamed login, and deletes it.
- **Then** The credential is created, renamed, and removed; the page returns to zero credentials and Add credential is enabled.

## remote-control-guided-setup-089

Original test `The standalone vnc credentials page supports adding, renaming, and deleting an unused credential`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2725).

- **Given** The standalone VNC credentials page has no saved credentials.
- **When** The user adds a password login named Reusable login, renames it Renamed login, and deletes it.
- **Then** The credential is created, renamed, and removed; the page returns to zero credentials and Add credential is enabled.

## remote-control-guided-setup-090

Original test `VNC details separate login information from chat permissions without repeating the route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2818).

- **Given** A VNC connection uses a saved Apple DH login and a Tailscale network.
- **When** The user opens Server identity and chat permissions and enables the connection for chats by default.
- **Then** The details show the network once, the host and port once, the saved login name and Mac VNC (Apple DH) method, and the authentication method without repeating the route or showing an RFB destination. The chat-default switch starts off and enabling it saves the VNC connection's enabled default.

## remote-control-guided-setup-091

Original test `VNC details retain the complete TLS certificate identity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2935).

- **Given** A VNC connection has TLS certificate security with system trust and server name screen.internal.example.com.
- **When** The user opens Server identity and chat permissions.
- **Then** The complete TLS certificate identity, screen.internal.example.com, is displayed.

## remote-control-guided-setup-092

Original test `VNC details retain the complete Server RSA wire-key SHA256`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2935).

- **Given** A VNC connection uses RSA-AES-RA2 security with a server key SHA256 of 64 hexadecimal characters, all `ab`.
- **When** The user opens Server identity and chat permissions.
- **Then** The complete Server RSA wire-key SHA256 value is displayed.

## remote-control-guided-setup-093

Original test `ssh editing leaves saved secrets blank and renaming keeps the existing credential`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2966).

- **Given** A saved SSH connection uses an existing credential.
- **When** The user edits the connection, leaves its secret unchanged, renames the device, and saves.
- **Then** The secret field starts blank and is optional, no credential-name field is shown, and the saved update keeps the existing credential while applying the new connection name.

## remote-control-guided-setup-094

Original test `vnc editing leaves saved secrets blank and renaming keeps the existing credential`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L2966).

- **Given** A saved VNC connection uses an existing credential.
- **When** The user edits the connection, leaves its secret unchanged, renames the device, and saves.
- **Then** The secret field starts blank and is optional, no credential-name field is shown, and the saved update keeps the existing credential while applying the new connection name.

## remote-control-guided-setup-095

Original test `VNC editing groups login details and keeps field guidance available without repeated sections`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3012).

- **Given** A VNC connection uses a saved Apple DH login with username operator.
- **When** The user opens its editor, enters a draft password, expands connection settings, and requests login and protocol guidance.
- **Then** There is one Login information section; the username is prefilled and the optional password is blank. Guidance is available on request, including `whoami`, and closes on Escape with focus returned to its trigger. Connection settings expose service type and login method, protocol guidance mentions certificates, and collapsing settings preserves the password draft.

## remote-control-guided-setup-096

Original test `ssh shared login requires confirmation; cancelling retains the draft without writing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3098).

- **Given** An SSH connection shares its saved login with two connections.
- **When** The user changes the password, chooses Continue editing at the confirmation, then saves and confirms the update.
- **Then** The first save prompts with the affected connection and count, and cancellation retains the password draft without writing either connection or login. The confirmed save writes the shared password update using expected credential revision 3 and updates the connection.

## remote-control-guided-setup-097

Original test `vnc shared login requires confirmation; cancelling retains the draft without writing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3098).

- **Given** A VNC connection shares its saved login with two connections.
- **When** The user changes the password, chooses Continue editing at the confirmation, then saves and confirms the update.
- **Then** The first save prompts with the affected connection and count, and cancellation retains the password draft without writing either connection or login. The confirmed save writes the shared password update using expected credential revision 4 and updates the connection.

## remote-control-guided-setup-098

Original test `SSH login reuse is optional, shows the selected account, and can return to manual entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3159).

- **Given** The SSH add-connection form contains a device address, username, and password draft, and a saved login is available.
- **When** The user opens and dismisses the saved-login picker, selects a saved login, then switches back to manual entry.
- **Then** Dismissing the picker preserves the manual draft. Selecting the saved login shows its account name and username with Password, hides the password field, and offers no SSH-key option; returning to manual entry clears username and password but retains the device address.

## remote-control-guided-setup-099

Original test `VNC can reuse a saved password and switch back to manual entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3200).

- **Given** The VNC add-connection flow has a device address and a saved VNC password login available.
- **When** The user selects the saved login and switches back to manual entry.
- **Then** The selected account name is shown and the VNC password field is hidden; manual entry restores a blank VNC password field.

## remote-control-guided-setup-100

Original test `VNC reuse offers only login information matching the configured authentication profile`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3231).

- **Given** A VNC connection is being edited with password-based authentication and saved login choices exist for VNC and SSH.
- **When** The user opens the saved-login picker, then changes the authentication method to X509None.
- **Then** The picker offers the matching VNC login but not the SSH login. With X509None selected, the saved-login action and VNC password field are absent.

## remote-control-guided-setup-101

Original test `ssh revision conflicts preserve the login draft and partial save result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3252).

- **Given** An SSH connection and its shared credential are being edited; another connection is added to the credential after the initial load.
- **When** The user changes the password and confirms the shared-login update, which encounters a credential revision conflict.
- **Then** The password draft remains visible and a message says connection settings were saved but the login update needs review before leaving. Save is disabled.

## remote-control-guided-setup-102

Original test `vnc revision conflicts preserve the login draft and partial save result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3252).

- **Given** A VNC connection and its shared credential are being edited; another connection is added to the credential after the initial load.
- **When** The user changes the password and confirms the shared-login update, which encounters a credential revision conflict.
- **Then** The password draft remains visible and a message says connection settings were saved but the login update needs review before leaving. Save is disabled.

## remote-control-guided-setup-103

Original test `Private network URL restores tailscale guide step 4`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3363).

- **Given** The user opens a private-network URL specifying the Tailscale guide at step 4.
- **When** The page loads.
- **Then** The guide opens on “Generate and copy the credential” and shows step 4 of 4.

## remote-control-guided-setup-104

Original test `Private network URL restores cloudflare guide step 3`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3363).

- **Given** The user opens a private-network URL specifying the Cloudflare guide at step 3.
- **When** The page loads.
- **Then** The guide opens on “Enter connection credentials” and shows step 3 of 3.

## remote-control-guided-setup-105

Original test `Private network URL restores the tailscale editor without returning credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3377).

- **Given** A private-network URL requests the Tailscale editor for an existing network.
- **When** The page loads.
- **Then** The network name is prefilled, and no Client Secret field is shown.

## remote-control-guided-setup-106

Original test `Private network URL restores the cloudflare editor without returning credentials`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3377).

- **Given** A Tailscale or Cloudflare Access network exists and the user opens its private-network edit URL.
- **When** The provider-specific edit page loads.
- **Then** The network name is restored, but no client secret is returned or shown.

## remote-control-guided-setup-107

Original test `Private network history restores the provider picker and guide step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3396).

- **Given** The user is adding a private network and selects Cloudflare Access.
- **When** They advance the service-token guide to step 2, then navigate back in browser history.
- **Then** The guide remains open and returns to step 1.

## remote-control-guided-setup-108

Original test `A missing private network URL stays unavailable and can return to creation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3413).

- **Given** The user opens an edit URL for a Tailscale network that is not in the loaded list.
- **When** The page attempts to load the network, then the user chooses Back and Add network.
- **Then** An Unable to load alert appears without an edit form; the user can return to the Add a private network page.

## remote-control-guided-setup-109

Original test `A member cannot open an organization tailscale editor through a URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3429).

- **Given** A member opens a URL for an organization-scoped Tailscale network.
- **When** The edit page attempts to load the network.
- **Then** An Unable to load alert appears and no network-name field is shown.

## remote-control-guided-setup-110

Original test `A member cannot open an organization cloudflare editor through a URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3429).

- **Given** A member opens a URL for an organization-scoped Cloudflare Access network.
- **When** The edit page attempts to load the network.
- **Then** An Unable to load alert appears and no network-name field is shown.

## remote-control-guided-setup-111

Original test `Cloudflare three-step guide preserves the draft and resumes after returning`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3453).

- **Given** The user is creating a Cloudflare Access network with a draft name and client secret entered.
- **When** They open the three-step credential guide, advance, close it with Escape, reopen it, move backward and forward, and return to the form.
- **Then** The guide shows the documented three steps and Cloudflare dashboard link; the name and secret draft remain intact, the secret can be shown and hidden, and the form still offers Save network after returning.

## remote-control-guided-setup-112

Original test `Tailscale guide uses current form tags and keeps secret inputs mounted through close`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3516).

- **Given** The user is creating a Tailscale network with a draft name, allowed tags, and client secret entered.
- **When** They navigate the credential guide, copy the displayed tags and keys, open tag-help information, close and reopen the guide, and return to the form.
- **Then** The guide reflects the current tags, copies the entered tags and the Write key, and preserves the name and secret draft throughout closing and reopening; the secret remains available in the form and Save network is offered on return.

## remote-control-guided-setup-113

Original test `Private network starts with a provider selector and each guide can be closed without a redundant back action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3575).

- **Given** The private-network directory has no networks.
- **When** The user starts adding a network, opens each provider's guide, closes it with Escape, and returns to the directory without taking an extra Back action from the guide.
- **Then** The directory begins with one Add network action and the add page asks the user to choose a provider. Each provider opens its guide at step 1 with an Enter existing credentials option; choosing that option and saving a Cloudflare network returns to the empty directory with neither the dialog nor form open.

## remote-control-guided-setup-114

Original test `Private network directory only shows the populated group for Tailscale personal networks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3647).

- **Given** A member has one personal Tailscale network and no other networks.
- **When** The private-network directory finishes loading.
- **Then** The Personal networks group shows the network and Add network remains available; the Organization networks group and empty-state message are absent.

## remote-control-guided-setup-115

Original test `Private network directory only shows the populated group for Cloudflare Access organization networks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3647).

- **Given** A member has one organization-scoped Cloudflare Access network and no other networks.
- **When** The private-network directory finishes loading.
- **Then** The Organization networks group shows the network and Add network remains available; the Personal networks group and empty-state message are absent.

## remote-control-guided-setup-116

Original test `Private network directory waits for the Tailscale list before showing the empty state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3683).

- **Given** The Tailscale network list request is still pending and will return no networks.
- **When** The user opens the private-network directory before the request completes, then the request completes.
- **Then** While loading, no Add network action, empty-state message, or network group appears. Once loading completes, the empty state and Add network action appear and the loading message is gone.

## remote-control-guided-setup-117

Original test `Remote control keeps its count while entering the scope refreshes connections`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3705).

- **Given** The Remote control scope shows a connection count of 1 while another scope is selected.
- **When** The user enters Remote control and its refreshed connection summary is still pending, then the refresh completes with count 2.
- **Then** Remote control becomes selected while its displayed count stays at 1 during refresh, then updates to 2.

## remote-control-guided-setup-118

Original test `Private network keeps its count while entering the scope refreshes Tailscale`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3737).

- **Given** The Private network scope shows one Tailscale network while another scope is selected.
- **When** The user enters Private network and its refreshed Tailscale list is pending, then the list returns a second network named Home network.
- **Then** Private network becomes selected and keeps count 1 during refresh; after the second network appears, the count updates to 2.

## remote-control-guided-setup-119

Original test `Private network keeps its count while entering the scope refreshes Cloudflare Access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3737).

- **Given** The Private network scope shows one Cloudflare Access network while another scope is selected.
- **When** The user enters Private network and its refreshed Cloudflare Access list is pending, then the list returns a second network named Home network.
- **Then** Private network becomes selected and keeps count 1 during refresh; after the second network appears, the count updates to 2.

## remote-control-guided-setup-120

Original test `Members see personal and organization networks together, with separate management rights`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3782).

- **Given** A member has a personal network named Office network and an organization network named Team gateway.
- **When** They view the private-network directory.
- **Then** Both personal and organization groups are shown and the count is 2. The personal network has a Manage link; the organization network says it is available to members and managed by administrators, and has a View link to its Cloudflare details without exposing the organization name as separate text.

## remote-control-guided-setup-121

Original test `Network counts display only that network's connection names without navigation links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3829).

- **Given** A member's organization Cloudflare network uses one SSH connection, and their personal Tailscale network uses one VNC connection.
- **When** They open each network's connection-count control.
- **Then** Each dialog lists only that network's connection name, with no navigation links; closing a dialog returns focus to its count control, and closing the personal dialog leaves the Personal networks group visible.

## remote-control-guided-setup-122

Original test `tailscale network details display linked connection names as a read-only list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3909).

- **Given** A Tailscale network has one SSH connection and one VNC connection linked to it.
- **When** The user opens the network details page directly.
- **Then** The page shows both connection names in a read-only list with no links or buttons and no Add connection action.

## remote-control-guided-setup-123

Original test `cloudflare network details display linked connection names as a read-only list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3909).

- **Given** A Cloudflare Access network has one SSH connection and one VNC connection linked to it.
- **When** The user opens the network details page directly.
- **Then** The page shows both connection names in a read-only list with no links or buttons and no Add connection action.

## remote-control-guided-setup-124

Original test `SSH and VNC share one ungrouped connection list regardless of network scope`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3951).

- **Given** A member has one SSH connection using an organization Cloudflare network and one VNC connection.
- **When** They view Remote control.
- **Then** Both connection names appear in one ungrouped list with Manage actions, with no empty-state or Remote connections heading and no Only you have access text; Add connection opens the add-connection page.

## remote-control-guided-setup-125

Original test `The remote directory updates the ssh chat default independently and shares it with details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3995).

- **Given** The SSH chat default is enabled and the VNC chat default is disabled, and both connections are listed.
- **When** The user enables SSH as a chat default and opens that connection's details.
- **Then** The SSH switch changes to enabled, while SSH remains enabled and VNC remains disabled independently; the details page's chat-permissions section also shows SSH enabled.

## remote-control-guided-setup-126

Original test `The remote directory updates the vnc chat default independently and shares it with details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L3995).

- **Given** The SSH chat default is enabled and the VNC chat default is disabled, and both connections are listed.
- **When** The user enables VNC as a chat default and opens that connection's details.
- **Then** The VNC switch changes to enabled, while SSH remains enabled and VNC is enabled independently; the details page's chat-permissions section also shows VNC enabled.

## remote-control-guided-setup-127

Original test `The remote directory keeps its rows and checked values while saving the VNC chat default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4096).

- **Given** SSH and VNC connections are listed, and both chat defaults are enabled.
- **When** The user disables the VNC chat default while the connection list and defaults refresh are pending.
- **Then** Both rows remain visible, SSH stays checked and enabled, and VNC stays checked but temporarily disabled while retaining focus. After refresh, VNC becomes unchecked and enabled, SSH remains checked, and focus remains on VNC.

## remote-control-guided-setup-128

Original test `The remote directory keeps connections visible when chat defaults fail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4192).

- **Given** SSH and VNC connections are listed, but loading chat defaults fails with a server error.
- **When** The Remote control directory loads.
- **Then** Both connections remain visible; the SSH row shows an alert saying Couldn't load remote access. and has no switch, while its Manage link remains available.

## remote-control-guided-setup-129

Original test `The remote directory cannot change a host with unavailable chat defaults`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4216).

- **Given** The SSH chat default is available, but the VNC chat default is missing.
- **When** The Remote control directory loads.
- **Then** SSH is shown enabled; the VNC switch is disabled and its Manage link remains available.

## remote-control-guided-setup-130

Original test `Organization network details show a concise audience without management actions for members`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4249).

- **Given** A member opens details for the organization Cloudflare network Team gateway in Engineering.
- **When** The network details load.
- **Then** The audience is shown as Engineering · Organization members, with no Edit settings, Delete Cloudflare Access, or Add connection action.

## remote-control-guided-setup-131

Original test `Tailscale creation defaults to personal and explains the unavailable organization option for members`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4274).

- **Given** A member starts creating a Tailscale network and chooses to enter existing credentials.
- **When** The credential form opens.
- **Then** Only me is selected by default, the Organization members option is disabled, and the page explains that Engineering members can use the network while organization administrators create and manage organization networks.

## remote-control-guided-setup-132

Original test `Cloudflare Access creation defaults to personal and explains the unavailable organization option for members`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4274).

- **Given** A member starts creating a Cloudflare Access network and chooses to enter existing credentials.
- **When** The credential form opens.
- **Then** Only me is selected by default, the Organization members option is disabled, and the page explains that Engineering members can use the network while organization administrators create and manage organization networks.

## remote-control-guided-setup-133

Original test `Sharing tailscale saves directly with the edited name and preserves connection references`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4306).

- **Given** An administrator edits a personal Tailscale network that has a saved SSH connection reference.
- **When** They change its name to Shared office draft, select Organization members, and save while the sharing operation is pending.
- **Then** Saving proceeds without a confirmation dialog; after sharing completes, details show the edited name and organization scope, and the saved SSH connection reference remains intact.

## remote-control-guided-setup-134

Original test `Sharing cloudflare saves directly with the edited name and preserves connection references`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4306).

- **Given** An administrator edits a personal Cloudflare Access network that has a saved SSH connection reference.
- **When** They change its name to Shared office draft, select Organization members, and save while the sharing operation is pending.
- **Then** Saving proceeds without a confirmation dialog; after sharing completes, details show the edited name and organization scope, and the saved SSH connection reference remains intact.

## remote-control-guided-setup-135

Original test `Restricting Cloudflare requires the current impact acknowledgement and retains saved connections`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4370).

- **Given** An administrator edits an organization Cloudflare Access network with a saved SSH connection and an impact preview listing two other affected connections and Alex as an affected owner.
- **When** They select Only me and try to confirm before acknowledging the impact.
- **Then** A confirmation names the restriction and Alex, and Make personal is disabled until the administrator acknowledges that affected members must select another network before using their saved connections again. After acknowledgement and confirmation, the network becomes personal, its edit action returns, and its saved SSH reference remains intact.

## remote-control-guided-setup-136

Original test `tailscale sharing failure (409) keeps the edit draft and shows an inline error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4451).

- **Given** An administrator edits a personal Tailscale network and the attempt to share it fails with status 409.
- **When** They enter Retained after sharing failure as the name, select Organization members, and save.
- **Then** An inline alert says the network or its linked connections changed and the draft is kept; no dialog appears, the name remains in the form, and Save network is disabled.

## remote-control-guided-setup-137

Original test `cloudflare sharing failure (403) keeps the edit draft and shows an inline error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4451).

- **Given** An administrator edits a personal Cloudflare Access network and the attempt to share it fails with status 403.
- **When** They enter Retained after sharing failure as the name, select Organization members, and save.
- **Then** An inline alert says the network is unavailable or the required administrator permission is no longer present; no dialog appears, the name remains in the form, and Save network is disabled.

## remote-control-guided-setup-138

Original test `tailscale sharing failure (500) keeps the edit draft and shows an inline error`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4451).

- **Given** An administrator edits a personal Tailscale network and the attempt to share it fails with status 500.
- **When** They enter Retained after sharing failure as the name, select Organization members, and save.
- **Then** An inline alert says the change could not be confirmed; no dialog appears, the name remains in the form, and Save network is disabled.

## remote-control-guided-setup-139

Original test `Tailscale saves its explicitly selected organization scope without changing other networks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4490).

- **Given** An administrator has an existing personal Tailscale network and a personal Cloudflare Access network.
- **When** They create a Tailscale network named New team network, explicitly select Organization members, enter credentials, and save.
- **Then** The new network appears under Organization networks while the existing personal network remains unchanged in Personal networks.

## remote-control-guided-setup-140

Original test `Cloudflare Access saves its explicitly selected organization scope without changing other networks`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-control-guided-setup.test.tsx#L4490).

- **Given** An administrator has an existing personal Tailscale network and a personal Cloudflare Access network.
- **When** They create a Cloudflare Access network named New team network, explicitly select Organization members, enter credentials, and save.
- **Then** The new network appears under Organization networks while the existing personal network remains unchanged in Personal networks.
