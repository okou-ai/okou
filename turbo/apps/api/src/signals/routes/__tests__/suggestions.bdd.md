# suggestions

## suggestions-001

- Vitest: "Agent suggestions > persists read receipts without consuming cards and finds unread cards beyond the displayed snapshot"
- Mode: run
- Given: A workspace member's personal Agent Run is executing with its Run token, and the member is signed in. The Agent has published 11 suggestion cards with priorities 0 to 10.
- When: The member reads `GET /api/feed/summary`, lists `GET /api/feed/items`, marks every displayed card read with `POST /api/feed/items/:id/read`, checks the summary, marks the lowest-priority overflow card read twice, checks the summary and list, and then the Agent publishes another card with `POST /api/feed/items`.
- Then: The summary reports unread before reading and still reports unread after only the displayed cards are read. Repeating the read on the overflow card returns the same `readAt`, after which the summary reports no unread and the list is unchanged (cards are not consumed). After the new card is published the summary reports unread again.

## suggestions-002

- Vitest: "Agent suggestions > keeps delivered cards when a source is disabled, persists partial source choices and resumes alerts when enabled"
- Mode: run
- Given: A workspace member's personal Agent Run is executing, the member is signed in, and the Agent has delivered one suggestion card.
- When: The member disables suggestions, offers and system updates with `PATCH /api/feed/sources`, then disables What's new separately, reads `GET /api/feed/sources` and the summary; the Agent tries to publish another card; the member re-enables suggestions; the Agent publishes again.
- Then: The first update returns suggestions, offers and system updates `false` with What's new still `true`; after the second update all four sources read back `false` and the summary reports no unread. The Agent's publish while disabled returns HTTP 403 and the list still shows only the original card. After re-enabling, the summary reports unread, the new publish returns HTTP 200 with status `active`, and the list has two cards.

## suggestions-003

- Vitest: "Agent suggestions > protects For you preferences and read receipts across owners"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card, and another user in the same organization is signed in.
- When: An unauthenticated caller reads `GET /api/feed/summary`; the Agent saves `offers: false` with `PATCH /api/feed/sources`; the other user marks the card read with `POST /api/feed/items/:id/read` and reads their own sources and summary.
- Then: The unauthenticated summary returns HTTP 401. The Agent's update returns HTTP 200 with offers `false`. The other user's read receipt returns HTTP 404, their sources are all `true`, and their summary reports no unread.

## suggestions-004

- Vitest: "Agent suggestions > pages management without hiding overflow cards or coupling their feedback"
- Mode: run
- Given: A workspace member's personal Agent Run has concurrently published 105 suggestion cards with priorities 0 to 104.
- When: The Agent pages `GET /api/feed/items/active` and follows `nextAfter`; the member lists the homepage `GET /api/feed/items`, sends concurrent `not_planned` feedback with `POST /api/feed/items/:id/suggestion/feedback` on two displayed cards, and lists again.
- Then: The first management page has 100 items and a `nextAfter`, the second has 5 items and no `nextAfter`, with 105 distinct IDs in total. The homepage shows priorities 104 down to 95. Both feedback requests return HTTP 200. The homepage again shows 10 items without those two cards, and its receipts include each card with one `not_planned` feedback whose context has that card's title and rationale.

## suggestions-005

- Vitest: "Agent suggestions > renews a card for 24 hours after an update"
- Mode: run
- Given: A workspace member's personal Agent Run publishes a card at a fixed time.
- When: One minute later the Agent updates the card with `PATCH /api/feed/items/:id` (priority 50 and a new title); the member lists cards at the original 24-hour mark and again one minute later.
- Then: The created card expires 24 hours after creation. The update returns an expiry 24 hours plus one minute after the start and keeps the original `createdAt`. The card is still listed at the 24-hour mark and the list is empty one minute later.

## suggestions-006

- Vitest: "Agent suggestions > honors an earlier deadline and caps a later deadline at 24 hours"
- Mode: run
- Given: A workspace member's personal Agent Run is executing at a fixed time.
- When: The Agent publishes a card expiring in one minute and one requesting expiry in 48 hours, shortens the second to two minutes with `PATCH /api/feed/items/:id`, and tries to publish a card that expired one second ago; after one minute the member lists cards, the Agent tries to raise the expired card's priority, and the member consumes the expired card's `review` option with `POST /api/feed/items/:id/suggestion/consume`; after two minutes the member lists again.
- Then: The 48-hour request is capped to expire 24 hours after the start, the update returns HTTP 200, and the past-deadline publish returns HTTP 400. At one minute the list contains only the second card. The update of the expired card returns HTTP 409, while the consume returns HTTP 200 with the card's options, status `consumed` and selected option `review`. At two minutes the list is empty.

