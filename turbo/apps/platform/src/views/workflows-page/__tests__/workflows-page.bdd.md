# Workflows page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [workflows-page.test.tsx](workflows-page.test.tsx).

## workflows-page-001

Original test `Return to Workflows with a toast when the automations detail no longer exists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1528).

- **Given** A user opens the automations tab for a workflow that no longer exists.
- **When** The detail request cannot find the workflow.
- **Then** The page shows “Workflow not found.” and returns to Workflows, where Ops Playbook is listed.

## workflows-page-002

Original test `Return to Workflows with a toast when the instructions detail no longer exists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1528).

- **Given** A user opens the instructions tab for a workflow that no longer exists.
- **When** The detail request cannot find the workflow.
- **Then** The page shows “Workflow not found.” and returns to Workflows, where Ops Playbook is listed.

## workflows-page-003

Original test `Return to Workflows with a toast when the info detail no longer exists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1528).

- **Given** A user opens the info tab for a workflow that no longer exists.
- **When** The detail request cannot find the workflow.
- **Then** The page shows “Workflow not found.” and returns to Workflows, where Ops Playbook is listed.

## workflows-page-004

Original test `Return to Workflows with a toast when a legacy detail link is inaccessible`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1545).

- **Given** A user follows a legacy workflow detail link, and access is denied.
- **When** The detail request returns 403 Forbidden.
- **Then** The page shows “Workflow not found.” and returns to Workflows, where Ops Playbook is listed.

## workflows-page-005

Original test `Preserve workflow detail request failures instead of treating them as missing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1564).

- **Given** A user opens the automations tab for a workflow and the service is unavailable.
- **When** The detail request returns a 500 error with “Workflow service unavailable.”
- **Then** The request failure is surfaced rather than treated as a missing workflow, and the user remains on the automations URL.

## workflows-page-006

Original test `Redirect a cold Morning Brief detail to its preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1581).

- **Given** A user opens the detail page for an enabled Morning Brief preference.
- **When** The Morning Brief preference is available.
- **Then** The user is redirected to Agents with the preference settings focused, sees the Morning Brief preference, and does not see Instructions.

## workflows-page-007

Original test `Redirect an Official Workflow without a user-facing page to Workflows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1605).

- **Given** A user opens the detail page for an Official Workflow that has no user-facing page.
- **When** The workflow detail loads.
- **Then** The user is redirected to Workflows, where Ops Playbook is listed.

## workflows-page-008

Original test `Keep Official Workflows out of the Workflows list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1616).

- **Given** The Workflows list contains Official Workflows and an ordinary workflow.
- **When** A user opens the Workflows list.
- **Then** Ops Playbook is listed, while Sales Research and Morning Brief are not listed.

## workflows-page-009

Original test `Filter workflows by automation and visibility`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1646).

- **Given** The Workflows list contains automated Sales Research, manual Ops Playbook and Launch Checklist, and public Support Intake owned by another agent.
- **When** The user selects Automated, Manual, Private, Public, and All in turn, including choosing filters with the keyboard.
- **Then** All initially lists all four workflows and Sales Research shows a Schedule pill. Automated lists only Sales Research; Manual lists Ops Playbook and Launch Checklist; Private lists those same two; Public lists Sales Research and Support Intake. Filters are mutually exclusive, selecting Public again keeps it selected, and All clears filtering.

## workflows-page-010

Original test `Start creating a workflow in an agent chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1753).

- **Given** A user is on the Workflows list with Research Bot and Support Bot available.
- **When** The user chooses Create in chat and selects Research Bot.
- **Then** A Create workflow dialog offers both agents, and the user is taken to Research Bot's chat with composer text containing “desired outcome” and “automation.”

## workflows-page-011

Original test `Filter workflows by agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1784).

- **Given** The Workflows list contains workflows belonging to Research Bot and Support Bot.
- **When** The user filters by Support Bot and then clears the agent filter.
- **Then** The Support Bot view contains Support Intake but not Sales Research or Ops Playbook. Clearing the filter restores all three workflows.

## workflows-page-012

Original test `Open and manage a deep-linked automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1821).

