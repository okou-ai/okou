# Preferences page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [preferences-page.test.tsx](preferences-page.test.tsx).

## preferences-page-001

Original test `Theme preferences initialize from the cookie and save explicit choices to the workspace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L97).

- **Given** The workspace has no saved appearance preference, and the shared theme cookie specifies dark mode.
- **When** The member opens Theme preferences, selects Light, then selects System.
- **Then** The initial appearance is dark; each explicit choice updates the page and workspace preference and writes the matching shared theme cookie with a one-year lifetime.

## preferences-page-002

Original test `Theme choices and color themes save independently while cookie restoration is preserved`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L134).

- **Given** The workspace appearance is dark with the Golden hour color palette, while the theme cookie specifies Light.
- **When** The member selects Dark, reselects the current appearance, then chooses Deep lagoon as the color palette.
- **Then** Cookie restoration initially selects Light while Golden hour remains selected. Dark updates the appearance preference and cookie; reselecting the current appearance does not change the resolved appearance. Deep lagoon saves independently, leaves the appearance dark, and is not written into the theme cookie.

## preferences-page-003

Original test `A failed theme save keeps the local choice and can be retried`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L194).

- **Given** The theme cookie specifies Light, and saving a change to Dark initially fails.
- **When** The member selects Dark, waits for the save error, then retries after saving becomes available.
- **Then** Dark is immediately selected locally and applied while appearance choices are disabled during the pending save. The error is shown, controls are re-enabled, and retrying saves Dark while retaining the local choice.

## preferences-page-004

Original test `A workspace without a saved color theme starts on the default palette`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L249).

- **Given** A workspace has no saved color palette.
- **When** The member opens Theme preferences, then selects Golden hour.
- **Then** The default palette is selected initially, with no custom palette or gradient applied. No palette is saved until the member chooses one; Golden hour is then the only palette recorded.

## preferences-page-005

Original test `Chat settings select models without changing the current model's options`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L279).

- **Given** Chat settings show GPT 6 Astra as the selected model, with priority service tier, cloud browser off, and Enter as the message-send preference.
- **When** The member opens and closes the model picker, selects GPT 6 Astra, then selects Auto, enables cloud browser, and chooses Command-Enter.
- **Then** The picker supports keyboard focus and Escape returns focus to it. Selecting GPT 6 Astra retains its priority tier; Auto clears the model and tier. Cloud browser becomes on and Command-Enter is saved, without altering the selected model's options when the picker is merely opened or closed.

## preferences-page-006

Original test `A user can save a message-send preference in Chat settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L409).

- **Given** A member has Chat settings open with Enter selected for sending messages.
- **When** They select Command-Enter, then select Command-Enter again.
- **Then** The preference is saved as Command-Enter and remains selected; Enter is not selected.

## preferences-page-007

Original test `Saving a time zone refreshes the recovered Morning Brief preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L435).

- **Given** Morning Brief is unavailable because its preference cannot be loaded until a time zone is saved; the current time zone is UTC.
- **When** The member selects Eastern Time (ET), corresponding to America/New_York.
- **Then** The time zone is saved and remains accessible. Morning Brief refreshes, becomes checked, and its temporary-unavailability message disappears.

## preferences-page-008

Original test `A failed preference save shows its error and can be retried`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L485).

- **Given** Chat settings have Enter selected, and saving a change to Command-Enter initially fails.
- **When** The member selects Command-Enter, waits for the save error, then retries after saving becomes available.
- **Then** The pending choice is disabled; the error appears and Enter is restored as the selected choice. After retry, Command-Enter is selected and enabled.

## preferences-page-009

Original test `A shared theme cookie supersedes and removes an older host-only duplicate`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/preferences-page.test.tsx#L536).

- **Given** The browser has a shared dark theme cookie and an older host-only Light duplicate.
- **When** The member opens Theme preferences on a vm0.ai host.
- **Then** The shared dark preference takes precedence and the page displays Light. The host-only duplicate is removed, and Light is written as the shared vm0.ai cookie.