## suggestions-007

- Vitest: "Agent suggestions > retains selected, dismissed and withdrawn feedback for 24 hours after processing"
- Mode: run
- Given: A workspace member's personal Agent Run has published three cards.
- When: One minute later the member consumes the first with option `review`, dismisses the second with `optionId: null`, and the Agent withdraws the third with `DELETE /api/feed/items/:id`; the Agent re-publishes the first card's ID; the member lists cards just before and exactly at 24 hours after processing.
- Then: The consumes return HTTP 200, the removal HTTP 204, and the re-publish HTTP 409. One millisecond before 24 hours the receipts contain the first card as `consumed` with `review`, the second as `consumed` with no option, and the third as `removed`. At 24 hours the receipts are empty.

## suggestions-008

- Vitest: "Agent suggestions > requires operator authentication for scheduled cleanup"
- Mode: run
- Given: The cron secret is configured and the caller sends no authorization.
- When: The caller requests `GET /api/cron/cleanup-suggestions`.
- Then: The request returns HTTP 401 with `{ error: { code: "UNAUTHORIZED", message: "Invalid cron secret" } }`.

## suggestions-009

- Vitest: "Agent suggestions > treats uppercase UUID aliases as the same one-time suggestion identity"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card, and the member has consumed it with option `review`.
- When: The Agent publishes a card with the same ID in upper case, and the member lists cards.
- Then: The consume returned the created card's ID. The upper-case publish returns HTTP 409 and the list is empty.

## suggestions-010

- Vitest: "Agent suggestions > consumes a canonical suggestion through an uppercase UUID path"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card with a lower-case UUID.
- When: The member consumes it with `POST /api/feed/items/:id/suggestion/consume` using the upper-case form of the ID and option `review`.
- Then: The request returns HTTP 200 with the card's canonical lower-case ID.

## suggestions-011

- Vitest: "Agent suggestions > rejects empty or whitespace-only suggestion drafts"
- Mode: run
- Given: A workspace member's personal Agent Run is executing.
- When: The Agent publishes a card whose only option draft is whitespace-only text, and another whose option has no draft message or attachments; the member lists cards.
- Then: Both publishes return HTTP 400 and the list is empty.

## suggestions-012

- Vitest: "Agent suggestions > lets a member read Suggestions and reserves publication for the personal Run"
- Mode: run
- Given: A workspace member's personal Agent Run is executing, and the member is signed in.
- When: The member tries to publish a card with `POST /api/feed/items` using their own session, then lists `GET /api/feed/items`.
- Then: The Run's system prompt does not contain a "# Suggestions feedback context" section. The member's publish returns HTTP 403 and the member's list returns HTTP 200.

## suggestions-013

- Vitest: "Agent suggestions > limits homepage display while managing all concurrent cards and consumes once without replay resurrection"
- Mode: run
- Given: A workspace member's personal Agent Run concurrently publishes 16 cards with priorities 0 to 15.
- When: The Agent and the member read `GET /api/feed/items/active`; the member lists `GET /api/feed/items`; the Agent retries the top card's publish; the member clicks the top card's `review` option twice concurrently; then the Agent retries the publish again, tries to update its priority, publishes a new card with priority 100, and the member lists again.
- Then: All 16 publishes return HTTP 200 and the Agent's management view lists 16 cards, while the member's management request returns HTTP 403. The homepage shows 10 cards in descending priority. The first retry returns HTTP 200. Of the two clicks one returns HTTP 200 (status `consumed`, option `review`, original options) and the other HTTP 409. The post-consume retry and update return HTTP 409, the new card returns HTTP 200, and the homepage shows 10 cards without the consumed card, which appears in receipts as `consumed`.

## suggestions-014

