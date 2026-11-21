# Agent suggestions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [agent-suggestions.test.tsx](agent-suggestions.test.tsx).

## agent-suggestions-001

Original test `A cached card still sends its action after server cleanup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L353).

- **Given** A suggestion card is already loaded, but the server removes it from the pool.
- **When** The user chooses its action.
- **Then** The action is still sent using the cached consume token, and the user remains on For you.

## agent-suggestions-002

Original test `For you opens background-updated cards after an Ably notification without waiting for another request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L385).

- **Given** For you has loaded one card, and a second card is added while the user views Agents.
- **When** An Ably notification announces the change, then the user opens For you while its list request is still pending.
- **Then** The second card is immediately available at its URL without waiting for the pending request to finish.

## agent-suggestions-003

Original test `For you opens background-updated cards after an Ably reconnect without waiting for another request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L385).

- **Given** For you has loaded one card, and a second card is added while the user views Agents.
- **When** An Ably reconnect announces the change, then the user opens For you while its list request is still pending.
- **Then** The second card is immediately available at its URL without waiting for the pending request to finish.

## agent-suggestions-004

Original test `For you preloads details when its sidebar shows an unread dot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L428).

- **Given** The user is on the homepage, and the For you sidebar entry shows an unread dot.
- **When** The user opens For you while its details request is held pending.
- **Then** The suggestion card appears before the held request is released.

## agent-suggestions-005

Original test `For you retries a failed preloaded feed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L452).

- **Given** The For you feed request fails.
- **When** The user selects Try again after the error appears.
- **Then** The suggestion card loads successfully.

## agent-suggestions-006

Original test `For you opens the new owner's cards after an active account change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L473).

- **Given** For you initially shows one user's cards; the user views Agents before changing accounts.
- **When** The active account changes and the user opens For you again.
- **Then** The new account's card appears, and the previous account's card does not.

## agent-suggestions-007

Original test `For you opens the new owner's cards after an active workspace change`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L473).

- **Given** For you initially shows one workspace's cards; the user views Agents before changing workspaces.
- **When** The active workspace changes and the user opens For you again.
- **Then** The new workspace's card appears, and the previous workspace's card does not.

## agent-suggestions-008

Original test `Choosing an action sends it to a new thread and keeps the homepage draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L507).

- **Given** The homepage has a saved draft, and a suggestion offers several actions, including an unselected action.
- **When** The user chooses one action.
- **Then** It is sent to a new chat titled with the suggestion, includes the referenced chat, and excludes the unselected action. The next card appears, the user stays on For you, and returning home preserves the original draft without adding the suggestion content.

## agent-suggestions-009

Original test `An existing-thread suggestion merges its content and attachments with the remote draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L565).

- **Given** A suggestion action targets an existing chat with a remote draft and an attachment; the suggestion also provides text and a different attachment.
- **When** The user chooses the action.
- **Then** The existing chat opens with the suggested content merged with the remote draft and both attachments. No message is sent automatically.

## agent-suggestions-010

Original test `A consumed suggestion is saved when target metadata is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L643).

- **Given** A suggestion action targets a chat whose metadata request returns not found, while its draft request is still loading.
- **When** The user chooses the action and the draft request finishes.
- **Then** The chat opens, the suggested content is saved despite unavailable metadata, and the suggestion is consumed.

## agent-suggestions-011

Original test `A choice is still sent when another session consumed the card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L689).

- **Given** Another session has consumed the suggestion and removed it from the pool.
- **When** The user chooses its already-loaded action and consumption returns a conflict.
- **Then** The action is still sent, the user remains on For you, and no alert appears.

## agent-suggestions-012

Original test `A suggestion uses the ordinary composer to join a running target chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L711).

- **Given** A suggestion action targets a chat with a run already in progress.
- **When** The user chooses the action and then sends it from the chat composer.
- **Then** The existing chat opens with the suggested content in its composer, and sending queues the message in the running chat with the referenced chat included.

## agent-suggestions-013

Original test `The loaded option keeps its draft and destination when the server responds with a later version`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L767).

- **Given** The user has loaded a suggestion action for a new chat.
- **When** The server responds to consumption with a later version of that option that points to a different chat and contains different text.
- **Then** The loaded action is sent to a new chat with its originally loaded content, not the later server content, and the user remains on For you.

## agent-suggestions-014

Original test `A sent suggestion advances the stack and remains reachable in the chat list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L819).

