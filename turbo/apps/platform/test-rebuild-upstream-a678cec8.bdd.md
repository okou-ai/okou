# For you updates in a678cec8

Compared `edb4d615` with [a678cec8 (#49200)](https://github.com/okou-ai/okou/pull/49200).
The product changes are integrated. Rebuild the cleared
`agent-suggestions.test.tsx` against this revision. These changes await
selection and runtime verification and do not alter the frozen baseline.

Six registrations change their title and behavior. Reconcile the source
at lines 1002 (full composer and isolated home draft), 1056 (card-specific
background when browsing), 1102 (retry preserves the editor and send
identities), 1171 (background files), 1796 (in-place send and advance), and
2229 (browsing and control gestures). The older registration “An accepted
custom follow-up preserves a newer direction entered after returning
to the page” is absent. Reconcile its selected ID against the current
editor lifecycle before retiring it.

## upstream-a678cec8-agent-suggestions-1032-01

- **Given** A For you card opens a new-chat direction composer prefilled with the suggestion quote.
- **When** The member writes a message, removes the quote, and sends.
- **Then** The standalone text is sent, and the same suggestion stays available on For you.

## upstream-a678cec8-agent-suggestions-1244-01

- **Given** A For you suggestion references a chat that already has a saved draft.
- **When** The member selects the related chat, writes a direction in the card, and sends.
- **Then** One message goes to that chat with the suggestion and the direction. The saved draft is neither loaded into the card composer nor overwritten. For you advances after the send.

## upstream-a678cec8-agent-suggestions-1312-01

- **Given** A For you card offers a related chat.
- **When** The member selects the chat, goes back, chooses New chat, enters a direction, and sends.
- **Then** The message starts a different chat titled after the suggestion and retains the suggestion context.
