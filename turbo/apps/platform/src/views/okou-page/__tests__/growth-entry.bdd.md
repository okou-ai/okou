# Growth entry

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [growth-entry.test.tsx](growth-entry.test.tsx).

## growth-entry-001

Original test `An admin is guided to add Okou to Slack first`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L156).

- **Given** An admin's Slack workspace is neither installed nor connected.
- **When** They follow “Add Okou in Slack” from the growth entry.
- **Then** They arrive at /works and see the “Install to Slack” action.

## growth-entry-002

Original test `The growth menu credit balance opens Usage settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L184).

- **Given** An admin has 1,600 usage-pack credits available and opens the growth menu.
- **When** They select the Credits item.
- **Then** A Settings dialog opens to the Credit balance section and shows 1,600 credits.

## growth-entry-003

Original test `The growth menu opens Okou is in Slack through a native link with keyboard activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L232).

- **Given** An admin opens the growth menu while Slack is installed and connected.
- **When** They keyboard-activate “Okou is in Slack.”
- **Then** It behaves as a native link to /works, navigates there, and closes the menu.

## growth-entry-004

Original test `The growth menu opens Telegram and phone through a native link with keyboard activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L232).

- **Given** An admin opens the growth menu while Slack is installed and connected.
- **When** They keyboard-activate “Telegram and phone.”
- **Then** It behaves as a native link to /works, navigates there, and closes the menu.

## growth-entry-005

Original test `Installed Slack shifts the growth entry to inviting people`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L261).

- **Given** An admin's Slack workspace is installed but not connected.
- **When** They open the growth entry and select “Invite humans 🤝.”
- **Then** A Settings dialog opens to People and shows the Add member action.

## growth-entry-006

Original test `An admin keeps the growth entry when the org has no quests`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L290).

- **Given** An admin's organization has no quests, and Slack is installed but not connected.
- **When** They open the workspace chat.
- **Then** The “Invite humans 🤝” growth entry remains visible even though the get-started entry is absent.

## growth-entry-007

Original test `A non-admin does not see the workspace growth entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/growth-entry.test.tsx#L313).

- **Given** A non-admin's Slack workspace is neither installed nor connected.
- **When** They open the workspace chat.
- **Then** The message composer is available, but neither “Add Okou in Slack” nor “Invite humans 🤝” is shown.
