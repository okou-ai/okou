# Settings tab

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [settings-tab.test.tsx](settings-tab.test.tsx).

## settings-tab-001

Original test `Keep rendering the highest legacy avatar preset`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L140).

- **Given** An agent profile uses the highest legacy preset avatar.
- **When** The user opens the profile page.
- **Then** The avatar renders the corresponding legacy head, face, and hair layers.

## settings-tab-002

Original test `Keep rendering a legacy custom SVG avatar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L153).

- **Given** An agent profile uses the legacy custom avatar svg:r3s2h4c1f5h.
- **When** The user opens the profile page.
- **Then** The avatar renders its corresponding legacy head, face, and hair layers.

## settings-tab-003

Original test `Cancel avatar composition without converting legacy avatar svg:r3s2h4c1f5h`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L181).

- **Given** An agent profile uses the legacy custom avatar svg:r3s2h4c1f5h.
- **When** The user opens avatar editing and cancels composition, then saves a changed profile name.
- **Then** The legacy avatar remains unchanged and is not saved as part of canceling composition. Saving the name preserves the legacy avatar URL.

## settings-tab-004

Original test `Confirm conversion of legacy avatar svg:r3s2h4c1f5h to a composed avatar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L206).

- **Given** An agent profile uses the legacy custom avatar svg:r3s2h4c1f5h.
- **When** The user opens avatar editing, randomizes the composed avatar, and confirms it.
- **Then** The avatar editor closes, the profile saves a composed avatar URL, and the profile displays the same six composed layers chosen in the editor.

## settings-tab-005

Original test `Offer avatar creation instead of editing when the agent has no avatar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L239).

- **Given** An agent profile has no avatar.
- **When** The user opens the profile and chooses to create a custom avatar.
- **Then** The profile offers avatar creation rather than avatar editing, and opens the “Give your agent a face” dialog.

## settings-tab-006

Original test `Load the neck and sweater layers with the avatar head`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L258).

- **Given** An agent profile has no avatar.
- **When** The user opens custom avatar creation.
- **Then** The dialog loads 42 avatar image layers, comprising 26 distinct image URLs and two distinct shared neck or sweater layer URLs.

## settings-tab-007

Original test `Keep every composer step and its edge options usable in one dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L279).

- **Given** An agent profile has no avatar.
- **When** The user opens the avatar composer and moves through its steps.
- **Then** One dialog provides Face, Hair, Mood, Skin, Color, and Sweater steps, each with its first and last listed options visible and a way to use the avatar.

## settings-tab-008

Original test `Create, save, and reopen a composed avatar from the profile page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L328).

- **Given** An agent profile has no avatar.
- **When** The user composes an oval face with blue hair, a pink sweater, and the selected options, saves it, then reopens avatar editing.
- **Then** The profile is saved with the six composed layers in the expected order, and reopening the editor shows those same saved layers rather than a newly randomized avatar.

## settings-tab-009

Original test `Allow an org admin to update another user's public agent avatar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L385).

- **Given** An organization admin views another user's public agent profile.
- **When** The admin randomizes the avatar and confirms the change.
- **Then** The avatar is updated, the agent remains public, and the update does not include a visibility change.

## settings-tab-010

Original test `Edit default Okou description and tone through the profile deep link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L449).

- **Given** The default Okou agent is opened through its profile deep link.
- **When** The user changes its description and tone, saves, and switches between Profile and Instructions.
- **Then** The description and friendly tone are saved and remain visible when returning to Profile. The name stays Okou and read-only; avatar customization, visibility controls, and agent deletion are absent.
- **Upstream change** `4e5707de` (#49556) retires the default Agent's profile page (`/agents/<default agent id>?tab=profile` now redirects to `/?settings=my-okou&focus=instructions`) and removes this upstream test. Retire this scenario; the bookmark redirect is covered by the profile row of `The default Agent's saved %s bookmark opens personal Instructions` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L418)).

## settings-tab-011

