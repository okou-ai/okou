# Chat cards

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-cards.test.tsx](chat-cards.test.tsx).

## chat-cards-001

Original test `A connector link becomes an action without losing surrounding prose`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L247).

- **Given** An assistant message contains two GitHub authorization links, one labeled and one in explanatory prose.
- **When** The chat message is displayed.
- **Then** Both links become GitHub action cards in their original positions. The surrounding heading and sentence remain readable, and the authorization label is not left as a link.

## chat-cards-002

Original test `A permission request beside an ordinary link keeps its explanation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L274).

- **Given** An assistant message has an ordinary reference link followed by a Slack file-read permission request.
- **When** The chat message is displayed.
- **Then** The reference remains a link and its explanatory sentence stays intact. The permission request becomes an enabled Confirm action card after the sentence.

## chat-cards-003

Original test `Multiple actions on one line keep their order and formatted prose`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L304).

- **Given** An assistant message contains GitHub and file-read actions in bold prose, followed by another GitHub action.
- **When** The chat message is displayed.
- **Then** The formatted prose remains bold and readable, and the two GitHub cards and permission card appear in source order.

## chat-cards-004

Original test `Removing formatted bare actions leaves readable prose without empty markers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L324).

- **Given** An assistant message contains bare GitHub and permission URLs inside bold and underlined formatting.
- **When** The chat message is displayed.
- **Then** The URLs become two GitHub and two permission action cards. The remaining prose is readable, with no empty formatting markers.

## chat-cards-005

Original test `Incomplete action links are shown as unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L344).

- **Given** An assistant message contains a GitHub authorization URL without an agent ID and a banking request without a reason.
- **When** The chat message is displayed.
- **Then** Both requests appear as unavailable actions, with no links to the incomplete URLs.

## chat-cards-006

Original test `Invalid actions remain unavailable beside valid and external links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L380).

- **Given** An assistant message contains a GitHub request for another agent, a permission request for another thread, a valid GitHub request, and a link to an external lookalike domain.
- **When** The chat message is displayed.
- **Then** The mismatched requests become unavailable actions, the valid request becomes an action card, and the external reference remains a link. Surrounding prose remains readable, and none of the action URLs remains a link.

## chat-cards-007

Original test `A bare relative permission beside another link keeps punctuation and prose`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L415).

- **Given** An assistant message contains a bare relative Slack permission URL followed by Chinese punctuation and an ordinary reference link.
- **When** The chat message is displayed.
- **Then** The permission request becomes an action card, while the punctuation and sentence remain readable and the reference remains a link. The reference appears before the action card.

## chat-cards-008

Original test `Bare actions recognize typographic delimiters without losing their labels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L433).

- **Given** An assistant message contains five permission URLs and seven GitHub authorization URLs preceded by typographic text, symbols, or emoji delimiters, including a relative permission URL.
- **When** The chat message is displayed.
- **Then** All twelve URLs become action cards in source order, and every delimiter and label remains visible. None of the action URLs remains a link.

## chat-cards-009

Original test `Action-looking URLs embedded in structural text remain content`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L507).

- **Given** An assistant message contains permission-URL text embedded in words, identifiers, paths, assignments, an address, and an external redirect link.
- **When** The chat message is displayed.
- **Then** The embedded URLs remain message content and produce no permission action cards. The external redirect remains an ordinary link.

## chat-cards-010

Original test `A bare action stops before adjacent Chinese punctuation and prose`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L552).

- **Given** An assistant message contains a bare GitHub authorization URL followed by Chinese punctuation and prose.
- **When** The chat message is displayed.
- **Then** The URL becomes a GitHub action card, and the punctuation and following prose remain in the message. No unavailable action is shown.

## chat-cards-011

Original test `Action labels stay literal instead of becoming new Markdown links or headings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L563).

- **Given** An assistant message contains action links labeled with escaped brackets, a Markdown-heading-like label, and a website-like label, including requests for another agent.
- **When** The chat message is displayed.
- **Then** The valid GitHub request becomes an action card; the two mismatched requests are unavailable. Their labels remain literal message prose and do not become headings or ordinary links, including the defined reference link.

## chat-cards-012