- **Given** A user opens the automations page with a deep link to the Gmail new-message automation, alongside a weekday schedule.
- **When** The user opens the linked automation and disables it.
- **Then** The Gmail automation is highlighted and brought into view, while the weekday schedule is not highlighted. The Gmail switch changes to Enable Gmail new message, and the weekday schedule remains enabled.

## workflows-page-013

Original test `Block workflow publishing without permission on the owning agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1860).

- **Given** A user can manage a workflow but cannot publish it because they do not own its agent.
- **When** The user tries to make the workflow public.
- **Then** Publishing remains disabled, the workflow stays private, and the page explains that publishing under an agent the user does not own requires organization administrator permissions.
- **Upstream change** `4e5707de` (#49556) drops the agent-ownership explanation and always shows the workspace publication permission message; the upstream test is now `Block workflow publishing without permission on the owning agent` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1708)). Rebuild this scenario with a manageable workflow the user cannot publish, expecting the disabled Make workflow public switch to stay off and “You don’t have permission to publish workflows in this workspace.”

## workflows-page-014

Original test `Refine a workflow in its agent chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1889).

- **Given** A user views the instructions for Sales Research.
- **When** The user chooses Refine with Research Bot.
- **Then** The user is taken to the workflow's chat with Research Bot, and the composer contains “help me refine the workflow /sales-research.”
- **Upstream change** `4e5707de` (#49556) names the refine action after Okou instead of the owning agent and opens the workflow's My Okou Chat; the upstream test is now `Refine a workflow in a My Okou Chat` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1737)). Rebuild this scenario by choosing Refine with Okou and expecting the workflow chat at `/chats/<threadId>` with the same composer text.

## workflows-page-015

Original test `Confirm before making a public workflow private`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1915).

- **Given** A user can manage the public Sales Research workflow.
- **When** The user turns off its public setting, cancels the confirmation, then reopens the confirmation and chooses Make private.
- **Then** The first attempt shows a confirmation and makes no request when canceled. Confirming afterward sends the demotion request for Sales Research.

## workflows-page-016

Original test `Copy a workflow to another agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1964).

- **Given** A user views Sales Research, which has an automation, and can copy it to Support Bot.
- **When** The user copies the workflow without choosing to remove the original, then chooses View on the success notice.
- **Then** A private copy is created for Support Bot. The original workflow and its automation are untouched, the user remains on the source page until choosing View, and View opens the copy's automations page.
- **Upstream change** `4e5707de` (#49556) removes copying a workflow to another agent (the Copy workflow dialog, its Copy to picker and the View notice) and removes this upstream test. Retire this scenario; Make private copy into the caller's workspace remains covered by workflows-page-073 and workflows-page-074.

## workflows-page-017

Original test `Move a workflow to another agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2033).

- **Given** A user views Sales Research, which has one automation, and chooses Support Bot as the destination for a move.
- **When** The user selects the option to remove the original and confirms Copy and remove.
- **Then** The automation is paused, the original workflow is deleted, and the user is taken to the private copy's automations page with a “Moved to Support Bot” notice.
- **Upstream change** `4e5707de` (#49556) removes moving a workflow to another agent (Copy and remove, which paused automations and deleted the original) and removes this upstream test. Retire this scenario; Make private copy, which has no removal step, remains covered by workflows-page-073 and workflows-page-074.

## workflows-page-018

Original test `Keep the source and committed copy available when move fails during pause`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2119).

- **Given** A user is moving Sales Research to Support Bot, and the copy has been committed.
- **When** Pausing the original workflow's automation fails with a conflict.
- **Then** The source page and move dialog remain available, the error is shown, and no moved notice appears. After canceling and returning to Workflows, both Sales Research and the committed Copied Sales Research remain listed.

## workflows-page-019

Original test `Keep the source and committed copy available when move fails during delete`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2119).

- **Given** A user is moving Sales Research to Support Bot, and the copy has been committed and its automation paused.
- **When** Deleting the original workflow fails with a conflict.
- **Then** The source page and move dialog remain available, the error is shown, and no moved notice appears. After canceling and returning to Workflows, both Sales Research and the committed Copied Sales Research remain listed.

## workflows-page-020

