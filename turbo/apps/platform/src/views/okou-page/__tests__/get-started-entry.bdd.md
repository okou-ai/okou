# Get started entry

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [get-started-entry.test.tsx](get-started-entry.test.tsx).

## get-started-entry-001

Original test `The gift opens invitations independently of credit quests and copies the invitation link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L56).

- **Given** An admin has no credit quests and the invitation link is still loading.
- **When** They open the invitation dialog from the gift entry, wait for the link, and copy it.
- **Then** The dialog explains the $20 reward, its usage-pack value, and expiration. Copying puts the invitation URL with code a7k2p9 on the clipboard, and Escape closes the dialog and returns focus to the entry.

## get-started-entry-002

Original test `History navigation closes a reopened invitation dialog without restoring stale open state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L112).

- **Given** An admin has no credit quests and is on the chat page.
- **When** They navigate to Workflows, go back, reopen the invitation dialog, then move forward and back again.
- **Then** The final return to chat shows no invitation dialog; the previously open state is not restored.

## get-started-entry-003

Original test `Referral link failures can be retried in the same dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L179).

- **Given** An admin opens the invitation dialog, but loading the invitation link fails with an access error.
- **When** They select Try again after the link service becomes available.
- **Then** The dialog shows a retryable error first, then offers Copy invite link without requiring the dialog to be reopened.

## get-started-entry-004

Original test `The corner's icon buttons lead into the labelled Get started entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L229).

- **Given** An admin sees the gift button and the labelled Get started entry in the corner.
- **When** They inspect the buttons in reading and keyboard order.
- **Then** Both controls are present, with the invitation gift before the Get started entry.

## get-started-entry-005

Original test `An admin sees every step and what each one pays`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L510).

- **Given** An admin has the default set of credit quests.
- **When** They open Get started.
- **Then** The entry reports 3 of 5 steps. The panel shows how rewards work, a +1,000 workflow reward, an invitation step, and a completed Slack step with no Add action. The connector step remains actionable and shows 3/10 progress and its 100-credit reward.

## get-started-entry-006

Original test `A connector reward at its limit shows completion and stops offering more credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L548).

- **Given** An admin's connector quest has reached 10 of 10 claims and cannot earn more.
- **When** They open Get started.
- **Then** The connector row shows 10/10 completion and the connector description, but no Connect action; it is not presented as an actionable menu item.

## get-started-entry-007

Original test `A member is only offered the steps they can finish themselves`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L569).

- **Given** A member is on the chat page.
- **When** They open Get started.
- **Then** The entry reports 2 of 3 steps. The panel offers the workflow step but omits team invitations and Slack, which the member cannot complete themselves.

## get-started-entry-008

Original test `A workflow reward still with the reviewer stops offering the step again`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L587).

- **Given** An admin has a workflow reward pending review.
- **When** They open Get started.
- **Then** The workflow row says In review and offers no Build action; it is not actionable.

## get-started-entry-009

Original test `A review notification brings a granted workflow reward into the open panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L612).

- **Given** An admin has a workflow reward pending review and the Get started panel is open.
- **When** A reward-change notification arrives after the workflow reward is granted.
- **Then** The entry updates from 3 of 5 to 4 of 5, and the workflow row remains visible in the open panel.

## get-started-entry-010

Original test `Adding iMessage opens the phone connect dialog with its reward`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L664).

- **Given** A member has iMessage available and has not completed its quest.
- **When** They open the quest panel and select Add to iMessage.
- **Then** A phone connection dialog opens with the +1,000 reward, camera-and-text instructions, a QR code that opens the SMS containing the connection code, and controls to copy the code, copy the phone number, or close the dialog.

## get-started-entry-011

Original test `Linking the phone closes the Get started dialog and completes the quest`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L703).

- **Given** A member has an iMessage quest open with the phone connection dialog displayed.
- **When** The phone is linked and the app receives phone and reward updates.
- **Then** The dialog closes, “Phone number connected” appears, and the Get started entry updates to 3 of 4 steps.

