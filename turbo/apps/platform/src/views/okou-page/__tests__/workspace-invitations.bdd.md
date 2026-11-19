# Workspace invitations

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [workspace-invitations.test.tsx](workspace-invitations.test.tsx).

## workspace-invitations-001

Original test `An invitation accepted for another account offers account switching`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/workspace-invitations.test.tsx#L66).

- **Given** The user is signed in to the current workspace and visits a completed invitation for a different workspace, with the invitation destination anchored at private agents.
- **When** They choose “Switch account.”
- **Then** The accepted-for-another-account notice is shown, the private-agents anchor remains, and Clerk’s sign-in flow opens with the simple appearance and both redirect destinations set to `/`.

## workspace-invitations-002

Original test `An incomplete invitation stays available to the hosted Clerk UI`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/workspace-invitations.test.tsx#L111).

- **Given** The user is signed out and opens an incomplete workspace invitation on the hosted app sign-in page.
- **When** The sign-in page loads with the invitation ticket and workspace-invite campaign parameter.
- **Then** The hosted Clerk sign-in UI is shown, and the sign-in status, invitation ticket, and campaign parameter remain in the URL. The app does not create a Clerk sign-in attempt.
