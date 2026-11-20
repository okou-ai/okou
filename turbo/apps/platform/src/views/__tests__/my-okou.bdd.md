# My okou

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [my-okou.test.tsx](my-okou.test.tsx).

## my-okou-001

Original test `An ordinary enabled member edits personal Instructions and deliberately clears them`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L49).

- **Given** An ordinary enabled workspace member has saved personal Instructions reading “Use concise updates.”
- **When** They clear the Instructions and save the empty content.
- **Then** The update uses the original saved version; the page confirms the save, shows an empty editor with no unsaved draft, and retains the personal-instructions guidance and My Okou settings.

## my-okou-002

Original test `Discard restores the saved document and save failure retains the retryable local draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L77).

- **Given** A member's saved Instructions are “Use concise updates.”
- **When** They discard an unsaved edit, then attempt to save “Kept after failure” while the service fails, and retry after the service recovers.
- **Then** Discard restores the saved text. The failed save keeps the local draft and offers retry; the retry succeeds and clears the unsaved indicator.

## my-okou-003

Original test `A concurrent CLI save cannot be overwritten without explicit reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L120).

- **Given** A member has a local Instructions draft while a newer version has been saved through the CLI.
- **When** They try to save using the old version, then choose to reload the saved instructions.
- **Then** The save is rejected as a conflict, the local draft remains, and saving is disabled until reload replaces it with the newer CLI instructions.

## my-okou-004

Original test `An undone edit cannot hide later CLI instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L148).

- **Given** A member edits personal Instructions, then undoes the edit back to the saved text.
- **When** A newer CLI-saved version is announced while the member remains on the page.
- **Then** The editor updates to the CLI instructions and has no unsaved-draft indicator.

## my-okou-005

Original test `A newer saved version keeps the local draft and offers reload before saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L171).

- **Given** A member has an unsaved local Instructions draft when a newer saved version is announced.
- **When** They choose to reload the saved instructions.
- **Then** The local draft remains and saving is disabled until reload; reload replaces it with the newer saved instructions and clears the unsaved indicator.

## my-okou-006

Original test `Returning to the tab catches instruction updates missed while away`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L193).

- **Given** A member has personal Instructions open and switches away from the tab while the saved instructions change.
- **When** They return to the tab.
- **Then** The editor updates to the instructions saved while they were away.

## my-okou-007

Original test `Settings navigation and dismissal retain the draft and its original version`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L218).

- **Given** A member has an unsaved Instructions draft with its original saved version.
- **When** They navigate to Chat, return to My Okou, dismiss Settings, and reopen the personal settings.
- **Then** The draft remains visible throughout and the unsaved indicator is present after reopening.

## my-okou-008

Original test `Fetch failure offers retry without fabricating shared Instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L241).

- **Given** A member opens personal Instructions but the fetch fails.
- **When** They retry after the service becomes available and returns “Personal retry.”
- **Then** The page first offers retry without fabricating shared Instructions, then displays “Personal retry” in the editor.

## my-okou-009

Original test `A disabled member retains Agents navigation and the legacy management page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L264).

- **Given** A member opens the Agents page while SingleAgent is disabled.
- **When** The page loads.
- **Then** The Agents heading and Agents navigation link remain available.

## my-okou-010

Original test `Workspace switching isolates drafts and restores the original workspace draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L278).

- **Given** A member has an unsaved “Alpha local draft” in the Alpha workspace's personal Instructions.
- **When** They switch to Beta, create a Beta draft, then switch back to Alpha and reopen personal settings.
- **Then** Beta initially shows its own saved instructions, and returning to Alpha restores “Alpha local draft” rather than Beta's draft.

## my-okou-011

Original test `Default configuration profile opens personal Instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L325).

- **Given** A user opens an agent configuration with the tab set to profile while SingleAgent is enabled.
- **When** The page loads.
- **Then** The URL redirects to the personal My Okou settings page and personal Instructions are available.

## my-okou-012

Original test `Default configuration instructions opens personal Instructions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L325).

- **Given** A user opens an agent configuration with the tab set to instructions while SingleAgent is enabled.
- **When** The page loads.
- **Then** The URL redirects to the personal My Okou settings page and personal Instructions are available.

## my-okou-013

Original test `The default authorization link still opens account and permission controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L344).

- **Given** A user opens an agent configuration with the tab set to authorization while SingleAgent is enabled.
- **When** The page loads.
- **Then** The URL redirects to /connectors and the Connectors heading appears.

## my-okou-014

Original test `My Okou settings are unavailable when SingleAgent is disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/__tests__/my-okou.test.tsx#L356).

- **Given** A user opens My Okou settings while SingleAgent is disabled.
- **When** The settings page loads.
- **Then** Settings show the Preference section, redirect the settings selection to preference, and omit the My Okou control and Instructions editor.