Original test `Delete a workflow only navigates after success and keeps the dialog available on failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2170).

- **Given** A user opens the delete confirmation for Sales Research, and deletion initially fails because the workflow is still in use.
- **When** The user attempts deletion, then retries after the failure is cleared.
- **Then** On failure, the error is shown and the dialog remains open on the detail page. After a successful retry, the user returns to Workflows, Sales Research is absent, and the dialog is closed.

## workflows-page-021

Original test `Edit workflow metadata`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2206).

- **Given** A user opens metadata for Sales Research.
- **When** The user changes its display name to Account Brief, slug to account-brief, and description, then saves.
- **Then** The form presents the existing values and guidance for slug format and workflow usage, indicates unsaved changes, and submits the updated name, slug, and description.
- **Upstream change** `4e5707de` (#49556) removes the read-only Agent row from workflow metadata and changes the description guidance to “Tell Okou when to use this workflow.”; the upstream test is now `Edit workflow metadata` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L1848)). Rebuild this scenario expecting that guidance; the submitted name, slug and description are unchanged.

## workflows-page-022

Original test `Navigate between workflow detail tabs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2249).

- **Given** A user opens the automations tab for Sales Research.
- **When** The user navigates to Settings and then Instructions.
- **Then** The detail page navigates first to the info tab and then to the instructions tab, showing the workflow instruction on the latter.

## workflows-page-023

Original test `Summarize Gmail automation match conditions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2275).

- **Given** A user opens Sales Research automations with a Gmail new-message automation matching sender and subject conditions, alongside a schedule.
- **When** The automation details are displayed.
- **Then** The Gmail summary shows sender contains “@acme.com” and subject does not contain “newsletter.” Only the schedule shows a Next run statistic.

## workflows-page-024

Original test `Recover when a stale Run now action receives the automatic-only policy rejection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2295).

- **Given** A user sees a Run now action for a workflow automation that is rejected by the automatic-only policy.
- **When** The user selects Run now and the service returns a conflict explaining that Official Workflows can only run through automatic triggers.
- **Then** The rejection message is shown, Run now remains enabled, and the user stays on the automations page.

## workflows-page-025

Original test `Run a workflow automation now and promote it in the next composer overview`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2311).

- **Given** A user can run the weekday schedule automation for Sales Research, and the composer overview contains Sales Research and alpha.
- **When** The user selects Run now and enters “Draft /” in the resulting chat composer.
- **Then** The weekday automation runs and opens its chat. The slash workflow menu orders Sales Research before alpha.

## workflows-page-026

Original test `Create a Gmail new-message automation with match rules`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2366).

- **Given** A user is adding a Gmail new-message automation to Sales Research.
- **When** The user sets From contains to “@acme.com” and adds a Subject does not contain “newsletter” condition, then submits.
- **Then** The creation request contains both Gmail match rules: sender contains “@acme.com” and subject does not contain “newsletter.”

## workflows-page-027

Original test `Correct an unavailable Gmail label and create the automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2426).

- **Given** A user is adding a Gmail label-applied automation and enters the unavailable label “Missing.”
- **When** The user submits, corrects the label to “Support,” and submits again.
- **Then** The first attempt shows an inline label-not-found explanation, marks the input invalid without clearing its value, and keeps the action enabled. The corrected label creates the automation and appears as Label “Support”; the first expected label-not-found error is not logged to the console.

## workflows-page-028

Original test `Keep Gmail creation errors observable for 400/BAD_REQUEST`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2494).

- **Given** A user is adding a Gmail label-applied automation and enters “Support”; creation fails with HTTP 400 BAD_REQUEST and “Failed to read Gmail labels.”
- **When** The user submits the form.
- **Then** The failure message is shown and logged as an unexpected API error with status 400 and code BAD_REQUEST. The label remains in the input, no inline alert is shown, and the submit action remains enabled.

## workflows-page-029

Original test `Keep Gmail creation errors observable for 403/GMAIL_LABEL_NOT_FOUND`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2494).

- **Given** A user is adding a Gmail label-applied automation and enters “Support”; creation fails with HTTP 403 GMAIL_LABEL_NOT_FOUND and “Failed to read Gmail labels.”
- **When** The user submits the form.
- **Then** The failure message is shown and logged as an unexpected API error with status 403 and code GMAIL_LABEL_NOT_FOUND. The label remains in the input, no inline alert is shown, and the submit action remains enabled.

## workflows-page-030

Original test `Create a filtered GitHub workflow-run automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2540).

