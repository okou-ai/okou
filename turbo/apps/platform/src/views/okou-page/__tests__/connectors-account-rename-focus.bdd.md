# Connectors account rename focus

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-account-rename-focus.test.tsx](connectors-account-rename-focus.test.tsx).

## connectors-account-rename-focus-001

Original test `Keep input navigation focus after keyboard account rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L188).

- **Given** A user opens the GitHub account manager, starts renaming Work 1 with the keyboard, and changes the name to Work 1x.
- **When** They use Tab and Shift+Tab to move around the rename input and its Cancel action.
- **Then** Focus follows the expected navigation: it returns to the input, remains within the manager when navigating backward, and returns to the input when navigating forward.

## connectors-account-rename-focus-002

Original test `Keep input navigation focus after pointer account rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L188).

- **Given** A user opens the GitHub account manager, starts renaming Work 1 with pointer interaction, and changes the name to Work 1x.
- **When** They use Tab and Shift+Tab to move around the rename input and its Cancel action.
- **Then** Focus follows the expected navigation: it returns to the input, remains within the manager when navigating backward, and returns to the input when navigating forward.

## connectors-account-rename-focus-003

Original test `Keep cancel focus after keyboard account rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L202).

- **Given** A user starts renaming Work 1 with the keyboard and reaches the Cancel action.
- **When** They press Enter to cancel the rename.
- **Then** Focus returns to Work 1’s account actions, the manager remains open, and no rename is submitted.

## connectors-account-rename-focus-004

Original test `Keep cancel focus after pointer account rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L202).

- **Given** A user starts renaming Work 1 with pointer interaction and reaches the Cancel action.
- **When** They press Enter to cancel the rename.
- **Then** Focus returns to Work 1’s account actions, the manager remains open, and no rename is submitted.

## connectors-account-rename-focus-005

Original test `Keep account menu focus after keyboard account rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L215).

- **Given** A user starts renaming Work 1 with the keyboard and reaches the Cancel action.
- **When** They cancel, reopen Work 1’s account menu, and dismiss the menu with Escape.
- **Then** Focus returns to Work 1’s account actions, the menu closes, and the manager remains open; no rename is submitted.

## connectors-account-rename-focus-006

Original test `Keep account menu focus after pointer account rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L215).

- **Given** A user starts renaming Work 1 with pointer interaction and reaches the Cancel action.
- **When** They cancel, reopen Work 1’s account menu, and dismiss the menu with Escape.
- **Then** Focus returns to Work 1’s account actions, the menu closes, and the manager remains open; no rename is submitted.

## connectors-account-rename-focus-007

Original test `Keep dismiss manager focus after keyboard account rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L235).

- **Given** A user starts renaming Work 1 with the keyboard and reaches the Cancel action.
- **When** They cancel, open and dismiss the account menu, then tab out of the manager and press Escape.
- **Then** The manager closes and focus returns to Manage GitHub accounts; no rename is submitted.

## connectors-account-rename-focus-008

Original test `Keep dismiss manager focus after pointer account rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L235).

- **Given** A user starts renaming Work 1 with pointer interaction and reaches the Cancel action.
- **When** They cancel, open and dismiss the account menu, then tab out of the manager and press Escape.
- **Then** The manager closes and focus returns to Manage GitHub accounts; no rename is submitted.

## connectors-account-rename-focus-009

Original test `Restore the renamed account actions only after the refreshed list arrives`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L263).

- **Given** A user renames Work 1 to Research while the rename request and refreshed account list are delayed.
- **When** The rename request completes before the refreshed list arrives.
- **Then** Save remains disabled and focus stays in the name input; Research is not yet available as an account action. After the refreshed list arrives, focus moves to Research’s account actions and its menu can be opened.

## connectors-account-rename-focus-010

Original test `Focus account search when the saved name no longer matches its results`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L299).

- **Given** A user searches for Work 1 among seven accounts and renames it to Research, which no longer matches the search.
- **When** The rename is saved.
- **Then** The results become empty and focus moves to account search, not the removed rename input. Searching for Research shows the renamed account, and focus remains in the search field while navigating within the manager.

## connectors-account-rename-focus-011

Original test `Keep focus outside a manager closed during a delayed rename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L345).

- **Given** A user saves a GitHub account rename while its response is delayed.
- **When** They close the manager, move focus elsewhere, and the rename response arrives.
- **Then** Focus stays outside the closed manager, which remains closed. Reopening it shows the renamed account and no active rename input.

## connectors-account-rename-focus-012

Original test `A search changed during save determines focus without a later stale handoff`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L382).

- **Given** A user saves a rename while the refreshed account list is delayed, then changes the search to “No matching account.”
- **When** The refreshed list arrives while the search has no matches.
- **Then** Focus remains in search rather than moving to stale rename controls. Replacing the search with Research shows the renamed account, and focus stays in search.

## connectors-account-rename-focus-013

Original test `An old rename response cannot clear or steal focus from a newly opened edit`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L416).

- **Given** A user saves a rename with a delayed response, closes the manager, reopens it, and starts editing Work 2 as “Work 2 new.”
- **When** The older rename response arrives while the new edit is active.
- **Then** The new input retains focus and its draft; the user can extend and save it as “Work 2 new draft,” after which focus is on that account’s actions.

## connectors-account-rename-focus-014

Original test `Finish a saved rename after an intermediate account search is superseded`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-account-rename-focus.test.tsx#L461).

- **Given** A user saves a rename to Research while the refreshed account list is delayed, then starts a search for “No.”
- **When** The refreshed list arrives and the user changes the search to “No matching account,” then to Research.
- **Then** Save is disabled, the empty results do not restore stale rename controls, and focus remains in search. Searching Research shows the renamed account, and the search field retains focus.
