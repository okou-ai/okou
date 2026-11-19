# For you custom targets in 8ee03b20

Compared `9e40c6e3` with [8ee03b20 (#49274)](https://github.com/okou-ai/okou/pull/49274).
Each card now names its custom-direction target through
`customOption.threadId`. The related-chat chooser and its Back control are
gone. The product change is integrated, and the rebuilt
`agent-suggestions.test.tsx` stays on this branch.

- `upstream-a678cec8-agent-suggestions-1244-01` follows its renamed
  registration (L1256), “A custom direction continues the chat its card
  names without touching its saved draft”. Its Given and When are amended
  and verified.
- `upstream-a678cec8-agent-suggestions-1312-01` (not selected) is removed
  upstream and retires with the chooser.

Three new registrations await per-file selection and runtime verification.
They do not change the frozen baseline.

## upstream-8ee03b20-agent-suggestions-1311-01

- **Given** A card names an existing chat that the chat list has not loaded yet.
- **When** The member writes a direction in the card and sends.
- **Then** The direction goes to the named chat rather than to a new chat.

## upstream-8ee03b20-agent-suggestions-1364-01

- **Given** A card names no custom target while one of its actions continues an existing chat.
- **When** The member writes a direction in the card and sends.
- **Then** The direction starts a new chat.

## upstream-8ee03b20-agent-suggestions-1401-01

- **Given** A card names a chat that no longer exists.
- **When** The member writes a direction in the card and sends.
- **Then** The direction starts a new chat instead.