- **Given** A user has GitHub available and is adding a GitHub workflow-run automation.
- **When** The user sets repository to okou-ai/okou, workflows to Turbo and .github/workflows/turbo.yml, branch to main, event to push, actor to lancy, and selects failure and startup failure outcomes, then submits.
- **Then** The creation request includes all entered filters, with conclusions failure and startup_failure.

## workflows-page-031

Original test `Offer GitHub App installation when GitHub is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2594).

- **Given** GitHub is unavailable while a user adds a GitHub workflow-run automation.
- **When** The user opens the GitHub workflow automation form.
- **Then** The form offers an Install GitHub App link to the available installation URL.

## workflows-page-032

Original test `Ask an administrator to install GitHub when self-service is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2620).

- **Given** GitHub is unavailable and no self-service installation URL is available while a user adds a GitHub workflow-run automation.
- **When** The user opens the GitHub workflow automation form.
- **Then** The form asks the user to have an organization administrator install GitHub and offers no installation link.

## workflows-page-033

Original test `Create a filtered GitHub issue-comment automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2658).

- **Given** A user has GitHub available and is adding a GitHub issue-comment automation.
- **When** The user selects the okou-ai/okou repository, Pull requests only, trusted authors e7h4n and lancy, and comment prefixes /verify and /deploy, then submits.
- **Then** The creation request contains the repository, pull-request subject, trusted authors, and comment prefixes as filters.

## workflows-page-034

Original test `Create a Google Calendar event-updated automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2711).

- **Given** A user is adding a Google Calendar event-updated automation.
- **When** The user sets the Calendar ID to team@example.com and submits.
- **Then** The creation request is for an event-updated automation using calendar team@example.com.

## workflows-page-035

Original test `Recover a missing Calendar for an event-created automation without changing its event contract`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2773).

- **Given** An enabled Google Calendar event-created automation refers to a missing calendar, and its delivery is paused pending action.
- **When** The user chooses Change calendar, replaces missing-created@example.com with replacement@example.com, and submits.
- **Then** The page identifies the unavailable calendar and offers a way to choose another. The automation remains enabled and its row is not dimmed while action is required. Saving updates only the calendar ID, preserves the event-created contract, and clears the alert and form.

## workflows-page-036

Original test `Show a Calendar warning without recovery mutations for another user's automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2850).

- **Given** A Calendar automation owned by another user is enabled but requires reconnection, and the current user cannot manage it.
- **When** The user opens the workflow's automations.
- **Then** An alert says delivery is paused and action is required. Its switch remains checked and disabled, and neither a calendar-change nor reconnect action is offered.

## workflows-page-037

Original test `Open a Calendar action-required workflow at the exact automation from the workflow list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L2881).

- **Given** The workflow list contains a Calendar automation with a missing-calendar warning.
- **When** The user opens its action-required link from the workflow list.
- **Then** The workflow's automations page opens with that exact automation selected and centered, and its alert says delivery is paused and action is required.

## workflows-page-038

Original test `Reconnect the selected Calendar account and reload the warning state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3066).

- **Given** The selected Calendar account has a reconnection warning and its reconnect dialog is open.
- **When** The user completes reconnection and the automation warning state is reloaded.
- **Then** The dialog and alert disappear, and the automation remains enabled.

## workflows-page-039

Original test `Create a Google Forms automation and surface its warning`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3086).

- **Given** The user is adding an automation to a workflow.
- **When** The user creates a Google Forms response-submitted automation using the supplied form link.
- **Then** The creation request contains the Google Forms event and form URL, and the returned warning that the form is not accepting responses appears.

## workflows-page-040

Original test `Create a Google Meet transcript-ready automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3128).

- **Given** The user is adding an automation to a workflow.
- **When** The user creates a Google Meet transcript-ready automation.
- **Then** The creation request identifies transcript generation scoped to the organizer's account.

## workflows-page-041

