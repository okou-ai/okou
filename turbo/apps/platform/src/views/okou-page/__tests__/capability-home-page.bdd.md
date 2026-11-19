# Capability home page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [capability-home-page.test.tsx](capability-home-page.test.tsx).

## capability-home-page-001

Original test `An empty conversation offers capabilities by default without an avatar and sends its first message in the same conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L79).

- **Given** A conversation is empty and has no avatar greeting.
- **When** The user selects a Presentation template, returns to all capabilities, and sends “Prepare the launch presentation.”
- **Then** The template and prompt appear in the same conversation, the composer remains, and no new conversation is created.

## capability-home-page-002

Original test `The home lists compliance statuses under the capability cards`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L123).

- **Given** The user is on the Okou home page.
- **When** The page loads.
- **Then** Compliance statuses appear below the capability cards and above the composer: SOC 2 Type II is In progress; CCPA / CPRA and GDPR are Compliant; HIPAA and ISO/IEC 27001 are Aligned.

## capability-home-page-003

Original test `The empty conversation lists compliance statuses under the capability cards`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L123).

- **Given** The user is in an empty conversation.
- **When** The conversation loads.
- **Then** Compliance statuses appear below the capability cards and above the composer: SOC 2 Type II is In progress; CCPA / CPRA and GDPR are Compliant; HIPAA and ISO/IEC 27001 are Aligned.

## capability-home-page-004

Original test `Hiding the compliance block keeps it hidden on this device`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L164).

- **Given** The compliance block is visible on the home page.
- **When** The user hides it, leaves for the Agents page, and returns to Chat.
- **Then** The block disappears and remains hidden on this device; focus moves to the composer when it is hidden.

## capability-home-page-005

Original test `An open tray switches capabilities and types without going back to the cards`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L208).

- **Given** The user has an open capability tray and a draft, “Keep my launch brief.”
- **When** The user changes the Create type from Presentation to Image, switches through Find people and Research, returns to Create, then opens Workflow.
- **Then** Each selection opens its corresponding content without returning to the cards; Create reopens as Image, the draft remains, capability labels appear with their removal controls, and Tools is absent for Create and Workflow.

## capability-home-page-006

Original test `Switching Presentation to Find people sends the manually written prompt as ordinary chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L270).

- **Given** The user has opened Presentation templates from the capability cards.
- **When** The user switches to Find people, writes “Find the right sources for my launch research.”, and sends it.
- **Then** The message is sent as ordinary text without a template attachment.

## capability-home-page-007

Original test `Switching Image to Research sends the manually written prompt as ordinary chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L270).

- **Given** The user has opened Image styles from the capability cards.
- **When** The user switches to Research, writes “Find the right sources for my launch research.”, and sends it.
- **Then** The message is sent as ordinary text without a template attachment.

## capability-home-page-008

Original test `Opening the tray from a card and closing it back each swap the home under one view transition`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L292).

- **Given** The user has a draft, “Keep my launch brief.”
- **When** The user opens Research from its card, switches to Find people, then returns to all capabilities.
- **Then** Opening and closing the tray each produce one home view transition, switching capabilities produces none, and the draft remains.

## capability-home-page-009

Original test `The capability tabs move with the arrow keys and open on Enter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L315).

- **Given** The Presentation template tray is open and Create is selected.
- **When** The user presses the right arrow and then Enter.
- **Then** Focus moves to Workflow and the Workflow content opens with its tab selected.

## capability-home-page-010

Original test `The tray names a type once and browses its catalog from the header line`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L329).

- **Given** The user opens Presentation templates from Create.
- **When** The user browses all templates, closes the catalog, selects Chart, then switches to Find people.
- **Then** The Presentation type is named once in the header and the catalog opens on its Presentation tab; Chart has no catalog-browse control, and Find people describes its results as “Customers, creators, decision-makers.”

## capability-home-page-011

Original test `Capability discovery and templates replace each other while the composer keeps the draft and template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L369).

- **Given** The user is on the home page with a greeting and the draft “Keep my launch brief.”
- **When** The user opens Presentation templates, selects a template, returns to all capabilities, and opens Presentation again.
- **Then** Capabilities and templates replace each other while the greeting remains; the draft and selected template remain in the composer.

## capability-home-page-012

Original test `Workflow suggestions preserve the draft and open the real workflow picker`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L402).

- **Given** The user has the draft “Focus on customer meetings.”
- **When** The user opens Advanced workflows, selects “Start your day with a clear plan,” browses the workflow catalog, returns to all capabilities, and opens Triggers.
- **Then** The draft remains and the Morning brief template and suggested text are added without removing it; the catalog opens on Workflow and offers Morning brief. Triggers displays Email replies.

## capability-home-page-013

Original test `Scheduled tasks and triggers prepare their own editable automation requests`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L446).

- **Given** The user has the draft “Use my work account.”
- **When** The user selects “Repeat on a schedule,” returns to all capabilities, then selects the Email replies trigger.
- **Then** The composer prepares editable requests that include the schedule’s time-zone question and the Gmail trigger’s flow and confirmation requirement, preserving the original draft; neither request starts a run.

## capability-home-page-014

Original test `Scheduled leads with its two starters, then the workflows that run on a clock`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L472).

- **Given** The user opens Scheduled tasks.
- **When** The user inspects its starters and selects “Start your day with a clear plan.”
- **Then** The starters are Run once at a set time, Repeat on a schedule, Start your day with a clear plan, Wrap up your week clearly, Know when competitors change, and See how your business is doing. The selection adds the Morning brief template and prepares its request without starting a run.

## capability-home-page-015

Original test `A trigger's cover is named by its title and described by its flow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L500).

- **Given** The user opens Triggers.
- **When** The user checks the Email replies option.
- **Then** Its accessible description identifies the cover as “Gmail: Email starred → Extract requests → Draft reply.”