Original test `Code, images and table links stay content beside real actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L597).

- **Given** An assistant message contains action-like URLs in a fenced code block, inline code, an embedded token, indented code, an image, and table links, alongside a real GitHub action.
- **When** The chat message is displayed.
- **Then** Only the real GitHub request becomes an action card. Code, embedded text, the image, and table links remain content, including the table's permission link.

## chat-cards-013

Original test `Retained action labels preserve numeric character references`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L637).

- **Given** An assistant message contains a GitHub action label with numeric character references for a hash and ampersand.
- **When** The chat message is displayed.
- **Then** The GitHub request becomes an action card, and the retained prose displays the decoded label as “# Review & approve.”

## chat-cards-014

Original test `Multiline inline code stays literal beside a real action`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L648).

- **Given** An assistant message contains a multiline inline-code span with a GitHub URL and an ordinary URL, plus a separate permission request.
- **When** The chat message is displayed.
- **Then** The permission request becomes an action card, while both URLs inside the multiline code remain literal code. No GitHub action card is created from the code.

## chat-cards-015

Original test `Actions around multiline code remain available in paragraphs, quotes and lists`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L667).

- **Given** An assistant message contains permission actions in a paragraph, block quote, and nested list, with GitHub URLs inside multiline inline code in each location.
- **When** The chat message is displayed.
- **Then** All three permission requests become action cards. The GitHub and ordinary URLs within the three code spans remain literal code, with no GitHub action cards.

## chat-cards-016

Original test `Nested list actions remain available while indented code stays content`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L697).

- **Given** An assistant message contains GitHub and permission actions in a nested list, plus action-like URLs in quoted and indented code.
- **When** The chat message is displayed.
- **Then** The two nested-list requests become action cards and their list prose remains readable. The quoted and indented URLs remain code examples in their original order.

## chat-cards-017

Original test `Indented code keeps its formatting at message and action boundaries`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L737).

- **Given** An assistant message contains an indented permission URL, a GitHub action in a paragraph, and an indented GitHub URL.
- **When** The chat message is displayed.
- **Then** Only the paragraph's GitHub request becomes an action card. Both indented URLs remain code examples in source order.

## chat-cards-018

Original test `An exact reconnect card opens the non-default account dialog and continues only after success`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L760).

- **Given** A reconnect-required, non-default GitHub account named Work GitHub is associated with the exact account-specific reconnect link in the current chat.
- **When** The user opens the reconnect action, enters an API token, and saves successfully.
- **Then** The action identifies Work GitHub and opens an in-chat dialog without navigating away. The chat continues with “Continue the account-specific task” only after the exact account reconnect succeeds.

## chat-cards-019

Original test `A reconnect completion for another account never continues the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L808).

- **Given** A reconnect-required Work GitHub account is associated with the exact reconnect link, but the reconnect request completes for the default account instead.
- **When** The user opens the action, enters an API token, and saves.
- **Then** The submitted reconnect targets Work GitHub, but the dialog remains open and the chat does not continue when the response identifies a different account.

## chat-cards-020

Original test `Closing an in-flight reconnect dialog never continues after a late success`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L845).

- **Given** A reconnect-required Work GitHub account is being reconnected from an in-chat dialog and the request is in flight.
- **When** The user closes the dialog before the server reports success.
- **Then** The request is aborted from the client's perspective, and a late server success does not show a success message or continue the chat.

## chat-cards-021

Original test `An unnamed manual reconnect account uses its account label in the card and dialog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L899).

- **Given** A reconnect-required manual GitHub account has no display name and its exact reconnect link appears in the chat.
- **When** The user opens the reconnect action.
- **Then** The action card and dialog identify the account as “GitHub · API token,” and the card indicates that reconnection is required.

## chat-cards-022

Original test `An exact OAuth account opens the in-chat dialog with only its stored auth method`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L916).

- **Given** A reconnect-required Work GitHub account uses OAuth and its exact reconnect link appears in the current chat.
- **When** The user opens the reconnect action.
- **Then** An in-chat dialog opens for Work GitHub without navigating away. It offers the stored OAuth method and does not show an API-token field.

## chat-cards-023

Original test `A bare relative exact reconnect link opens the dialog and retains its callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L932).