Original test `Create a Notion database-item automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3165).

- **Given** The user is adding an automation to a workflow.
- **When** The user creates a Notion database-item automation using a database URL.
- **Then** The creation request identifies a new database item and includes the supplied database URL.

## workflows-page-042

Original test `Offer a Team upgrade to a Pro workspace administrator`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3207).

- **Given** A Pro workspace administrator is adding an automation.
- **When** The administrator selects Webhook in the integrations picker.
- **Then** Webhook is marked as requiring Team, and an upgrade offer explains the Team requirement and provides an Upgrade to Team action.

## workflows-page-043

Original test `Allow webhook creation when the plan grants the capability`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3293).

- **Given** A Pro workspace administrator has a plan that allows webhook automations.
- **When** The administrator creates a webhook automation.
- **Then** The picker does not mark Webhook as requiring Team or show the upgrade offer. The creation flow provides the webhook URL and supports its field interactions before closing when Done is selected.

## workflows-page-044

Original test `Handle a plan restriction discovered while creating a webhook`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3333).

- **Given** A Pro workspace administrator's plan initially allows webhook creation.
- **When** The server rejects the creation request because Team is required.
- **Then** The upgrade offer appears and the Create webhook action becomes disabled.

## workflows-page-045

Original test `Direct a non-admin to request webhook access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3368).

- **Given** A non-admin workspace member on Pro opens the webhook automation option.
- **When** The member views the webhook access restriction.
- **Then** The app asks the member to have a workspace admin upgrade, and does not offer Upgrade to Team.

## workflows-page-046

Original test `Explain a plan restriction when enabling an existing webhook`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3387).

- **Given** A Pro workspace has a disabled webhook marked as requiring a paid plan, alongside an unrelated enabled schedule.
- **When** The administrator tries to enable the webhook and the server reports Team is required.
- **Then** The webhook remains disabled with a paid-plan explanation and its switch is disabled, while the unrelated schedule switch is not disabled and an upgrade offer appears.

## workflows-page-047

Original test `Reveal an existing webhook secret on demand`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3432).

- **Given** An existing webhook's URL is hidden.
- **When** The user opens its secret dialog, reveals the secret, closes the dialog, and opens it again.
- **Then** The URL is absent before reveal and appears after reveal. On reopening, it is hidden again and can be revealed; the test also verifies webhook field interactions and clipboard writes.

## workflows-page-048

Original test `Create a daily schedule in the user's preferred time zone`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3476).

- **Given** The user's preferred time zone is Asia/Shanghai.
- **When** The user creates a daily scheduled automation using the default time selection.
- **Then** The form identifies the displayed time zone as Asia/Shanghai, and the creation request uses a daily cron schedule at 01:00 with UTC as its schedule time zone.

## workflows-page-049

Original test `Create an interval automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3514).

- **Given** The user is adding a schedule automation.
- **When** The user selects an interval of 30 minutes and creates it.
- **Then** The request defines a repeating interval of 1,800 seconds.

## workflows-page-050

Original test `Create a one-time automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3548).

- **Given** The user is adding a schedule automation.
- **When** The user sets a one-time run for 2026-07-01 at 10:30 and creates it.
- **Then** The request contains that run time as an ISO timestamp and uses UTC as the time zone.

## workflows-page-051

Original test `A completed automation update preserves a reopened editor draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3585).

- **Given** A schedule automation repeats every hour, and its update is pending.
- **When** The user closes the editor, reopens it, selects 30 minutes, and the earlier update completes with a saved interval of five hours.
- **Then** The displayed saved summary becomes every five hours, while the reopened editor remains open with the user's 30-minute draft.

## workflows-page-052

Original test `Edit a schedule in the user's preferred time zone`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3636).

- **Given** The user's preferred time zone is Asia/Shanghai, and a weekday schedule displays 9:00 AM from its saved UTC schedule.
- **When** The user edits the hour to 16 and minute to 45, then saves.
- **Then** The update request retains the weekday schedule and uses cron expression 45 8 * * 1-5 in UTC.

## workflows-page-053

Original test `Edit an interval automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3689).

- **Given** A repeating schedule has a one-hour interval.
- **When** The user changes the interval to 30 minutes and saves.
- **Then** The update request sets the interval to 1,800 seconds for that automation.

## workflows-page-054

Original test `Keep a custom interval when saving without opening its selector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3739).

- **Given** A repeating schedule has a custom interval of 2,220 seconds, displayed as every 37 minutes.
- **When** The user saves without opening the interval selector.
- **Then** The update preserves the custom 2,220-second interval.

## workflows-page-055