## capability-home-page-016

Original test `News digest prepares a periodic monitoring request without starting it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L513).

- **Given** The user has the draft “Focus on product launches.”
- **When** The user selects News digest under Triggers.
- **Then** An editable request for News digest using RSS includes Keyword match, asks how often to check, and says to check periodically while skipping processed items; the original draft remains and no run starts.

## capability-home-page-017

Original test `X watchlist prepares a periodic monitoring request without starting it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L513).

- **Given** The user has the draft “Focus on product launches.”
- **When** The user selects X watchlist under Triggers.
- **Then** An editable request for X watchlist using X includes New post, asks how often to check, and says to check periodically while skipping processed items; the original draft remains and no run starts.

## capability-home-page-018

Original test `Every capability card opens from anywhere on it, as its first choice does`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L536).

- **Given** The user is viewing the capability cards.
- **When** The user opens Research, Find people, Create, and Workflow by selecting anywhere on each card cover.
- **Then** Each card opens its corresponding capability content: Research suggestions, Find people suggestions, Presentation templates, and Schedule a task.

## capability-home-page-019

Original test `Search and Research open separate suggestions and prepare editable drafts without starting a run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L575).

- **Given** The user has the draft “I am planning a research project.”
- **When** The user selects Potential customers under Find people, returns to all capabilities, then selects Compare website traffic under Research.
- **Then** Each selection prepares an editable suggestion without starting a run, and the original draft is preserved. Explore what’s new links to the Okou blog in a new tab from the page banner.

## capability-home-page-020

Original test `Closing Find people clears its unchanged injected prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L638).

- **Given** The user opens Find people and selects Potential customers, which injects a suggestion into an otherwise empty composer.
- **When** The user closes the capability tray without editing the suggestion.
- **Then** The suggestion is cleared, the composer is focused, and all capabilities are visible.

## capability-home-page-021

Original test `Closing Research clears its unchanged injected prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L638).

- **Given** The user opens Research and selects Compare website traffic, which injects a suggestion into an otherwise empty composer.
- **When** The user closes the capability tray without editing the suggestion.
- **Then** The suggestion is cleared, the composer is focused, and all capabilities are visible.

## capability-home-page-022

Original test `Closing Scheduled tasks clears its unchanged injected prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L638).

- **Given** The user opens Scheduled tasks and selects Repeat on a schedule, which injects a suggestion into an otherwise empty composer.
- **When** The user closes the capability tray without editing the suggestion.
- **Then** The suggestion is cleared, the composer is focused, and all capabilities are visible.

## capability-home-page-023

Original test `Closing Triggers clears its unchanged injected prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L638).

- **Given** The user opens Triggers and selects Email replies, which injects a suggestion into an otherwise empty composer.
- **When** The user closes the capability tray without editing the suggestion.
- **Then** The suggestion is cleared, the composer is focused, and all capabilities are visible.

## capability-home-page-024

Original test `Closing Advanced workflows clears its unchanged injected prompt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L638).

- **Given** The user opens Advanced workflows and selects Start your day with a clear plan, which injects a suggestion and adds the Morning brief template to an otherwise empty composer.
- **When** The user closes the capability tray without editing the suggestion.
- **Then** The suggested text is cleared while the Morning brief template remains; the composer is focused and all capabilities are visible.

## capability-home-page-025

Original test `Closing Find people preserves the prompt after the user edits it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L659).

- **Given** The user opens Find people and selects Potential customers, then adds “ Focus on my company.” to the injected prompt.
- **When** The user closes the capability tray.
- **Then** The edited prompt, including “Focus on my company,” remains in the composer.

## capability-home-page-026

Original test `Closing Research preserves the prompt after the user edits it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L659).

- **Given** The user opens Research and selects Compare website traffic, then adds “ Focus on my company.” to the injected prompt.
- **When** The user closes the capability tray.
- **Then** The edited prompt, including “Focus on my company,” remains in the composer.

## capability-home-page-027

Original test `Closing Scheduled tasks preserves the prompt after the user edits it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L659).

- **Given** The user opens Scheduled tasks and selects Repeat on a schedule, then adds “ Focus on my company.” to the injected prompt.
- **When** The user closes the capability tray.
- **Then** The edited prompt, including “Focus on my company,” remains in the composer.

## capability-home-page-028

Original test `Closing Triggers preserves the prompt after the user edits it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L659).

- **Given** The user opens Triggers and selects Email replies, then adds “ Focus on my company.” to the injected prompt.
- **When** The user closes the capability tray.
- **Then** The edited prompt, including “Focus on my company,” remains in the composer.

## capability-home-page-029

Original test `Closing Advanced workflows preserves the prompt after the user edits it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L659).

- **Given** The user opens Advanced workflows and selects Start your day with a clear plan, then adds “ Focus on my company.” to the injected prompt.
- **When** The user closes the capability tray.
- **Then** The edited prompt, including “Focus on my company,” remains in the composer.

## capability-home-page-030

Original test `Dismissing repeated suggestions restores the original draft without stacked prompts`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L678).

- **Given** The user writes “Keep my own brief.” and opens Find people.
- **When** The user selects Potential customers, then Event speakers, and closes the tray.
- **Then** The composer returns to the original draft, “Keep my own brief.”, without retaining either injected suggestion.

## capability-home-page-031

Original test `Dismissing a suggestion does not clear matching text the user wrote`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/capability-home-page.test.tsx#L693).

- **Given** The user writes the exact text “Help me find: Potential customers. Ask me about my target, criteria, and scope first. Return a shortlist with relevant details and source links.” before opening Find people.
- **When** The user selects Potential customers twice and closes the tray.
- **Then** The user-written text remains unchanged.