Original test `Edit and reopen default Okou instructions through the deep link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L475).

- **Given** The default Okou agent is opened through its Instructions deep link with existing instructions.
- **When** The user changes and saves the instructions, then switches to Profile and back to Instructions.
- **Then** The Instructions tab is initially selected, and the saved instructions appear when it is reopened.
- **Upstream change** `4e5707de` (#49556) retires the default Agent's profile and Instructions tabs (`/agents/<default agent id>?tab=instructions` now redirects to `/?settings=my-okou&focus=instructions`, showing the user's personal Instructions) and removes this upstream test. Retire the edit, save and reopen part; the deep link remains as the instructions row of `The default Agent's saved %s bookmark opens personal Instructions` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L418)), so rebuild this scenario as opening the bookmark and seeing the Settings dialog with the saved personal Instructions.

## settings-tab-012

Original test `Edit and save an agent profile`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L497).

- **Given** An agent profile is public, with its existing name, description, and professional tone.
- **When** The user changes the name to Research Lead, updates the description, chooses Friendly, requests private visibility, and confirms making the agent private.
- **Then** The profile saves the new name and description, friendly tone, and private visibility. The unsaved-changes notice clears, and the saved values remain when returning from Instructions to Profile.

## settings-tab-013

Original test `Discard unsaved agent profile edits`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L569).

- **Given** An agent profile is public, with its existing name, description, and professional tone.
- **When** The user changes the name, description, tone, and visibility, then discards the edits.
- **Then** The unsaved-changes notice clears, and the original name, description, professional tone, and public visibility remain; no profile update is saved.

## settings-tab-014

Original test `Explain the impact before deleting an agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L609).

- **Given** An agent profile is open and has not been changed.
- **When** The user chooses to delete the agent and then cancels.
- **Then** A dialog explains that deletion removes the agent, its workflows, automations, and everyone's chat history. Cancel closes the dialog, leaves the profile intact, and does not save a profile update.

## settings-tab-015

Original test `Refresh only owned workflow copy targets whenever the delete dropdown opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L680).

- **Given** The delete dialog is open for an agent, and the available agents include the source agent, a shared agent owned by someone else, and personal agents.
- **When** The user opens the workflow-copy destination list, selects a personal agent, then reopens the list after the available personal agent changes.
- **Then** Only owned agents other than the source are offered as destinations; the shared agent and source are omitted. The refreshed list replaces the old personal-agent option with the latest one.
- **Upstream change** `4e5707de` (#49556) limits workflow-copy destinations in the delete dialog to the current workspace default Agent, even when another user owns it; other owned or retained Agents and the source are no longer offered. The upstream test is now `Offer only the current workspace default when rescuing a retained Agent workflow` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L624)). Rebuild this scenario expecting each reopened list to offer only the then-current default Agent.

## settings-tab-016

Original test `Copy selected workflows before deleting their source agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L835).

- **Given** An agent has Daily research and Weekly research workflows, and the user selects Nova as the destination for both.
- **When** The user confirms deletion of the source agent.
- **Then** Both workflows are copied before the agent is deleted. The workflows page shows one Daily research and one Weekly research workflow.

## settings-tab-017

Original test `A failed copy preserves the source agent and workflows already copied`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L845).

- **Given** An agent has Daily research and Weekly research workflows, and the user selects Nova as the destination for both; copying the second workflow fails.
- **When** The user confirms deletion and then cancels after the copy error.
- **Then** The error for the failed second copy is shown, the source agent remains, and deletion is disabled. The first workflow remains copied, while the failed workflow remains only under the source agent.

## settings-tab-018

Original test `Keep the source agent when its workflow refresh fails after copying`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/settings-tab.test.tsx#L860).

- **Given** An agent has a workflow, and the user selects Nova as its copy destination.
- **When** The user confirms deletion, the copy succeeds, but refreshing the workflows fails.
- **Then** The workflow-load error is shown, deletion is disabled, and the selected destination becomes unavailable. Cancel closes the dialog without deleting the source agent; reopening the dialog keeps deletion disabled and resets the destination to deleting with the agent.
