# Integrations hub status

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [integrations-hub-status.test.tsx](integrations-hub-status.test.tsx).

## integrations-hub-status-001

Original test `Integrations show current status and refresh after GitHub connects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L33).

- **Given** The user is on Integrations. Slack is connected to Okou HQ with a permission mismatch, Phone is linked to +15555551212, Discord can connect, and GitHub is not connected.
- **When** The user starts GitHub authorization, then GitHub reports a connection for octocat.
- **Then** The page shows Slack as connected to Okou HQ with an update-permissions option, displays the linked Phone number, offers Discord and GitHub connection, and does not show Feishu. GitHub authorization opens in a new tab, and the card then updates to Connected (@octocat).

## integrations-hub-status-002

Original test `Slack keeps account disconnect in its overflow menu (admin: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L109).

- **Given** Slack is connected to Okou HQ, and the user is an admin.
- **When** The user opens Slack’s overflow menu and disconnects the account.
- **Then** Disconnect is absent from the card before opening the menu. The menu offers Uninstall to the admin; after disconnecting, the card offers Connect, no longer shows Connected (Okou HQ), and the user remains on /works.

## integrations-hub-status-003

Original test `Slack keeps account disconnect in its overflow menu (admin: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L109).

- **Given** Slack is connected to Okou HQ, and the user is not an admin.
- **When** The user opens Slack’s overflow menu and disconnects the account.
- **Then** Disconnect is absent from the card before opening the menu. The menu does not offer Uninstall to the non-admin; after disconnecting, the card offers Connect, no longer shows Connected (Okou HQ), and the user remains on /works.

## integrations-hub-status-004

Original test `A workspace member is directed to an admin for GitHub installation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L145).

- **Given** A workspace member is on Integrations, and the GitHub installation lookup returns not found with no installation URL.
- **When** The member views the GitHub integration.
- **Then** The card says to ask an organization admin to install the GitHub App. It offers neither an Install GitHub App link nor a Connect button.

## integrations-hub-status-005

Original test `Authorize the official Telegram bot directly in a new tab from Integrations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L171).

- **Given** The official Telegram bot is available but not connected, with login bot ID 987654321 and a configured domain.
- **When** The user starts Telegram authorization and completes the authorization bridge with Alice’s Telegram identity.
- **Then** Authorization opens in a new tab at Telegram’s authorization page with the official bot ID. The card updates to Connected (@alice), removes Connect, and the user remains on /works.

## integrations-hub-status-006

Original test `The phone card describes messaging and the connect dialog displays the destination number`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L274).

- **Given** The Phone integration is not linked and its destination number is +13144386568.
- **When** The user opens the phone connection dialog and copies the destination number.
- **Then** The Phone card describes text-message access to Okou without displaying the formatted number. The dialog titled “Text Okou from your iPhone” shows +1 (314) 438-6568, and copying it reports “Phone number copied” and writes +13144386568 to the clipboard.

## integrations-hub-status-007

Original test `A user connects AgentPhone with a prefilled one-time code`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L310).

- **Given** AgentPhone is configured but not linked, with destination number +19039853128, and the connection code is 74290618.
- **When** The user opens the phone connection dialog, copies the code and destination number, and AgentPhone reports that the phone has linked.
- **Then** The dialog instructs the user to scan and send the prefilled code, advises using iMessage when possible because SMS and MMS replies may not arrive reliably, and shows the code, destination number, and 10-minute expiration. Its Messages link and QR data use sms:+19039853128?body=74290618. It offers code and number copying but no +1,000 reward; copying reports the corresponding success messages and writes the code and number to the clipboard. After linking, the Phone card shows +15555550123 and the dialog closes.

## integrations-hub-status-008

Original test `An admin can begin Microsoft Teams installation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L394).

- **Given** An admin is viewing Microsoft Teams before the bot is installed, and the page says a Microsoft account must be connected to finish setup.
- **When** The admin starts installation in Teams.
- **Then** A new tab opens the Teams OAuth connection endpoint with orgId=org_1 and userId=user_1.

## integrations-hub-status-009

Original test `Microsoft Teams offers Connect after installation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L420).

- **Given** Microsoft Teams is installed but not connected.
- **When** The user views the Microsoft Teams integration.
- **Then** The card offers Connect and does not offer Install in Teams.

## integrations-hub-status-010

Original test `Microsoft Teams shows its connected account name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L433).

- **Given** Microsoft Teams is connected, with a linked account named Avery.
- **When** The user views the integrations page.
- **Then** Microsoft Teams is shown as Connected (Avery), and an Install GitHub App link is present.

## integrations-hub-status-011

Original test `Uninstalling Microsoft Teams requires confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L460).

- **Given** Microsoft Teams is installed but not connected.
- **When** The user selects Uninstall Microsoft Teams from the integration’s options.
- **Then** A confirmation dialog titled “Uninstall Microsoft Teams integration?” appears.

## integrations-hub-status-012

Original test `Slack starts OAuth directly and refreshes the original Works page (installed: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L479).

- **Given** Slack is not installed or connected, and its install and connect URLs are distinct.
- **When** The user selects Install to Slack, then Slack reports a connection to Verified workspace.
- **Then** The new tab opens the install URL, not the connect URL. The user remains on /works, and the card updates to Connected (Verified workspace) after Slack changes.

## integrations-hub-status-013

Original test `Slack starts OAuth directly and refreshes the original Works page (installed: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L479).

- **Given** Slack is installed but not connected, and its install and connect URLs are distinct.
- **When** The user selects Connect, then Slack reports a connection to Verified workspace.
- **Then** The new tab opens the connect URL, not the install URL. The user remains on /works, and the card updates to Connected (Verified workspace) after Slack changes.

## integrations-hub-status-014

Original test `Slack permission refresh reports actual scope recovery on the original Works page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/integrations-hub-status.test.tsx#L516).

- **Given** Slack is connected to Verified workspace but has a permission mismatch.
- **When** The user selects Update Permissions, then Slack reports that the mismatch is resolved.
- **Then** A new tab opens the reinstall URL. The page reports “Permissions updated,” removes Update Permissions, and remains on /works.