## get-started-entry-012

Original test `A phone linked before the quest existed reads as done, without credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L753).

- **Given** A member's phone was linked before the iMessage quest existed.
- **When** They open Get started and inspect the iMessage quest.
- **Then** The entry counts 3 of 4 steps, and iMessage appears complete without an Add action or newly earned credits.

## get-started-entry-013

Original test `Slack installed before the quest existed reads as done, without credits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L777).

- **Given** An admin has Slack installed before the Slack quest exists.
- **When** They open Get started and inspect the Slack quest.
- **Then** The entry counts 3 of 5 steps, the remaining rewards total is 1,200, and Slack is complete without an Add action or newly earned credits.

## get-started-entry-014

Original test `Slack not yet installed keeps the step and its reward on offer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L797).

- **Given** An admin has not installed Slack and Slack status is available.
- **When** They open Get started.
- **Then** The entry counts 2 of 5 steps, the remaining rewards total is 3,200, and the Slack step is actionable with a +2,000 reward.

## get-started-entry-015

Original test `A failed Slack status read leaves the Slack step actionable on canonical settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L824).

- **Given** An admin has not claimed the Slack quest, and reading Slack status fails.
- **When** They open the Slack step and select Add to Slack.
- **Then** The Slack step remains actionable with its +2,000 reward. The app opens canonical /settings/slack in a new tab and stays on the chat page.

## get-started-entry-016

Original test `Invitation progress separates successful rewards from pending members and remains actionable below 15`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L859).

- **Given** An admin's invitation quest has 8 successful rewards and 3 pending members, below its limit of 15.
- **When** They open Get started.
- **Then** The invitation progress distinguishes 8 of 15 successful rewards from 3 pending members, and the invitation step remains available.

## get-started-entry-017

Original test `Daily rewards are claimed by selecting check in`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L884).

- **Given** A member has not checked in today.
- **When** They select Check in on the daily quest.
- **Then** A confirmation dialog shows a 1-day streak and +100 credits. After returning to work, the quest no longer offers Check in and is not actionable.

## get-started-entry-018

Original test `The connector step says what it costs the user before it hands them off`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L913).

- **Given** An admin opens the connector quest and the connector catalog is available.
- **When** They inspect the explanation, then choose Browse all connectors.
- **Then** The dialog says to pick a connector to get started, displays Gmail, and leaves the user on chat until they choose to browse. Browsing navigates to /connectors and closes the dialog.

## get-started-entry-019

Original test `The connector picker puts an existing healthy default in its connected group`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L948).

- **Given** An admin has a healthy Gmail connection; Gmail and Notion are available in the connector catalog.
- **When** They open the connector picker from the quest.
- **Then** Gmail appears in the Connected group and Notion in the Not connected group.

## get-started-entry-020

Original test `The open connector picker reflects an account connected in another tab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L970).

- **Given** An admin has an open connector picker where Gmail is initially not connected.
- **When** Gmail is connected in another tab and the account-change event arrives.
- **Then** The already-open picker moves Gmail into its Connected group.

## get-started-entry-021

Original test `The connector picker keeps valid tools when a saved target becomes unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L995).

- **Given** An admin has Gmail connected, Notion available, and the saved-connection lookup reports that the target is unavailable.
- **When** They open the connector picker.
- **Then** Notion remains available, while Gmail is omitted.

## get-started-entry-022

Original test `Picking a connector in the dialog starts its authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1016).

- **Given** An admin opens the connector picker and Gmail is available to connect.
- **When** They select Gmail.
- **Then** Gmail authorization starts without navigating away from chat or opening another connector-details dialog.

## get-started-entry-023

Original test `The Slack step starts OAuth directly at click time and retains the chat draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1072).

