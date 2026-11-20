# Org members tab

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [org-members-tab.test.tsx](org-members-tab.test.tsx).

## org-members-tab-001

Original test `Show a scheduled package change on a pending invitation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L371).

- **Given** An administrator views People with usage packages enabled, and Eve has a $100 monthly package scheduled to downgrade to $50 on September 1, 2026.
- **When** The administrator opens People.
- **Then** Eve’s row shows $100/month and “Downgrades to $50 on Sep 1, 2026.” Alice’s row shows no scheduled downgrade.

## org-members-tab-002

Original test `Configure a member’s package from People`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L413).

- **Given** An administrator views People on an active Pro plan with package management available.
- **When** The administrator opens the member package configuration for themselves and then closes it.
- **Then** The configuration shows step 2 of 3 and 20,400 credits with a 2% discount for the member. Closing it removes the configuration and displays Billing.

## org-members-tab-003

Original test `Configure an Atom plan before purchasing any packages`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L452).

- **Given** An administrator has an Atom grant without a paid subscription or existing usage-package subscription; the member package catalog is available.
- **When** The administrator opens member package configuration and chooses Manage on the Pro plan.
- **Then** The People list shows members with no package, and configuration offers the plan choice before showing member usage.

## org-members-tab-004

Original test `Hide People package controls when showUsagePack is false, even with a subscription`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L485).

- **Given** An administrator has a subscription and usage-package data, but the plan does not show usage packages.
- **When** The administrator views People and opens a member’s actions.
- **Then** People shows no Usage pack heading or Configure member packages action.

## org-members-tab-005

Original test `Keep People package controls restricted to administrators`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L501).

- **Given** A non-administrator views People while package management is otherwise available.
- **When** The member opens the People settings.
- **Then** The settings show Preference, not usage-package information or member action controls.

## org-members-tab-006

Original test `Invite members on active limited-free-1 plans`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L519).

- **Given** An administrator has an active limited-free-1 plan.
- **When** The administrator invites legacy.invitee@example.com without package controls.
- **Then** The invitation succeeds and the invitee appears in People; the invitation dialog and People list show no member package controls.

## org-members-tab-007

Original test `Invite members on active pro plans`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L519).

- **Given** An administrator has an active Pro plan.
- **When** The administrator invites legacy.invitee@example.com without package controls.
- **Then** The invitation succeeds and the invitee appears in People; the invitation dialog and People list show no member package controls.

## org-members-tab-008

Original test `shows an invitation refusal (409 INVITEE_ALREADY_MEMBER) and reports unexpected failures`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L580).

- **Given** An administrator on an active limited-free-1 plan starts an invitation for someone who is already a member, and the invitation service responds with 409 INVITEE_ALREADY_MEMBER.
- **When** The administrator submits the invitation.
- **Then** The message “This person is already a member.” appears; the dialog stays open with the entered email and an enabled send button. No Sentry exception is reported.

## org-members-tab-009

Original test `shows an invitation refusal (409 INVITATION_ALREADY_EXISTS) and reports unexpected failures`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L580).

- **Given** An administrator on an active limited-free-1 plan starts an invitation whose email already has a pending invitation, and the service responds with 409 INVITATION_ALREADY_EXISTS.
- **When** The administrator submits the invitation.
- **Then** The message “This person already has a pending invitation.” appears; the dialog stays open with the entered email and an enabled send button. One exception report includes the service error and status.

## org-members-tab-010

Original test `shows an invitation refusal (500 INTERNAL_SERVER_ERROR) and reports unexpected failures`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L580).

- **Given** An administrator on an active limited-free-1 plan starts an invitation, and the invitation service responds with 500 INTERNAL_SERVER_ERROR.
- **When** The administrator submits the invitation.
- **Then** The message “The invitation service is unavailable.” appears; the dialog stays open with the entered email and an enabled send button. One exception report includes the service error and status.

## org-members-tab-011

Original test `Invite a member after selecting No package on pro (subscription: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L630).

- **Given** An administrator has an active Pro subscription with package options and an empty package allocation list.
- **When** The administrator selects a $50 package for free.invitee@example.com, then selects No package and sends the invitation.
- **Then** The invitation succeeds without opening a Review invitation dialog.

## org-members-tab-012

