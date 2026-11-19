# Feature guides

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [feature-guides.test.tsx](feature-guides.test.tsx).

## feature-guides-001

Original test `shows an enabled edition, records its display, and dismisses it with Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L163).

- **Given** An enabled feature-guide edition contains a weekly-report card.
- **When** The user opens the app and presses Escape in the guide.
- **Then** The guide shows the weekly-report description, records the edition revision as seen, and closes.

## feature-guides-002

Original test `cycles features with swipes and footer controls, resets walkthroughs, and pre-fills a task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L196).

- **Given** An enabled guide has a weekly-report card, a two-step walkthrough, and a share card.
- **When** The user navigates cards and walkthrough steps with footer controls and swipes, then tries the weekly-report task.
- **Then** The initial weekly-report card is selected. The walkthrough advances from “Start with a goal” to “Review the result”; swiping reaches the share card, and swiping back reaches the report card. The share card has no links or task action. Previous-feature navigation returns to the walkthrough, and selecting “Try this task” closes the guide and pre-fills “Prepare my weekly report.”

## feature-guides-003

Original test `keeps the feature selected during small, vertical, multi-touch, and cancelled gestures`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L293).

- **Given** A preview guide is open on the weekly-report card with a walkthrough available.
- **When** The user makes small, vertical, multi-touch, and cancelled gestures, then makes a qualifying horizontal swipe on the description and tries swiping the Next control.
- **Then** The small, vertical, multi-touch, and cancelled gestures leave the weekly-report card selected. A qualifying swipe advances to the walkthrough’s first step; swiping the Next control does not advance it, while clicking Next shows the second step.

## feature-guides-004

Original test `preserves video controls while allowing a swipe from the surrounding description`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L353).

- **Given** A preview guide begins with a demonstration video, followed by a weekly-report card.
- **When** The user swipes on the video and then on its surrounding description.
- **Then** The video retains its playback controls and a swipe on it keeps the video card selected. A swipe on the description advances to the weekly-report card.

## feature-guides-005

Original test `shows a Discord image, hides single-feature navigation, and opens setup with a text link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L404).

- **Given** A preview guide contains a single Discord setup card with an image and an Explore Discord link.
- **When** The user opens the link in a new tab, then clicks it normally.
- **Then** The card displays the Discord image and has no feature-navigation group. The link points to /settings/discord?featureGuidePreview=1; a modified click leaves the guide open, while a normal click opens Discord setup and closes the guide.

## feature-guides-006

Original test `opens artifacts from the feature guide text link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L489).

- **Given** A preview guide includes a card linking to Artifacts.
- **When** The user selects the Artifacts card and follows its text link.
- **Then** Artifacts opens at /artifacts?featureGuidePreview=1, and the guide closes without recording the edition as seen.

## feature-guides-007

Original test `opens chats from the feature guide text link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L489).

- **Given** A preview guide includes a card linking to Chats.
- **When** The user selects the Chats card and follows its text link.
- **Then** Chats opens at /?featureGuidePreview=1 with the Message textbox, and the guide closes without recording the edition as seen.

## feature-guides-008

Original test `keeps an already-seen edition closed based on the server response`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L557).

- **Given** The server reports that no current feature-guide edition is available.
- **When** The user opens the app with feature guides enabled.
- **Then** No feature-guide dialog appears.

## feature-guides-009

Original test `skips the guide request and dialog when the feature switch is off`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L569).

- **Given** Feature guides are disabled by the feature switch.
- **When** The user opens the app.
- **Then** The app makes no guide request and shows no feature-guide dialog.

## feature-guides-010

Original test `replays a preview from the home link without acknowledging a real impression`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L584).

- **Given** The user opens the home page with a feature-guide preview link, and the server returns a preview edition.
- **When** The user closes the preview guide.
- **Then** The guide is marked as a preview and closes without recording a real impression.

## feature-guides-011

Original test `renders an illustrated selected preview without recording a view`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L610).

- **Given** Single-agent mode and feature guides are enabled, and a preview link identifies a one-card illustrated edition.
- **When** The user opens the preview and closes it.
- **Then** The illustrated project card shows its Research scene and Market overview conversation, without feature navigation or links. Closing the preview does not record a view.

## feature-guides-012

Original test `cycles the illustrated project, instructions and workflow preview with buttons and swipes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L654).

- **Given** Single-agent mode is enabled and the preview edition has illustrated project, personal-instructions, and workflow cards.
- **When** The user moves among the cards with navigation buttons and swipes.
- **Then** The instructions illustration shows Settings, Personal, and “Use clear headings.” without buttons or textboxes. The workflow illustration shows Weekly report and its Private and Shared labels. Swiping from workflows returns to the project card; Previous feature returns to workflows, which is selected. No view is recorded.

## feature-guides-013

Original test `starts a newly loaded edition at its first card and walkthrough step`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feature-guides.test.tsx#L714).

- **Given** A preview guide is showing an older edition with a two-step walkthrough; the app subsequently serves a newly loaded edition containing one walkthrough card and one step.
- **When** The user closes the old preview, opens Chat, and views the newly loaded guide.
- **Then** The new guide starts on “New edition start” at step 1 / 1, with both Previous and Next disabled.
