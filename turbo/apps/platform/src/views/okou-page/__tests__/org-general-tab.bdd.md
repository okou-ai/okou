# Org general tab

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [org-general-tab.test.tsx](org-general-tab.test.tsx).

## org-general-tab-001

Original test `Finish loading when the workspace has no logo`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L57).

- **Given** The workspace has no logo and its logo request is still pending.
- **When** The user opens General settings and the request completes with no logo.
- **Then** The loading indicator disappears without an error, and uploading a logo is enabled.

## org-general-tab-002

Original test `Show the brand default instead of the provider placeholder when the workspace has no logo`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L83).

- **Given** The workspace has no uploaded logo, but the provider returns a generated placeholder image URL.
- **When** The user opens General settings.
- **Then** The workspace uses its brand default rather than displaying the provider placeholder, and logo upload is enabled.

## org-general-tab-003

Original test `Reopening settings shows the current logo after an older read completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L101).

- **Given** An initial logo read is pending when the user closes Settings; a later read returns the current logo.
- **When** They reopen General settings, then the older read completes with a stale logo.
- **Then** The current logo remains displayed and no logo-load error appears.

## org-general-tab-004

Original test `Show a saved upload while the initial logo load is pending and refresh on reopening`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L147).

- **Given** The initial logo read is pending for a workspace with no saved logo.
- **When** The user uploads and saves a valid logo, the initial read then completes, and they close and reopen General settings after the published logo changes.
- **Then** The saved upload is shown when the old read completes, without a loading indicator. On reopening, the latest published logo is shown.

## org-general-tab-005

Original test `Edit, save, and discard workspace profile details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L211).

- **Given** The workspace profile has the name Old Name and an existing logo.
- **When** The user edits the name to New Name, discards the edit, then edits it again and saves.
- **Then** Discard restores Old Name without sending an update. Saving the second edit updates the name to New Name and shows a workspace-updated confirmation.

## org-general-tab-006

Original test `Show a workspace profile update failure without losing the edit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L262).

- **Given** The workspace profile name is Old Name.
- **When** The user changes it to New Name and the update fails with a server error.
- **Then** The error message is shown, New Name remains in the field, and Save changes remains available; no success confirmation appears.

## org-general-tab-007

Original test `Upload and save a valid workspace logo`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L290).

- **Given** The workspace already has a logo.
- **When** The user uploads a valid PNG logo and saves the change.
- **Then** The new logo is displayed and a workspace-updated confirmation appears.

## org-general-tab-008

Original test `Reject invalid workspace logo files`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L356).

- **Given** The workspace already has a saved logo.
- **When** The user uploads an unreadable image, an 80-by-80 image, and a 5000-by-5000 image in turn.
- **Then** Each file is rejected with the corresponding unreadable, too-small, or too-large message. No save action appears, and the existing logo remains displayed.

## org-general-tab-009

Original test `Explain the billing effects before deleting a workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L431).

- **Given** The user opens the workspace deletion dialog.
- **When** They review the deletion information.
- **Then** The dialog explains that active subscriptions, usage packs, and add-ons will be cancelled immediately; unused prepaid subscription time will be refunded proportionally; and one-time and other non-subscription purchases will not be refunded.

## org-general-tab-010

Original test `Require fresh workspace confirmation after cancelling`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L457).

- **Given** The user enters the exact confirmation text in the workspace deletion dialog, then cancels.
- **When** They open the deletion dialog again.
- **Then** The confirmation field is empty and deletion is disabled; cancelling also cleared the prior confirmation before the dialog closed.

## org-general-tab-011

Original test `Enable workspace deletion only for the exact confirmation and keep the success flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-general-tab.test.tsx#L482).

- **Given** The user opens the workspace deletion dialog, where deletion is initially disabled.
- **When** They enter the exact lowercase text "confirm", change it to "Confirm" or add a trailing space, restore the exact text, and delete the workspace.
- **Then** Deletion is enabled only for the exact text "confirm". On success, a workspace-deleted confirmation appears and the app navigates to the organization chooser sign-in route.