- **Given** An admin has not installed Slack, Slack provides an OAuth URL, and the chat composer contains an unsent draft.
- **When** They select Add to Slack in the quest dialog at the fixed test time.
- **Then** The OAuth URL opens in a new tab immediately with the timestamp parameter, the dialog closes, the page stays on chat, and the draft remains in the composer.

## get-started-entry-024

Original test `The Slack step opens settings when the install URL is … at click time and retains the chat draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1072).

- **Given** An admin has not installed Slack, Slack has no install URL, and the chat composer contains an unsent draft.
- **When** They select Add to Slack in the quest dialog at the fixed test time.
- **Then** Canonical /settings/slack opens in a new tab with the timestamp parameter, the dialog closes, the page stays on chat, and the draft remains in the composer.

## get-started-entry-025

Original test `The Slack entry forwards an existing prompt and retains same-origin preview access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1106).

- **Given** An admin is on a same-origin preview chat page with an existing prompt in the URL and a preview-bypass cookie; agent loading is still pending.
- **When** They select Add to Slack while the Slack install URL is unavailable.
- **Then** A same-origin settings tab opens with the prompt and timestamp, but without the bypass token in its URL. The original page retains its cookie and chat location; after agent loading finishes, the prompt appears in the composer.

## get-started-entry-026

Original test `The Slack action retains its OAuth URL while a status refresh is pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1157).

- **Given** An admin has an open Slack quest dialog and a Slack status refresh is pending after a status-change event.
- **When** They select Add to Slack before the refresh completes.
- **Then** The retained OAuth URL opens in a new tab with its state parameter, the app stays on chat, and the dialog closes even while the refresh is pending.

## get-started-entry-027

Original test `A blocked Slack tab without completion leaves the quest retryable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1197).

- **Given** An admin has not claimed the Slack quest, and opening a new tab is blocked.
- **When** They select Add to Slack, then reopen the dialog without completing Slack setup and try again one millisecond later.
- **Then** The dialog closes after the first attempt, but the quest remains at 2 of 5 and Add to Slack stays enabled. A second tab-opening attempt is made with the updated timestamp, and the page stays on chat.

## get-started-entry-028

Original test `A closed Slack tab without completion leaves the quest retryable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1197).

- **Given** An admin has not claimed the Slack quest, and the opened Slack tab is closed without completing setup.
- **When** They select Add to Slack, close the tab, reopen the dialog, and try again one millisecond later.
- **Then** The quest remains at 2 of 5 and Add to Slack stays enabled. A second tab-opening attempt uses the updated timestamp, and the app remains on chat.

## get-started-entry-029

Original test `A open Slack tab without completion leaves the quest retryable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1197).

- **Given** An admin has not claimed the Slack quest, and the opened Slack tab remains open without completing setup.
- **When** They select Add to Slack, reopen the dialog, and try again one millisecond later.
- **Then** The quest remains at 2 of 5 and Add to Slack stays enabled. A second tab-opening attempt uses the updated timestamp, and the app remains on chat.

## get-started-entry-030

Original test `The real Slack event reconciles unchanged from the API without inventing credit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1252).

- **Given** An admin has not installed Slack, has 37 credits, and has no Slack quest reward granted.
- **When** A Slack status-change event arrives while the independent API responses still report no installation, no reward, and a balance of 38 credits.
- **Then** The displayed balance follows the API at 38 credits, the entry remains at 2 of 5 steps, and the app stays on chat; the event alone does not invent a Slack reward.

## get-started-entry-031

Original test `The real Slack event reconciles installed without reward from the API without inventing credit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1252).

- **Given** An admin has not installed Slack, has 37 credits, and has no Slack quest reward granted.
- **When** A Slack status-change event arrives and the API reports Slack installed but no reward, with a balance of 37 credits.
- **Then** The displayed balance remains 37 credits, the entry updates to 3 of 5 steps, and the app stays on chat; installation alone does not create reward credits.

## get-started-entry-032

