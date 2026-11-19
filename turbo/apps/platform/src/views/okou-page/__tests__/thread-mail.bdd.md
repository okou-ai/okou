# Thread mail

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [thread-mail.test.tsx](thread-mail.test.tsx).

## thread-mail-001

Original test `thread email manager > opens an empty state for a thread without email`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L421).

- **Given** A chat thread has no emails.
- **When** The user opens Manage emails.
- **Then** An Emails dialog shows “No emails yet” and no subject-or-sender search field.

## thread-mail-002

Original test `thread email manager > navigates filters with arrow keys, selects with Enter or Space, and restores focus on Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L435).

- **Given** The Emails dialog is open, with All selected and the chat’s More actions control as the entry point.
- **When** The user navigates filters with the right arrow, selects Drafts with Enter, then moves to Sent and selects it with Space.
- **Then** Focus moves to each next filter, and the selected filter changes only when activated. The list contains Proposal 12 but no checkbox for Proposal 1. Pressing Escape restores focus to More actions.

## thread-mail-003

Original test `thread email manager > selects only filtered drafts and shows their bulk actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L470).

- **Given** The email list contains two drafts and sent emails, with no draft bulk actions shown initially.
- **When** The user selects Proposal 1, selects all drafts, then opens the Sent filter and selects all again.
- **Then** Selecting one draft shows draft-specific guidance and a mixed Select all checkbox; selecting all shows 2 selected with enabled Send and Delete actions. Only the two drafts are selectable. Selecting all again clears the selection and bulk actions, and the Sent filter has no checkboxes or draft bulk actions.

## thread-mail-004

Original test `thread email manager > preserves selection, search and scroll when returning from list details; chat details have no list navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L512).

- **Given** A chat thread has email details and a transcript email link. The user opens a draft detail from the chat, closes it, opens the email list, searches for Proposal, selects Proposal 1, switches to Sent, and scrolls the list to 180 pixels.
- **When** The user opens Proposal 12 from the Sent list, returns to the list, switches to All, then returns to the chat detail.
- **Then** Chat-opened email details have no Back to emails link. The Proposal 12 link preserves the thread, detail destination, email ID, Sent filter, and Proposal search in its URL. Returning to the list restores the search, Sent filter, and 180-pixel scroll position; switching to All reveals the still-selected Proposal 1.

## thread-mail-005

Original test `thread email manager > restores a detail and its list filters from a direct URL without a transcript card`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L568).

- **Given** The user opens a chat URL directly with mail detail for Proposal 12, originating from the list with the Sent filter and search Proposal 12, plus an unrelated query parameter and a URL fragment; the transcript has no email card.
- **When** The user opens Back to emails.
- **Then** The list shows Proposal 12, restores the search and Sent filter, and preserves the unrelated query parameter and URL fragment.

## thread-mail-006

Original test `thread email manager > uses browser Back and Forward to restore list and detail navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L600).

- **Given** The user opens the email list, selects Proposal 1, switches to Sent, and opens Proposal 12.
- **When** The user uses browser Back, then Forward, returns to the list, and selects Drafts.
- **Then** Back restores the Sent list and its history without showing Send; Forward restores Proposal 12 detail and its email ID in the URL. Returning to the list and switching to Drafts restores the prior selection of Proposal 1.

## thread-mail-007

Original test `thread email manager > restores the narrow transcript anchor once after two frames on each browser Back from mail detail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L634).

- **Given** On a 390-pixel-wide chat transcript, the user opens the email list and then Proposal 2 detail after positioning the transcript at a visible anchor offset of 275 pixels.
- **When** The user presses browser Back, waits through two animation frames, then repeats the Back/Forward navigation with the anchor at 475 pixels.
- **Then** On each Back, the transcript first becomes visible at scroll position zero, then after two frames restores the captured anchor to its prior screen position with exactly one scroll write to the captured offset. It does not write again on a third frame; Forward returns to detail and allows the next Back to capture and restore the new 475-pixel offset.

## thread-mail-008

Original test `thread email manager > leaves modified email-link activation to the browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L701).

- **Given** The email list is open and contains a link to Proposal 2.
- **When** The user activates the link with Ctrl held.
- **Then** The browser receives the modified activation without it being prevented; the list remains open and the link retains its email-detail destination.

## thread-mail-009

Original test `thread email manager > restores the owning pane and clears its filters when opening another pane's manager`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L722).

- **Given** A right-hand chat pane has an email detail opened from its list, with the Sent filter and Proposal 12 search; a left-hand pane is also available.
- **When** The user returns to the right-hand list, then opens Manage emails from the left-hand pane.
- **Then** The right-hand list restores its search. The left-hand manager opens for the left thread with an empty search and All selected, while the URL retains the right pane and changes the owning email thread to the left; the prior Sent filter and search are cleared.

## thread-mail-010

Original test `thread email manager > restores mail history ahead of another pane's utility sidebar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L769).

- **Given** A right-hand pane has an email list and detail history; the left-hand pane has an unavailable artifact in its utility sidebar.
- **When** The user opens the left-pane artifact, then presses browser Back twice.
- **Then** The first Back restores the email detail, and the second restores the email list without reopening the unavailable artifact sidebar.

## thread-mail-011

Original test `thread email manager > keeps a failed initial list read accessible`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L818).

- **Given** The initial email-list request fails with a forbidden response.
- **When** The user opens Manage emails.
- **Then** The list remains accessible and announces “Unable to load emails” as an alert.

## thread-mail-012

Original test `thread email manager > returns to the list while its read is pending and displays its failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L827).

- **Given** The user opens Proposal 2 detail, then the list request fails and remains pending.
- **When** The user returns to the email list before the request resolves, then releases the pending request.
- **Then** The list appears with a Loading emails status and the URL represents list view; after the failed request resolves, the list displays an alert.

## thread-mail-013

Original test `thread email manager > sends only drafts, retains failures for retry, and never resends successes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L846).

- **Given** Two drafts are selected for sending; the first send is pending and Proposal 2 initially fails to send.
- **When** The user confirms sending, attempts Escape and browser Back/Forward while sending is in progress, then retries after the first operation finishes.
- **Then** The confirmation’s Send and Cancel controls are disabled while pending and Escape does not dismiss it. Back leaves email-list navigation and Forward restores it; neither enables another send while the operation is pending. The result is 1 completed and 1 failed, with only Proposal 1 sent. Retrying after Proposal 2 becomes available sends it once, never resends the successful Proposal 1, and removes the draft selection controls and Send action when no drafts remain.

## thread-mail-014

Original test `thread email manager > reports uncertain Outlook sends as awaiting confirmation rather than completed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L898).

- **Given** An Outlook email draft is selected for sending; the service accepts the request but reports its status as sending.
- **When** The user confirms the send.
- **Then** The result reports 0 completed, 1 awaiting confirmation, and 0 failed. The refreshed list shows Sending and offers no selection checkbox for that email.

## thread-mail-015

Original test `thread email manager > confirms bulk deletion of drafts and keeps sent emails available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/thread-mail.test.tsx#L938).

- **Given** The email list contains two drafts and sent emails, and the drafts are selected.
- **When** The user cancels the first bulk-delete confirmation, then confirms a second one.
- **Then** Cancel deletes nothing. Confirming deletes both drafts, removes Proposal 1 from the list, and leaves sent Proposal 12 available; the Delete action is no longer shown.
