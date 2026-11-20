# Remote access forward

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [remote-access-forward.test.tsx](remote-access-forward.test.tsx).

## remote-access-forward-001

Original test `A forward to an existing chat keeps its own remote permissions and pending save across resize`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-access-forward.test.tsx#L101).

- **Given** The user is forwarding selected text to an existing chat whose SSH host is enabled by a chat-specific override; the source chat uses the host's default-off setting. Saving a change in the target chat is pending.
- **When** The user changes the target chat's SSH host to Off and the page resizes before the save completes, then waits for the save and closes the dialogs.
- **Then** The resized Remote access dialog retains the pending change and makes the control read-only while saving. When the save completes, it shows Off and confirms the save. Closing Remote access restores focus to the Connectors control; closing the forward dialog and reopening Remote access in the source chat shows Default (Off).