Original test `Invite a member after selecting No package on team (subscription: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L630).

- **Given** An administrator has an active Team plan without a subscription or existing package subscription, with package options available.
- **When** The administrator selects a $50 package for free.invitee@example.com, then selects No package and sends the invitation.
- **Then** The invitation succeeds without opening a Review invitation dialog.

## org-members-tab-013

Original test `Configure packages from an Atom invitation before paying`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L696).

- **Given** An administrator has an active Pro plan with an Atom grant, but no paid or existing usage-package subscription.
- **When** The administrator selects a $50 package for a new invitee and chooses to configure packages.
- **Then** The plan-choice heading appears before any payment.

## org-members-tab-014

Original test `Use the default $20 package when inviting a member`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L731).

- **Given** An administrator has an active Pro subscription and package catalog, and the invite form defaults to a $20 package.
- **When** The administrator continues the invitation for default-package@example.com.
- **Then** The purchase preview is for the default $20 package and the review shows $5.00 and 5,100 credits.

## org-members-tab-015

Original test `Review and purchase a paid invitation on pro`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L869).

- **Given** An administrator is reviewing a paid invitation on a Pro plan for paid.invitee@example.com, with a $50 monthly package.
- **When** The administrator pays and sends the invitation.
- **Then** The review shows $12.50 and the invitee’s email; the invitee appears in People with a $50/month package.

## org-members-tab-016

Original test `Review and purchase a paid invitation on team`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L869).

- **Given** An administrator is reviewing a paid invitation on a Team plan for paid.invitee@example.com, with a $50 monthly package.
- **When** The administrator pays and sends the invitation.
- **Then** The review shows $12.50 and the invitee’s email; the invitee appears in People with a $50/month package.

## org-members-tab-017

Original test `Block invitations on suspended plans`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L887).

- **Given** An administrator has a suspended Pro plan.
- **When** The administrator tries to add a member and chooses View plans.
- **Then** The invitation dialog explains that the workspace plan must be reactivated and has no email or role fields. View plans opens the plan chooser and closes the reactivation dialog.

## org-members-tab-018

Original test `Accept and reject workspace membership requests`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L927).

- **Given** The People list contains membership requests from Carol and Dan.
- **When** The administrator accepts Carol’s request, then rejects Dan’s request.
- **Then** Carol appears as a member and one request remains after acceptance. Rejection displays “Membership request rejected” and removes Dan’s name and email from the list.

## org-members-tab-019

Original test `Promote a workspace member to administrator`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L958).

- **Given** An administrator views the People list, where Bob is a member.
- **When** The administrator makes Bob an admin and reopens his actions.
- **Then** Bob’s role changes to Admin with a success message, and his actions offer Make member.

## org-members-tab-020

Original test `Keep focus in People after dismissing actions for bob@example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L978).

- **Given** An administrator has the People settings open and Bob’s actions available.
- **When** The administrator opens Bob’s actions and presses Escape.
- **Then** The menu closes, focus returns to Bob’s actions, and People remains open.

## org-members-tab-021

Original test `Keep focus in People after dismissing actions for alice@example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L978).

- **Given** An administrator has the People settings open and Alice’s actions available.
- **When** The administrator opens Alice’s actions and presses Escape.
- **Then** The menu closes, focus returns to Alice’s actions, and People remains open.

## org-members-tab-022

Original test `Keep focus in People after dismissing actions for pending@example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L978).

- **Given** An administrator has the People settings open and a pending invitation for pending@example.com.
- **When** The administrator opens that invitation’s actions and presses Escape.
- **Then** The menu closes, focus returns to the invitation’s actions, and People remains open.

## org-members-tab-023

Original test `Return to People actions for bob@example.com after cancelling confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L1003).

- **Given** An administrator has the People settings open and Bob’s actions available.
- **When** The administrator chooses Remove from workspace and cancels the confirmation.
- **Then** The confirmation closes, focus returns to Bob’s actions, and People remains open.

## org-members-tab-024

Original test `Return to People actions for alice@example.com after cancelling confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L1003).

- **Given** An administrator has the People settings open and Alice’s actions available.
- **When** The administrator chooses Switch to member and cancels the confirmation.
- **Then** The confirmation closes, focus returns to Alice’s actions, and People remains open.

## org-members-tab-025

Original test `Return to People actions for pending@example.com after cancelling confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L1003).

- **Given** An administrator has the People settings open and a pending invitation for pending@example.com.
- **When** The administrator chooses Revoke invitation and cancels the confirmation.
- **Then** The confirmation closes, focus returns to the invitation’s actions, and People remains open.

## org-members-tab-026

Original test `Remove another member from the workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L1030).

- **Given** An administrator views the People list, where Bob is a workspace member.
- **When** The administrator chooses to remove Bob and confirms removal.
- **Then** The confirmation explains that Bob will lose access to resources and identifies his email. After removal, a success message appears and Bob is absent from the list.

## org-members-tab-027

Original test `Demote yourself from workspace administrator`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L1055).

- **Given** Alice is an administrator viewing the People list.
- **When** Alice chooses Switch to member and confirms the change.
- **Then** The confirmation warns that she will lose administrator privileges. Her role changes to Member with a success message, and her administrator action control disappears.

## org-members-tab-028

Original test `Explain package and credit effects before removing a member`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L1083).

- **Given** An administrator views People with usage packages enabled; Bob has a package and credits.
- **When** The administrator opens the confirmation to remove Bob.
- **Then** The confirmation explains that credits become unavailable immediately, the package is removed at the end of the current billing period, unused purchased-credit portions are returned, and used credits and bonus credits are not refundable. Bob remains listed while confirmation is open.

## org-members-tab-029

Original test `Revoke a pending workspace invitation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-members-tab.test.tsx#L1124).

- **Given** An administrator views People with a pending invitation for pending@example.com.
- **When** The administrator searches for the invitation, chooses Revoke invitation, and confirms.
- **Then** The confirmation explains that the invitee can no longer join using the invitation. The invitation disappears and “Invitation revoked” appears.
