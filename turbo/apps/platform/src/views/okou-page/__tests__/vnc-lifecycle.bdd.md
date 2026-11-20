# Vnc lifecycle

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [vnc-lifecycle.test.tsx](vnc-lifecycle.test.tsx).

## vnc-lifecycle-001

Original test `A same-session token refresh preserves the password and focus and saves with the current token`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-lifecycle.test.tsx#L93).

- **Given** The user has entered a VNC credential name and password in an open form.
- **When** The session token refreshes without changing the session, and the user saves the credential.
- **Then** The form preserves its name, password, and focus. The save uses the refreshed token, succeeds, closes the form, and clears the old password field.

## vnc-lifecycle-002

Original test `A same-owner session replacement closes the form and cannot revive its password`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-lifecycle.test.tsx#L134).

- **Given** The user has entered a VNC credential name and password in an open form.
- **When** The session is replaced by another session for the same owner, then the original session returns.
- **Then** The form closes and the old password is cleared; returning to the original session does not restore the old draft. A newly opened form starts with a fresh name and password field.

## vnc-lifecycle-003

Original test `Returning to an owner never revives an abandoned uncertain credential draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-lifecycle.test.tsx#L152).

- **Given** Saving a VNC credential fails, leaving an uncertain draft with a disabled Save action.
- **When** The user switches to another owner and then returns to the original owner.
- **Then** The failed form closes, its password is cleared, and returning does not revive the draft or its error. A fresh save succeeds with a different credential ID from the failed attempt.
