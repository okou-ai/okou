# Permission editor

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [permission-editor.test.tsx](permission-editor.test.tsx).

## permission-editor-001

Original test `Apply reflects effective permission-policy changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L328).

- **Given** An agent has a Slack permission explicitly denied while the permission editor is open.
- **When** The user changes that permission to Allow.
- **Then** The permission shows Allow and Apply becomes enabled; before the change, Apply was disabled.

## permission-editor-002

Original test `A denied permission does not keep the group's expiration`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L350).

- **Given** All three Slack read permissions have seven-day allow grants, while the default policy denies permissions.
- **When** The user changes bookmarks:read to Deny and applies.
- **Then** The denied permission has no allow-duration control, while channels:list retains its seven-day duration. The update succeeds and applies only a deny grant for bookmarks:read.

## permission-editor-003

Original test `An individual permission duration overrides its group`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L386).

- **Given** All three Slack read permissions have seven-day allow grants, while the default policy denies permissions.
- **When** The user changes bookmarks:read to Allow always and applies.
- **Then** Only bookmarks:read changes to Always; channels:list retains seven days. The update succeeds and applies an always-allow grant only for bookmarks:read.

## permission-editor-004

Original test `Undoing a deny does not create an unnecessary always grant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L424).

- **Given** With the default allow policy and no explicit grants, a Slack permission is initially allowed and Apply is disabled.
- **When** The user changes it to Deny and then back to Allow.
- **Then** It remains allowed with an Always duration, Apply is disabled again, and no grant is submitted.

## permission-editor-005

Original test `Activating an already allowed bulk policy also allows other endpoints only on Apply`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L445).

- **Given** The three listed Slack permissions are already allowed, unknown endpoints default to Ask, and no changes are pending.
- **When** The user selects Allow for the bulk listed-permissions control, then applies.
- **Then** The listed permissions remain allowed and unknown endpoints become allowed only as a pending change until Apply. The update succeeds with only an allow grant for unknown endpoints.

## permission-editor-006

Original test `Ask and mixed permissions remain distinct while group commands keep their scope`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/permission-editor.test.tsx#L478).

- **Given** Slack read permissions and unknown endpoints default to Ask.
- **When** The user allows one read permission, allows the Read group, selects a seven-day group duration, then denies the group and applies.
- **Then** The individual choice first makes the group mixed; allowing the group clears that state. Denying the group denies all three read permissions and removes their allow-duration controls, while unknown endpoints remain Ask. The update succeeds with deny grants for exactly the three read permissions.