Original test `Edit Gmail new-message match rules`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3781).

- **Given** A Gmail new-message automation matches senders containing any of @vip.example and excludes subjects containing newsletter; it also has thread ID gmail-thread-1.
- **When** The user adds a sender-contains condition for @acme.com, adds a body-contains condition for invoice, changes the sender list to include @priority.example, changes the thread ID to gmail-thread-2, and saves.
- **Then** The saved update preserves the subject exclusion and both sender-list entries, and includes the sender condition, body condition, and new thread ID.

## workflows-page-056

Original test `Correct an unavailable Gmail label while preserving the saved automation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3877).

- **Given** A saved Gmail label automation uses the label Support.
- **When** The user tries to save the unavailable label Missing, then corrects it to Escalated and saves again.
- **Then** The first attempt shows a label-not-found alert, marks the input invalid, and leaves the saved Support label unchanged without showing the raw service error. The second attempt updates the displayed label to Escalated and closes the editor.

## workflows-page-057

Original test `Warn when a workflow slash command resolves to another workflow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3944).

- **Given** A workflow's slash-command name currently resolves to a different, private workflow named Private Sales Research.
- **When** The user opens the workflow instructions.
- **Then** A warning explains that the command currently resolves elsewhere and identifies Private Sales Research.

## workflows-page-058

Original test `Select workflow files with accessible current state using Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3963).

- **Given** The instructions page has config/settings.json selected, with its content visible.
- **When** The user opens the file picker and uses Enter to select the instructions item.
- **Then** The instructions become visible and the file query is cleared. The picker closes with focus returned; selecting examples/prompt.md updates the content and query, and Escape closes the picker without changing that selection.

## workflows-page-059

Original test `Select workflow files with accessible current state using Space`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L3963).

- **Given** The instructions page has config/settings.json selected, with its content visible.
- **When** The user opens the file picker and uses Space to select the instructions item.
- **Then** The instructions become visible and the file query is cleared. The picker closes with focus returned; selecting examples/prompt.md updates the content and query, and Escape closes the picker without changing that selection.

## workflows-page-060

Original test `Reach workflow file actions with arrows and typeahead, then delete with Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4036).

- **Given** A workflow has examples/prompt.md and config/settings.json, with its instructions displayed.
- **When** The user navigates the file actions by arrow keys and typeahead, then presses Enter on Delete selected file.
- **Then** The save request retains examples/prompt.md and removes config/settings.json; the file picker indicates the instructions selection.

## workflows-page-061

Original test `Keep the selected workflow file and its content when upload fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4078).

- **Given** The workflow file config/settings.json is selected and its content is displayed.
- **When** The user uploads notes.md but saving workflow files fails.
- **Then** The failure message appears, while config/settings.json remains selected with its original content and query; the upload action remains available.

## workflows-page-062

Original test `Keep the selected workflow file and its content when delete fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4078).

- **Given** The workflow file config/settings.json is selected and its content is displayed.
- **When** The user deletes the selected file but saving workflow files fails.
- **Then** The failure message appears, while config/settings.json remains selected with its original content and query; the upload action remains available.

## workflows-page-063

Original test `Upload after the file menu closes and reselect the same file after an empty selection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4122).

- **Given** The workflow file menu is open and the workflow has existing files.
- **When** The user closes the menu, uploads notes.md, makes an empty file selection, then selects instructions and uploads notes.md again.
- **Then** The upload retains config/settings.json alongside notes.md. The empty selection does not change the selected file, and the subsequent upload keeps notes.md selected.

## workflows-page-064

Original test `Replace an uploaded workflow file by path without dropping its siblings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4176).

- **Given** A workflow has examples/prompt.md and config/settings.json.
- **When** The user uploads a file with relative path examples/prompt.md and updated content.
- **Then** The uploaded content replaces that path's content without removing its sibling config/settings.json; the file query selects examples/prompt.md and the picker contains only one entry for that path.

## workflows-page-065

Original test `Load workflow authors only after a title tooltip opens and reuse on reopen`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4207).

- **Given** The workflow list is shown and author details have not been requested.
- **When** The user opens a workflow title tooltip, waits for author details, closes it, and opens it again.
- **Then** Author details load only after the tooltip opens, including the author name and image. Reopening the tooltip reuses the loaded data without another request.