- Vitest: "Agent suggestions > updates one priority and preserves the terminal receipt after removal"
- Mode: run
- Given: A workspace member's personal Agent Run has published cards with priorities 0 and 20.
- When: The Agent raises the first card's priority to 30 with `PATCH /api/feed/items/:id`, lists cards, removes the first card with `DELETE /api/feed/items/:id`, and re-publishes its ID.
- Then: The update returns HTTP 200 and the list orders the first card before the second. The removal returns HTTP 204 and the re-publish returns HTTP 409.

## suggestions-015

- Vitest: "Agent suggestions > selects one of several options once and retains the choice in compacted receipts"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card with two options, `review` and `prepare` ("Prepare a draft").
- When: The member concurrently consumes the card with each option via `POST /api/feed/items/:id/suggestion/consume`; the Agent publishes another card; the member lists cards.
- Then: One consume returns HTTP 200 with the card's options, status `consumed` and that option selected; the other returns HTTP 409. The list's receipts contain the card with content removed (`null`), status `consumed`, the chosen option, and a single `option_selected` feedback whose context has the chosen option's label.

## suggestions-016

- Vitest: "Agent suggestions > rejects a removed option without consuming the card, then accepts dismissal with no selected option"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card and then replaced its options with only `prepare` via `PATCH /api/feed/items/:id`.
- When: The member consumes the removed `review` option, lists cards, then dismisses the card with `optionId: null`, and lists again.
- Then: Consuming `review` returns HTTP 409 and the card stays listed with no selected option. The dismissal returns HTTP 200 with status `consumed` and no selected option. The list then has no items, and receipts contain the card with content `null`, status `consumed`, no selected option, and a single `dismissed` feedback.

## suggestions-017

- Vitest: "Agent suggestions > returns the current draft for the chosen second option after a refresh"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card with options `review` and `prepare`, then updated the options so `prepare` is labelled "Prepare the updated draft" with a new draft text.
- When: The member consumes the card with option `prepare`.
- Then: The consume returns HTTP 200 with the updated options (including the new label and draft), status `consumed` and selected option `prepare`.

## suggestions-018

- Vitest: "Agent suggestions > requires one to three options with unique identities and a bounded payload"
- Mode: run
- Given: A workspace member's personal Agent Run is executing.
- When: The Agent publishes cards with no options, two options with the same ID, four options, and one option whose draft text is 65,536 characters; the member lists cards.
- Then: Each publish returns HTTP 400 and the list is empty.

## suggestions-019

- Vitest: "Agent suggestions > isolates owners and refuses a suggestion targeting another user's thread"
- Mode: run
- Given: A workspace member has created a chat thread, and their personal Agent Run has published a card whose option continues that thread. A second user in another workspace has their own executing personal Agent Run and is signed in.
- When: The second user lists cards with `GET /api/feed/items` and consumes the first user's card with `POST /api/feed/items/:id/suggestion/consume`; the second Agent updates the first user's card's priority with `PATCH /api/feed/items/:id`, publishes a card with an option targeting the first user's thread with `POST /api/feed/items`, publishes its own card, and updates it with `PATCH /api/feed/items/:id` to add an option targeting that thread; the second user lists cards again; then the first user lists their cards.
- Then: The second user's list is empty and their consume returns HTTP 409. The second Agent's update of the foreign card returns HTTP 409, the publish targeting the foreign thread returns HTTP 404, its own card publishes with HTTP 200, and the retargeting update returns HTTP 404; the second user's list still shows its card with the original options. The first user still sees exactly one card, their own.

## suggestions-020

- Vitest: "Agent suggestions > lets a custom direction continue only its owner's thread"
- Mode: run
- Given: A workspace member has created a chat thread, and their personal Agent Run has published a card whose custom direction continues that thread. A second user in another workspace has their own executing personal Agent Run.
- When: The first user lists cards; the second Agent publishes a card whose custom direction targets the first user's thread, publishes a plain card, and updates that card's custom direction to the first user's thread; the second user lists cards.
- Then: The first user's card shows the custom direction's thread ID. The second Agent's targeted publish returns HTTP 404, the plain publish returns HTTP 200, and the retargeting update returns HTTP 404, so the second user's card keeps its original custom direction.

## suggestions-021

- Vitest: "Agent suggestions > returns the original target and canonical draft when its thread was deleted after publication"
- Mode: run
- Given: A workspace member has created a chat thread, their personal Agent Run has published a card whose `review` option targets that thread, and the member then deletes the thread with `DELETE /api/chat-threads/:id`.
- When: The member consumes the card with option `review`, then lists cards.
- Then: The thread deletion returns HTTP 204. The consume returns HTTP 200 with the original options (including the deleted thread target and draft), status `consumed` and option `review`. The list is empty.