Original test `The real Slack event reconciles server-reported reward from the API without inventing credit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1252).

- **Given** An admin has not installed Slack, has 37 credits, and has no Slack quest reward granted.
- **When** A Slack status-change event arrives and the API reports a 2,000-credit Slack reward and a balance of 2,037 credits.
- **Then** The displayed balance follows the API at 2,037 credits, the entry updates to 3 of 5 steps, and the app stays on chat; the reward is not invented from the event alone.

## get-started-entry-033

Original test `Reopening Get Started recovers a Slack installation missed by realtime`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1315).

- **Given** An admin has not claimed the Slack quest; Slack is initially reported as not installed, then is installed without a realtime event.
- **When** They close Get started and reopen it after installation.
- **Then** The refreshed panel shows 1,200 rewards remaining, the Slack row is no longer actionable, and the entry updates from 2 of 5 to 3 of 5 steps.

## get-started-entry-034

Original test `The workflow step offers the recommendations rather than one sentence`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1342).

- **Given** An admin opens the workflow quest.
- **When** They inspect its recommendations and choose Browse workflows.
- **Then** The dialog shows the recommendations “Start your day with a clear plan” and “Walk into meetings prepared.” Browse workflows is a link to /workflows; activating it navigates there and closes the dialog.

## get-started-entry-035

Original test `Picking a workflow hands its sentence to the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1378).

- **Given** A member opens the workflow quest and its recommended inbox workflow is available.
- **When** They select that workflow.
- **Then** The app navigates to chat and the composer contains the editable prompt “Help me organize incoming Gmail by urgency.”

## get-started-entry-036

Original test `An ordinary day's check-in confirms the reward and streak in a dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1408).

- **Given** A member has not checked in today and has an eight-day streak.
- **When** They check in from the quest panel.
- **Then** A “Checked in for today” dialog shows a 9-day streak and +100 credits.

## get-started-entry-037

Original test `Check-in waits for refreshed rewards before showing the success dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1427).

- **Given** A member has not checked in today and has an eight-day streak.
- **When** They check in, but the refreshed reward status is still loading.
- **Then** The success dialog stays hidden while rewards refresh, and the check-in control is marked busy. Once refreshed rewards arrive, the dialog shows a 9-day streak and +100 credits.

## get-started-entry-038

Original test `A saved check-in waits for a financial confirmation before celebrating`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1462).

- **Given** A member has not checked in today.
- **When** Their check-in is saved but awaits financial confirmation.
- **Then** They are told the check-in was saved and credits will update after confirmation. No success dialog or “Checked in” status appears, and the quest is marked “In review.”

## get-started-entry-039

Original test `A failed check-in does not show a success dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1497).

- **Given** A member has not checked in today.
- **When** Their check-in request fails with “Check-in unavailable.”
- **Then** The error is shown, no success dialog appears, and the quest still offers “Check in.”

## get-started-entry-040

Original test `Checking in confirms the reward instead of closing silently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1522).

- **Given** An admin has not checked in today.
- **When** They check in from the quest panel.
- **Then** A “Checked in for today” dialog confirms +100 credits and explains that credits pay for runs, artifacts, and scheduled workflows.

## get-started-entry-041

Original test `The quest entry leaves the connector catalog unread until the connector step opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1544).

- **Given** An admin opens the quest panel, while the connector catalog has not been requested.
- **When** They open the connector step and view its picker.
- **Then** The picker lists Gmail from the one-click catalog; that catalog is read only when the step opens, and the full catalog status is never read.

## get-started-entry-042

Original test `A connector that needs a choice opens its connect dialog from its own catalog entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/get-started-entry.test.tsx#L1577).

- **Given** An admin opens the connector step for a connector with two browser authentication methods.
- **When** They select that connector from the picker.
- **Then** A connect dialog named “Choice connector” offers “Workspace OAuth,” and the connector's full catalog entry is read once upon selection.