## workflows-page-066

Original test `Discard cached author data on account change and abort the old account's pending request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4258).

- **Given** A workflow author request is pending for the current account while its tooltip is open.
- **When** The user changes accounts, the old request is aborted, and the tooltip is opened again after the old response resolves.
- **Then** The new account's author appears and the previous account's author does not.

## workflows-page-067

Original test `Clear the author cache when the active organization changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4313).

- **Given** The workflow tooltip shows an author cached for the active organization.
- **When** The user changes the active organization and reopens the tooltip.
- **Then** The old organization author's data is cleared and the new organization's author is shown.

## workflows-page-068

Original test `Browse workspace workflows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4355).

- **Given** The workspace contains the Sales Research workflow.
- **When** The user opens the workflow list and hovers over its title.
- **Then** The Workflows heading and Sales Research appear, and the hover reveals the TU text.
- **Upstream change** `4e5707de` (#49556) always requests the Workflows list for the workspace default executor and shows only its workflows, without the agent filter or Runs as details; this scenario has no upstream test in the parent commit, because its upstream test was already removed in #48898. Rebuild this scenario with Sales Research owned by the workspace default executor.

## workflows-page-069

Original test `Open a workflow from the workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4376).

- **Given** The Sales Research workflow exists in the workspace.
- **When** The user opens its automations page directly.
- **Then** The page remains at that workflow's automations URL and displays Sales Research.

## workflows-page-070

Original test `A completed automation creation preserves a reopened creation draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4391).

- **Given** The user starts creating an interval automation and its creation is pending.
- **When** The user closes that editor, opens a scheduled-time creation form, selects hour 16, and the earlier creation completes with a five-hour interval.
- **Then** The saved five-hour automation appears while the reopened creation form remains open with the user's hour-16 draft.

## workflows-page-071

Original test `An earlier webhook response preserves a reopened creation form`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4442).

- **Given** A webhook creation request is still pending after the user closes its form. The user reopens the webhook creation form.
- **When** The earlier request returns successfully.
- **Then** The reopened form remains available and its Create webhook button is enabled.

## workflows-page-072

Original test `Workspace Workflows ignore stale Agent filters and identify the caller's private override`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4481).

- **Given** The workspace has a shared Sales Research workflow shadowed by the caller's private copy, plus a workflow for another agent. The workspace is opened with a stale filter for the other agent while the single-agent feature is enabled.
- **When** The workflow list loads.
- **Then** Both the shared and private Sales Research entries appear, and the shared entry is identified as overridden for the caller and links to the shared definition. The page also shows that /sales-research is used, despite the stale agent filter.
- **Batch 75 main synchronization** [Member-flow change #49854](https://github.com/okou-ai/okou/pull/49854). A workflow has no executor-agent association. The member still sees both the shared workflow and its private override, but the fixture can no longer assign the other workflow to the agent in the stale filter.

## workflows-page-073

Original test `Make private copy opens the existing private definition without overwriting it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4521).

- **Given** A shared Sales Research workflow has an existing private copy with retained private instructions. The shared definition's metadata points to that private copy.
- **When** The user opens Make private copy and follows the existing private-copy link.
- **Then** The link opens the existing private workflow's instructions, where the retained private instructions are visible. The private definition is not overwritten.

## workflows-page-074

Original test `Make private copy uses the workspace default without a destination or removal step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4580).

- **Given** A manageable shared Sales Research workflow is available in a single-agent workspace with a default Okou.
- **When** The user chooses Make private copy and confirms without selecting a destination or performing a removal step.
- **Then** The copy uses the workspace default and opens its instructions, showing the copied workspace instructions.

## workflows-page-075

Original test `creates a workspace Workflow with the default Okou without choosing an Agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/workflows-page/__tests__/workflows-page.test.tsx#L4625).

- **Given** A workspace has a default Okou, and the workflow list is open with the single-agent feature enabled.
- **When** The user chooses Create in chat and confirms Create workflow without choosing an agent.
- **Then** The app navigates to the chat home page.
- **Batch 75 main synchronization** [Member-flow change #49854](https://github.com/okou-ai/okou/pull/49854). Create in chat still opens the member composer. The default-agent record required by the original Given is no longer supplied or stored.