- **Given** A reconnect-required Work GitHub account is referenced by a bare relative exact reconnect URL in the current chat, with an account-specific callback prompt.
- **When** The user opens the action, enters an API token, and saves successfully.
- **Then** The account is identified as Work GitHub, the punctuation and surrounding prose remain readable, and an in-chat dialog opens without navigation. Successful reconnection continues the chat with the retained callback prompt.

## chat-cards-024

Original test `A connected exact account still allows explicit reconnection instead of using the default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L976).

- **Given** The exact Work GitHub account is already connected, while a different account is the default, and the message explicitly requests reconnecting the exact account.
- **When** The user opens the reconnect action.
- **Then** The card identifies Work GitHub as connected and still offers reconnection. Opening it shows the Work GitHub dialog without navigating away.

## chat-cards-025

Original test `A reconnect card rechecks an account that disappears before activation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L996).

- **Given** A reconnect-required account initially exists for an exact reconnect action but disappears before the user activates it.
- **When** The user opens the action after the account has disappeared.
- **Then** The action becomes unavailable and no dialog opens or navigation occurs.

## chat-cards-026

Original test `A reconnect card stays unavailable if its stored authentication method is no longer offered`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1015).

- **Given** The exact reconnect account requires an authentication method that the connector no longer offers.
- **When** The chat displays the reconnect action.
- **Then** The action is unavailable, with no dialog or navigation.

## chat-cards-027

Original test `Closing the exact reconnect dialog does not send the callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1028).

- **Given** A reconnect-required Work GitHub account is associated with an exact reconnect action in the current chat.
- **When** The user opens the dialog and closes it without reconnecting.
- **Then** The dialog closes without sending the callback or navigating away.

## chat-cards-028

Original test `Malformed or context-mismatched exact reconnect links are inert`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1048).

- **Given** An assistant message contains exact reconnect URLs with a mismatched agent ID, a mismatched thread ID, and a malformed account ID.
- **When** The chat message is displayed.
- **Then** All three requests are unavailable actions, with no connector action cards or links to those URLs.

## chat-cards-029

Original test `A missing exact reconnect account never falls back to the default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1081).

- **Given** The exact account named by a reconnect link is missing, although a default GitHub account exists.
- **When** The chat message is displayed.
- **Then** The request is unavailable and does not fall back to the default account or navigate away.

## chat-cards-030

Original test `Connector account switches A → B → A keep their icon and continue with fresh callback IDs (Chat access: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1091).

- **Given** Chat account access is disabled, and the chat contains a switch action for Work GitHub followed by a later action for Personal GitHub.
- **When** The user switches A to B and back to A, allowing each account-specific callback to complete.
- **Then** Each action retains the GitHub icon, each switch updates its own account, and the chat continues after each successful switch. The three callbacks use distinct client event IDs and distinct chat-thread sort event IDs.

## chat-cards-031

Original test `Connector account switches A → B → A keep their icon and continue with fresh callback IDs (Chat access: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1091).

- **Given** Chat account access is enabled, and the chat contains a switch action for Work GitHub followed by a later action for Personal GitHub.
- **When** The user switches A to B and back to A, allowing each account-specific callback to complete.
- **Then** Each action retains the GitHub icon, each switch updates its own account, and the chat continues after each successful switch. The three callbacks use distinct client event IDs and distinct chat-thread sort event IDs.

## chat-cards-032

Original test `Ordinary or code links remain message content`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1356).

- **Given** An assistant message contains a GitHub authorization URL in a fenced code block and an ordinary reference link in prose.
- **When** The chat message is displayed.
- **Then** The URL remains code and the reference remains an ordinary link. Neither creates an action card.

## chat-cards-033

Original test `A valid banking request becomes an action card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-cards.test.tsx#L1380).

- **Given** An assistant message contains a banking request for agent Finance Assistant, with a reason, current thread ID, and callback prompt, and the access-status request returns no connection, session, or grant.
- **When** The chat message is displayed.
- **Then** The request becomes a banking action card showing the agent, the specified reason, and read-only access to accounts, balances, and transactions. The banking URL is not shown as a link.