## suggestions-022

- Vitest: "Suggestion custom follow-ups > rejects executable custom drafts and reserves the custom option identity"
- Mode: run
- Given: A workspace member's personal Agent Run is executing.
- When: The Agent publishes cards whose custom option draft is an executable text draft, or a feedback quote with an instruction note, and a card that has a regular option with the reserved ID `custom`; the member lists cards.
- Then: All three publishes return HTTP 400 and the list is empty.

## suggestions-023

- Vitest: "Suggestion custom follow-ups > keeps the card until a complete follow-up is accepted and repairs the receipt on replay"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card whose custom direction quotes background facts, and the member has created a chat thread.
- When: The member consumes the card's `custom` option directly; then sends `POST /api/chat/events` in the thread with the card's suggestion context and the quoted background but no note; again with an extra reference to a missing project; then with a note but a truncated quote; then twice with the complete quote and the note "Assess the risks before choosing what to do"; and lists cards.
- Then: The direct consume returns HTTP 409. The message without a note returns HTTP 400, the missing-project message HTTP 404, and the card is still listed. The truncated quote returns HTTP 409. Both complete sends return HTTP 201. The list then has no items, and the receipts contain the card as `consumed` with option `custom` and a `custom_sent` feedback whose choice is the note and whose context has the card's title and rationale.

## suggestions-024

- Vitest: "Suggestion custom follow-ups > rejects stale custom context without consuming the updated suggestion"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card, and the member has created a chat thread.
- When: The member sends `POST /api/chat/events` in the thread with a suggestion context for the card's `custom` option carrying an outdated context version, a quoted background and a note.
- Then: The send returns HTTP 409 and the card is still listed.

## suggestions-025

- Vitest: "Suggestion custom follow-ups > checks every quoted card in one follow-up, including an uppercase UUID alias"
- Mode: run
- Given: A workspace member's personal Agent Run has published two cards, and the member has created a chat thread.
- When: The member sends one `POST /api/chat/events` follow-up quoting both cards' custom directions (the second referenced by its upper-case ID) with an outdated context version for the second card, then sends it again with the current version for both.
- Then: The first send returns HTTP 409 and both cards remain listed. The second send returns HTTP 201, after which no cards are listed and receipts show both cards as `consumed` with option `custom`.

## suggestions-026

- Vitest: "Suggestion custom follow-ups > can send a saved complete quote after its disposable card has been dismissed and compacted"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card with a quoted custom background, the member has dismissed it with `optionId: null`, and the Agent has published another card so the dismissed card is compacted into a receipt. The member has saved a complete quote with the card's suggestion context.
- When: The member creates a chat thread and sends `POST /api/chat/events` with the saved suggestion context, quote and a note.
- Then: The send returns HTTP 201, and the receipts still show the card as `consumed` with no selected option.

## suggestions-027

- Vitest: "Suggestion custom follow-ups > keeps selection receipts restricted to a member session"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card, and the member has created a chat thread.
- When: The Agent, using its Run token, sends `POST /api/chat/events` in that thread with the card's current custom suggestion context, the quoted background and the note "Review the risks".
- Then: The send returns HTTP 201, but the card is not consumed: the member's list still contains one card.

## suggestions-028

- Vitest: "Suggestion feedback receipts > keeps feedback private, accepts retries and reason edits, and restores a valid card on undo"
- Mode: run
- Given: A workspace member's personal Agent Run has published a card. Another member of the same organization is also present.
- When: The member sends `not_planned` feedback with `POST /api/feed/items/:id/suggestion/feedback` twice with the same feedback ID and a card snapshot, lists cards, adds a `reason` feedback targeting it, and lists again; the other member lists cards and tries to undo the feedback; then the original member undoes it with the snapshot.
- Then: Both feedback requests return HTTP 200; the list has no items and the receipt holds exactly one `not_planned` feedback with that ID, no `learnedAt`, and the card's title and rationale. The reason returns HTTP 200 and appears in the receipt with its target and note "A teammate owns these reviews". The other member sees no items or receipts and their undo returns HTTP 409. The owner's undo returns HTTP 200 with `restored` true, and the card is listed again with status `active`.