- **Given** At least two suggestion cards are available.
- **When** The user chooses the first card's action and opens the resulting chat from the chat list.
- **Then** The next card advances into view, the sent chat remains available from the chat list, and its chat opens.

## agent-suggestions-015

Original test `A choice that sends nothing returns its card to its place`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L839).

- **Given** At least two cards are available, but no model is available to send a message.
- **When** The user chooses the first card's action.
- **Then** The unavailable-model error appears, and the first card remains in its original place.

## agent-suggestions-016

Original test `A send that fails before its thread is published shows the failure in its row`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L861).

- **Given** At least two cards are available, and starting a send will fail before a chat is published.
- **When** The user chooses the first card's action while the send request is pending, then the request fails.
- **Then** The next card can appear while sending is pending. The failure message appears in an alert and the Sending… indicator disappears.

## agent-suggestions-017

Original test `A deleted target shows its unavailable page and preserves the home draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L896).

- **Given** The homepage has a draft, and a suggestion action targets a deleted chat whose metadata, chat, and draft requests all return not found.
- **When** The user chooses the action and then returns to the homepage.
- **Then** The deleted-chat unavailable page appears at the target chat URL, and the homepage draft is preserved.

## agent-suggestions-018

Original test `Suggestion options start in the default Agent after visiting a secondary Agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L931).

- **Given** The user is visiting a secondary Agent, while suggestion actions are expected to use the default Agent.
- **When** The user opens For you and chooses an action.
- **Then** The action is sent through the default Agent, and the user remains on For you.

## agent-suggestions-019

Original test `Custom direction opens a dialog composer for the default Agent without touching its home draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L983).

- **Given** The homepage has a draft and For you shows a suggestion with a custom-direction action.
- **When** The user opens the inline custom composer, enters a direction, then follows the Okou home link without sending.
- **Then** The inline composer shows the suggestion title and excludes the background quote and homepage draft. It has no target heading, Close or Remove feedback action. Send starts disabled and becomes enabled after typing. The suggestion stays available and returning home shows the original draft. [#49618](https://github.com/okou-ai/okou/pull/49618).

## agent-suggestions-020

Original test `Each custom direction dialog starts from its own card's background`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1019).

- **Given** Two suggestion cards have different titles and background quotes.
- **When** The user enters text in the first card's inline custom composer, follows the second card's link, and opens that card's composer.
- **Then** The first editor disappears when the second card opens. Its composer shows the second title without the first title or unsent direction.

## agent-suggestions-021

Original test `A custom follow-up retains its dialog on failure and reuses its identities until acceptance`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1075).

- **Given** A suggestion's custom-direction dialog contains a typed follow-up, and sending it initially fails.
- **When** The user retries the send and the server accepts it.
- **Then** The failure leaves the dialog and its text intact; the retry uses the same chat and event identities and includes the suggestion background and follow-up. Acceptance closes the dialog, removes the card, shows the sent confirmation and All caught up, and leaves the user on For you; no ordinary card-consumption request is recorded.

## agent-suggestions-022

Original test `The custom direction dialog sends the background files without the home draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1144).

- **Given** The homepage has a saved draft and attachment, while a suggestion's background contains a different attachment.
- **When** The user opens the custom-direction dialog, enters a direction, and sends it.
- **Then** The sent new chat is titled with the suggestion and includes the suggestion background attachment, but excludes the homepage draft and attachment. The user remains on For you.

## agent-suggestions-023

Original test `Not planned advances to the next card and Undo restores the selected card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1217).

- **Given** Three cards are available, and the user has navigated to the second card.
- **When** The user marks it Not planned and then selects Undo.
- **Then** The third card appears after the choice, and Undo restores the selected second card.

## agent-suggestions-024

