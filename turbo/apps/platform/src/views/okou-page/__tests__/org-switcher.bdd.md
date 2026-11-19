# Org switcher

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [org-switcher.test.tsx](org-switcher.test.tsx).

## org-switcher-001

Original test `Join an invited workspace from the workspace switcher`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher.test.tsx#L45).

- **Given** The user is in workspace Acme, also belongs to Design Org, and has a pending invitation to Invited Org.
- **When** They open the workspace switcher and choose Join for the invitation.
- **Then** The invitation is shown with its logo and displays “Joining…” while acceptance is pending. Once accepted, Invited Org and the pending-invitation badge disappear while Design Org remains; choosing Design Org closes the menu.

## org-switcher-002

Original test `Show the brand default for workspaces that never uploaded a logo`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher.test.tsx#L152).

- **Given** The current workspace, another member workspace, and an invited workspace have never had logos uploaded, although each has a generated placeholder image URL.
- **When** The user opens the workspace switcher.
- **Then** All three workspaces appear without an image source, including the current workspace switcher button.

## org-switcher-003

Original test `Creating a workspace opens onboarding after activating its organization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher.test.tsx#L228).

- **Given** The user can create up to one workspace and has created none; their current workspace was created by someone else.
- **When** They choose Create workspace from the switcher.
- **Then** A workspace with a generated workspace-prefixed name and slug is created, activated, and the app navigates to onboarding.

## org-switcher-004

Original test `Hide workspace creation after the user reaches the limit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/org-switcher.test.tsx#L301).

- **Given** The user can create one workspace and has already created one; they belong to a shared workspace and another workspace.
- **When** They open the workspace switcher.
- **Then** Create workspace is not shown.