Original test `Failed feedback keeps the local choice and can retry the same feedback identity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1239).

- **Given** A card is available, but saving feedback fails.
- **When** The user chooses Already done and retries after the error.
- **Then** The local choice remains: the card is removed and All caught up appears with the failure alert. Retrying clears the alert and uses the same feedback identity.

## agent-suggestions-025

Original test `Feedback on a card that left the pool refreshes the suggestions with a notice`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1278).

- **Given** Three cards are loaded; the user dismisses the first, then the server withdraws the remaining pool and offers a new card.
- **When** The user marks the second loaded card Already done.
- **Then** The stale-card notice appears and the newly offered card is shown without an alert or lingering refresh message. Undo restores the previously dismissed first card.

## agent-suggestions-026

Original test `Retrying feedback for a card that has since left the pool refreshes the suggestions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1322).

- **Given** Feedback for a card fails, and the card leaves the pool before the user retries.
- **When** The user retries the feedback.
- **Then** The suggestions refresh with an unavailable notice, the alert clears, and the local Already done confirmation is not shown.

## agent-suggestions-027

Original test `Slow feedback leaves other cards usable and Undo restores the original card in order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1358).

- **Given** Three cards are available, and saving feedback on the first card is slow.
- **When** The user gives feedback on the second card while the first request is pending, then waits for both saves and undoes the first choice.
- **Then** The second card remains usable and advances to the third; both feedback confirmations appear. Undo restores the first card and targets its original feedback.

## agent-suggestions-028

Original test `Choosing an action confirms the send while its consumption is still saving`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1411).

- **Given** At least two cards are available, and consumption of the first card is held pending.
- **When** The user chooses the first card's action.
- **Then** The sent confirmation appears and the next card advances before consumption finishes; the user remains on For you.

## agent-suggestions-029

Original test `An existing conversation opens before consumption and its remote draft finish`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1444).

- **Given** A suggestion action targets an existing conversation whose remote draft request and consumption request are both held pending.
- **When** The user chooses the action and the remote draft request completes before consumption.
- **Then** The target conversation opens with the suggested content before consumption finishes, then the saved remote draft appears in the composer.

## agent-suggestions-030

Original test `For you moves suggestions out of the homepage into its own chat-list entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1504).

- **Given** The user is on the homepage, where the For you entry shows an unread indicator.
- **When** The user opens For you.
- **Then** The first suggested action and its rationale appear on For you, which becomes the current chat-list entry.

## agent-suggestions-031

Original test `For you browses without consuming and restores a card from its URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1521).

- **Given** Three cards are available, and the user opens For you directly at the second card's URL.
- **When** The user navigates to the third card, returns to the second card by URL, and checks the remaining count.
- **Then** The URL tracks the selected card, browsing does not consume cards, and three cards remain.

## agent-suggestions-032

Original test `For you mounts only the foreground content and retains a departure until its animation finishes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1555).

- **Given** For you has multiple cards and animated avatars enabled; the first card is foregrounded.
- **When** The user navigates to the second card while the first card's departure animation is held.
- **Then** Only the foreground card's content is otherwise mounted; the first card remains present and inert until its animation finishes, then disappears. Browsing does not consume cards.

## agent-suggestions-033

Original test `A superseded departure cannot finish a newer For you transition`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1591).

- **Given** For you is transitioning from the first card to the second, then to the third, with both departure animations held.
- **When** The first departure finishes before the second departure.
- **Then** The first card is removed without removing the second; when the second departure finishes, the second card is removed and the URL still selects the third.

## agent-suggestions-034

Original test `Reduced-motion For you navigation immediately releases the previous card in both directions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1614).

- **Given** The user prefers reduced motion, and For you is showing the first card.
- **When** The user navigates to the second card and then back to the first.
- **Then** Each previous card is released immediately in both navigation directions, and browsing does not consume cards.

## agent-suggestions-035

Original test `For you handles cards in order, completes, and restores a dismissed card with Undo`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1631).

- **Given** For you has two cards in order.
- **When** The user dismisses the first, marks the second Already done, and selects Undo.
- **Then** The second card appears after dismissal of the first; after the second choice, All caught up and the feedback confirmation appear. Undo restores the second card.

## agent-suggestions-036

Original test `For you sends a suggestion in place while retaining the next card and its background`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1646).

- **Given** The For you deck contains two suggestions.
- **When** The member chooses the first suggestion's Review decision action.
- **Then** A new chat is sent with the referenced decision included. The second suggestion remains available, the Sent to a new chat confirmation appears, and the member stays on For you.

## agent-suggestions-037

Original test `For you keeps custom directions in the existing composer and advances after sending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1658).

- **Given** The For you deck contains two suggestions, and the first includes launch-plan context.
- **When** The member enters “Summarize the open budget question first” as a custom direction and sends it.
- **Then** The chat message includes the custom direction and launch-plan context. The second suggestion remains available, and the member stays on For you.

## agent-suggestions-038

Original test `For you preserves a failed feedback write for an explicit retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1678).

- **Given** The For you deck contains two suggestions, and saving feedback for the first fails with a server error.
- **When** The member dismisses the first suggestion and explicitly retries after the error appears.
- **Then** The error is shown, the retry sends feedback for the same suggestion again, and the second suggestion becomes active.

## agent-suggestions-039

Original test `An empty For you page stays accessible and reports zero suggestions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1705).

- **Given** The For you page has no suggestions.
- **When** The member opens For you.
- **Then** The page remains accessible, shows “All caught up,” and reports “0 to go.”

## agent-suggestions-040

Original test `Disabling Suggestions returns a direct For you link to the regular homepage`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1712).

- **Given** Suggestions are disabled and the member opens a direct For you link.
- **When** The page loads.
- **Then** The member is redirected to the regular homepage for the agent chat.

## agent-suggestions-041

Original test `For you handles a suggestion and a platform event in the same deck`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1750).

- **Given** The deck contains a suggestion and a platform event about automation being disabled.
- **When** The member dismisses the suggestion, then dismisses the platform event.
- **Then** The platform event remains after the suggestion is dismissed. After the event is dismissed, the page shows “All caught up”; the suggestion is consumed and the event is dismissed.

## agent-suggestions-042

Original test `A hidden For you page leaves its card unread until the member sees it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1779).

- **Given** The member opens For you while the page is hidden, and a suggestion is available.
- **When** The member navigates away and returns to For you, then makes the page visible.
- **Then** The suggestion remains unread while the page is hidden. Once visible, its unread indicator clears and the page reports “1 to go.”

## agent-suggestions-043

Original test `A failed system update source change keeps the saved choice and allows an explicit retry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1802).

- **Given** The member opens the source settings with system updates enabled, and the first save attempt fails.
- **When** The member turns system updates off, then explicitly retries after the save error.
- **Then** The failed save leaves the toggle on and available for another attempt. The retry turns the toggle off.

## agent-suggestions-044

Original test `For you marks only displayed cards as read and new deliveries restore its unread dot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1855).

- **Given** Three suggestions are delivered, and the member starts outside For you.
- **When** The member views the first, second, and third suggestions in sequence, leaves the page, returns, and then a fourth suggestion is delivered.
- **Then** Only the three displayed cards are marked read; none are consumed, and the page reports “3 to go.” The unread indicator clears after all three are displayed, remains clear on return, and reappears when the fourth suggestion is delivered.

## agent-suggestions-045

Original test `For you source choices persist without removing delivered cards and only enabled sources alert`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1886).

- **Given** Three suggestions are delivered, and Suggestions, Offers, and System updates are initially enabled.
- **When** The member disables Suggestions, Offers, and System updates, closes and reopens the settings, then enables Suggestions again.
- **Then** Disabling sources does not remove delivered cards. The disabled choices persist after navigation and reopening; Suggestions, Offers, and System updates are off until Suggestions is re-enabled. The unread indicator returns when Suggestions is enabled.

## agent-suggestions-046

Original test `System updates remain unread with optional sources off until their card is displayed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx#L1965).

- **Given** A system update card is available, Suggestions, What's new, and Offers are off, and System updates is on.
- **When** The member opens For you and displays the system update card.
- **Then** The unread indicator remains until the card is displayed, then clears. The card is shown and the page reports “1 to go”; the source settings show Suggestions off and System updates on.
