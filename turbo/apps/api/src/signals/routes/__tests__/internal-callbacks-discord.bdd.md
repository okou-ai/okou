# internal-callbacks-discord

## internal-callbacks-discord-001

- Vitest: "lazy Discord reply threads > keeps typing in the source channel and creates a thread only for an actual channel reply"
- Mode: run
- Given: A signed event for a linked Discord member starts a run from a top-level guild channel.
- When: The member waits through a Runner heartbeat at nine seconds and then the Runner submits successful completion twice.
- Then: Typing stays exclusively on the original source up to completion and no reply is sent at heartbeat. No thread is created until the actual final reply, which goes to the newly created thread. Exactly one native message contains the answer even after a repeated completion.

## internal-callbacks-discord-002

- Vitest: "lazy Discord reply threads > keeps typing in the source thread and creates a thread only for an actual channel reply"
- Mode: run
- Given: A signed event for a linked Discord member starts a run in an existing guild thread.
- When: The member waits through a Runner heartbeat at nine seconds and then the Runner submits successful completion twice.
- Then: Typing stays exclusively on the original source up to completion and no reply is sent at heartbeat. The existing thread is reused for the final answer. Exactly one native message contains the answer even after a repeated completion.

## internal-callbacks-discord-003

- Vitest: "lazy Discord reply threads > keeps typing in the source dm and creates a thread only for an actual channel reply"
- Mode: run
- Given: A signed event for a linked Discord member starts a run in an existing bot DM.
- When: The member waits through a Runner heartbeat at nine seconds and then the Runner submits successful completion twice.
- Then: Typing stays exclusively on the original source up to completion and no reply is sent at heartbeat. The reply stays in the existing DM. Exactly one native message contains the answer even after a repeated completion.

## internal-callbacks-discord-004

- Vitest: "lazy Discord reply threads > delivers the next DM reply once to the moved physical channel"
- Mode: run
- Given: A Discord member received a previous answer in their original bot DM. That physical DM disappears and the same member's bot opens a new DM channel.
- When: The Gateway delivers their next personal message from the new channel, and the Runner posts and replays a successful completion.
- Then: The request is accepted, the same Okou thread and Claude model remain, and its second input cites the new Discord DM message URL. The new run receives the new prompt and marks a completion event. Discord receives the first answer in the old channel and one new answer in the new channel, with no replay duplicate.

## internal-callbacks-discord-005

- Vitest: "lazy Discord reply threads > reuses a thread created by the user while the answer is being prepared"
- Mode: run
- Given: A guild channel message starts a Discord run. The user creates a native reply thread while the answer is being prepared, and the sender lacks parent-channel send permission.
- When: The Runner completes the run.
- Then: Discord receives one reply in the existing user-created thread and its name stays unchanged.

## internal-callbacks-discord-006

- Vitest: "lazy Discord reply threads > recovers the first reply when the thread is created concurrently"
- Mode: run
- Given: A top-level Discord channel message has started a run. At completion, a concurrent thread creation causes Discord to report `Thread already exists`.
- When: The Runner submits the final answer.
- Then: Provider-side discovery recovers the same native reply thread. There is one thread and one Discord answer in that thread.

## internal-callbacks-discord-007

- Vitest: "lazy Discord reply threads > recovers the first reply when the thread is create response lost"
- Mode: run
- Given: A top-level Discord channel message has started a run. At completion, Discord creates the reply thread but the network drops its creation response.
- When: The Runner submits the final answer.
- Then: Provider-side discovery recovers the same native reply thread. There is one thread and one Discord answer in that thread.

## internal-callbacks-discord-008

- Vitest: "lazy Discord reply threads > retries a rate-limited thread creation before sending the reply once"
- Mode: run
- Given: A guild channel run needs a new reply thread. Its initial thread creation attempt returns HTTP 429 with immediate retry eligibility.
- When: The Runner submits the final answer.
- Then: Thread creation recovers and Discord receives precisely one reply in the resulting thread.

## internal-callbacks-discord-009

- Vitest: "lazy Discord reply threads > moves typing and the final reply to the thread opened by an in-run message"
- Mode: run
- Given: A top-level channel run is active and its Runner holds a native integration token.
- When: The Runner sends an in-progress update to the run's native destination, heartbeats after nine seconds, and completes with the final answer.
- Then: The update returns HTTP 200 with a receipt for the new native thread. Typing refresh moves to that thread, and both update and final reply are sent there.

## internal-callbacks-discord-010

- Vitest: "canonical Discord terminal replies > recovers a model failure through a private native selector"
- Mode: run
- Given: A Discord DM run commits a failure with `account_verification_required`. The error includes a native model recovery control.
- When: Someone other than the owner tries the signed interaction. The owner opens the private selector, selects Auto, then replays the same menu with a different model.
- Then: The other sender and replay get `no longer current`. The owner gets an ephemeral deferred acknowledgement and a menu with Auto. Saving says `Switched to Auto`, the thread's model becomes `auto`, a distinct run has a `continue` input, and typing resumes. The public provider message count remains one.

## internal-callbacks-discord-011

- Vitest: "canonical Discord terminal replies > delivers canonical output after a long task to the native thread exactly once"
- Mode: run
- Given: An authenticated Runner works on a linked Discord thread task for sixteen minutes.
- When: The Runner submits successful completion with the result.
- Then: The original native thread receives one reply with the exact result text and Okou's thread contains a `run.completed` event for that run.

## internal-callbacks-discord-012

- Vitest: "canonical Discord terminal replies > keeps canonical completion without sending or replaying a reply when Discord access fails with 502"
- Mode: run
- Given: Discord's lookup of the destination channel returns HTTP 502 during completion of an already dispatched run.
- When: The Runner sends answer and system events, then submits the same terminal completion twice.
- Then: Events and both completions return HTTP 200. No Discord reply is sent and Okou exposes one `run.completed` event.

## internal-callbacks-discord-013

- Vitest: "canonical Discord terminal replies > delivers a long reply in order to the original destination"
- Mode: run
- Given: A linked Discord thread run has a final answer larger than Discord's individual message capacity.
- When: The Runner successfully completes with the long answer.
- Then: Discord receives multiple chunks in the original native destination, and concatenating them in delivery order exactly reproduces the answer.

## internal-callbacks-discord-014

- Vitest: "canonical Discord terminal replies > delivers the canonical safe run error without exposing the internal failure"
- Mode: run
- Given: A Discord run is active and the Runner reports an internal execution error.
- When: The Runner submits failure and the user reads their conversation events.
- Then: One `run.failed` event supplies safe canonical error text. Exactly one Discord reply includes that safe text. Neither exposes the internal diagnostic.

## internal-callbacks-discord-015

- Vitest: "canonical Discord terminal replies > offers billing recovery when a running Discord task runs out of credits"
- Mode: run
- Given: The Runner stops executing a Discord task because the workspace has insufficient credits.
- When: The Runner submits failed completion with the structured insufficient-credits reason.
- Then: Discord receives exactly one reply containing `Insufficient credits` and a link to billing settings.

## internal-callbacks-discord-016

- Vitest: "canonical Discord terminal replies > delivers cancellation before queued Run dispatch"
- Mode: run
- Given: A connected Discord member started a run that is queued for dispatch.
- When: The member cancels through the public Run API before dispatch occurs.
- Then: Cancellation returns HTTP 200. Exactly one Discord reply communicates cancellation.

## internal-callbacks-discord-017

- Vitest: "canonical Discord terminal replies > delivers a queued admission failure once without launching another run"
- Mode: run
- Given: An active Discord run has a single queued follow-up prompt without a Run ID. The owner deletes the personal Claude provider before the first run ends.
- When: The Runner completes the first run and the member reads the thread.
- Then: The follow-up is rejected with no Run ID and has one canonical output error. No second Run is present, and Discord receives just one notice containing exactly the canonical error.

## internal-callbacks-discord-018

- Vitest: "canonical Discord terminal replies > suppresses a final reply after binding revocation without losing canonical completion"
- Mode: run
- Given: A Discord run is already executing with a valid sandbox token. Before completion, the owner disconnects the integration binding.
- When: The Runner successfully completes and the member reads their Okou conversation.
- Then: The canonical `run.completed` event is visible for the run, and Discord receives no reply.

## internal-callbacks-discord-019

- Vitest: "canonical Discord terminal replies > suppresses a final reply after channel revocation without losing canonical completion"
- Mode: run
- Given: A Discord run is already executing with a valid sandbox token. Before completion, Discord denies the native channel.
- When: The Runner successfully completes and the member reads their Okou conversation.
- Then: The canonical `run.completed` event is visible for the run, and Discord receives no reply.

## internal-callbacks-discord-020

- Vitest: "canonical Discord terminal replies > suppresses a final reply after dm-recipient revocation without losing canonical completion"
- Mode: run
- Given: A Discord run is already executing with a valid sandbox token. Before completion, the bot DM's recipient changes to another Discord user.
- When: The Runner successfully completes and the member reads their Okou conversation.
- Then: The canonical `run.completed` event is visible for the run, and Discord receives no reply.

## internal-callbacks-discord-021

- Vitest: "canonical Discord terminal replies > delivers the final reply after the thread auto-archives during the run"
- Mode: run
- Given: The native Discord thread auto-archives without locking while its run is active.
- When: The Runner successfully completes with the answer.
- Then: Discord receives one answer in the original archived thread.

## internal-callbacks-discord-022

- Vitest: "canonical Discord terminal replies > delivers into a thread locked during the run only for a MANAGE_THREADS member"
- Mode: run
- Given: A native Discord thread is archived and locked while a member's run is active. The bot has administrator privileges and the sender lacks Manage Threads.
- When: The Runner submits successful completion.
- Then: The Okou thread shows the canonical completion. There is no native reply.

## internal-callbacks-discord-023

- Vitest: "canonical Discord terminal replies > delivers into a thread locked during the run only for a MANAGE_THREADS moderator"
- Mode: run
- Given: A native Discord thread is archived and locked while a member's run is active. The bot has administrator privileges and the sender has Manage Threads.
- When: The Runner submits successful completion.
- Then: The Okou thread shows the canonical completion. Discord receives one native reply.

## internal-callbacks-discord-024

- Vitest: "canonical Discord terminal replies > launches a queued follow-up after the thread auto-archives"
- Mode: run
- Given: A connected Discord member posts a follow-up while the first thread run is active, and the native thread auto-archives without locking before the first run completes.
- When: The Runner completes the first run.
- Then: Discord receives one reply, the member sees no input rejection, and the thread has launched two distinct Run IDs in input order.

## internal-callbacks-discord-025

- Vitest: "canonical Discord terminal replies > keeps a revoked pending active input queued until the next pick rejects it"
- Mode: run
- Given: A Discord follow-up is queued while the original run executes. The Runner has not yet read that input. The user then disconnects the binding.
- When: The authenticated Runner polls twice for steerable input, completes its original Run, and the user reads the active and final thread projections.
- Then: Each post-revocation poll returns null input and the still-running thread shows no rejection yet. Completion triggers one `discord_access_revoked` rejection and a matching safe error, without a new Run ID or any Discord reply.

## internal-callbacks-discord-026

- Vitest: "canonical Discord terminal replies > keeps a revoked read active input queued until the next pick rejects it"
- Mode: run
- Given: A Discord follow-up is queued while the original run executes. The Runner previously read the queued prompt and it contained the follow-up details. The user then disconnects the binding.
- When: The authenticated Runner polls twice for steerable input, completes its original Run, and the user reads the active and final thread projections.
- Then: Each post-revocation poll returns null input and the still-running thread shows no rejection yet. Completion triggers one `discord_access_revoked` rejection and a matching safe error, without a new Run ID or any Discord reply.

## internal-callbacks-discord-027

- Vitest: "canonical Discord terminal replies > reads each provider resource once per active input in a thread"
- Mode: run
- Given: A connected Discord member queues a follow-up inside a guild thread. The provider's Message Content access is enabled.
- When: The Runner reads steerable input for the active run and the provider boundary observes the reads.
- Then: The next prompt contains the follow-up text. The earlier readable history is included. The read makes eight distinct Discord GET requests with no duplicate URL, plus one Clerk organization membership request.

## internal-callbacks-discord-028

- Vitest: "canonical Discord terminal replies > reads each provider resource once per active input in a dm"
- Mode: run
- Given: A connected Discord member queues a follow-up inside a bot DM. The provider's Message Content access is enabled.
- When: The Runner reads steerable input for the active run and the provider boundary observes the reads.
- Then: The next prompt contains the follow-up text. Earlier DM history is excluded. The read makes two distinct Discord GET requests with no duplicate URL, plus one Clerk organization membership request.

## internal-callbacks-discord-029

- Vitest: "canonical Discord terminal replies > handles a current MESSAGE_CONTENT lookup returning 403 without losing the queued input"
- Mode: run
- Given: A member has a Discord thread run in progress and a follow-up queued, and Discord's application lookup for Message Content responds with HTTP 403.
- When: The Runner polls for the next steerable input, then retries when the lookup succeeds.
- Then: The initial API response is HTTP 500. The retry still returns the same pending prompt with readable history, rather than consuming it as if content access were disabled.

## internal-callbacks-discord-030

- Vitest: "canonical Discord terminal replies > handles a current MESSAGE_CONTENT lookup returning 404 without losing the queued input"
- Mode: run
- Given: A member has a Discord thread run in progress and a follow-up queued, and Discord's application lookup for Message Content responds with HTTP 404.
- When: The Runner polls for the next steerable input, then retries when the lookup succeeds.
- Then: The initial API response is HTTP 500. The retry still returns the same pending prompt with readable history, rather than consuming it as if content access were disabled.

## internal-callbacks-discord-031

- Vitest: "canonical Discord terminal replies > handles a current MESSAGE_CONTENT lookup returning 429 without losing the queued input"
- Mode: run
- Given: A member has a Discord thread run in progress and a follow-up queued, and Discord's application lookup for Message Content responds with HTTP 429.
- When: The Runner polls for the next steerable input, then retries when the lookup succeeds.
- Then: The initial API response is HTTP 500. The retry still returns the same pending prompt with readable history, rather than consuming it as if content access were disabled.

## internal-callbacks-discord-032

- Vitest: "canonical Discord terminal replies > handles a current MESSAGE_CONTENT lookup returning 502 without losing the queued input"
- Mode: run
- Given: A member has a Discord thread run in progress and a follow-up queued, and Discord's application lookup for Message Content responds with HTTP 502.
- When: The Runner polls for the next steerable input, then retries when the lookup succeeds.
- Then: The initial API response is HTTP 500. The retry still returns the same pending prompt with readable history, rather than consuming it as if content access were disabled.

## internal-callbacks-discord-033

- Vitest: "canonical Discord terminal replies > rechecks organization membership on each active-input delivery"
- Mode: run
- Given: A connected Discord member has a follow-up that the Runner could previously read. Before its next delivery, the user loses Okou organization membership.
- When: The Runner polls again for the same active input.
- Then: The endpoint returns exactly `input: null`, so no prompt is disclosed after the authorization change.

## internal-callbacks-discord-034

- Vitest: "canonical Discord terminal replies > rechecks guild membership on each active-input delivery"
- Mode: run
- Given: A connected Discord member has a follow-up that the Runner could previously read. Before its next delivery, Discord removes the sender from the guild.
- When: The Runner polls again for the same active input.
- Then: The endpoint returns exactly `input: null`, so no prompt is disclosed after the authorization change.

## internal-callbacks-discord-035

- Vitest: "canonical Discord terminal replies > rechecks source view on each active-input delivery"
- Mode: run
- Given: A connected Discord member has a follow-up that the Runner could previously read. Before its next delivery, Discord view permissions are removed for the source.
- When: The Runner polls again for the same active input.
- Then: The endpoint returns exactly `input: null`, so no prompt is disclosed after the authorization change.

## internal-callbacks-discord-036

- Vitest: "canonical Discord terminal replies > rechecks private thread membership on each active-input delivery"
- Mode: run
- Given: A connected Discord member has a follow-up that the Runner could previously read. Before its next delivery, Discord stops confirming membership in the source private thread.
- When: The Runner polls again for the same active input.
- Then: The endpoint returns exactly `input: null`, so no prompt is disclosed after the authorization change.

## internal-callbacks-discord-037

- Vitest: "canonical Discord terminal replies > drops previously read history when the current history permission is revoked"
- Mode: run
- Given: A queued Discord follow-up initially yields its current text and earlier history to the Runner. Then the sender loses the channel history permission.
- When: The Runner reads that input again, acknowledges it, and completes the run.
- Then: The current input is still steerable, earlier history is removed, and the returned prompt explains the current Discord permissions.

## internal-callbacks-discord-038

- Vitest: "canonical Discord terminal replies > drops previously read history when the current message-content grant is revoked"
- Mode: run
- Given: A queued Discord follow-up initially yields its current text and earlier history to the Runner. Then the Discord app loses its Message Content grant.
- When: The Runner reads that input again, acknowledges it, and completes the run.
- Then: The current input is still steerable, earlier history is removed, and the returned prompt explains `MESSAGE_CONTENT is unavailable`.

## internal-callbacks-discord-039

- Vitest: "canonical Discord terminal replies > does not retry a reply that Discord rate-limits"
- Mode: run
- Given: An already authorized terminal Discord reply gets HTTP 429 from the provider when posting, with a retry delay.
- When: The Runner completes the task and the owner reads the thread.
- Then: The bot attempts one send, no message is delivered, and the canonical completion event is retained.

## internal-callbacks-discord-040

- Vitest: "canonical Discord terminal replies > sends each part once and stops at the first part Discord does not accept"
- Mode: run
- Given: A long Discord answer requires multiple chunks, but Discord returns HTTP 502 when posting the second chunk.
- When: The Runner submits successful completion with the long text.
- Then: Exactly two provider sends are attempted. The first part is delivered, and no more parts or retries are sent.

## internal-callbacks-discord-041

- Vitest: "canonical Discord terminal replies > does not repeat a lost send whose response never arrived"
- Mode: run
- Given: Discord commits a native reply but its network response is lost.
- When: The Runner completes the run with the answer.
- Then: There is one provider send request and one actual Discord message, with no repeat of the ambiguous send.

## internal-callbacks-discord-042

- Vitest: "Discord processing status > shows typing on admission and refreshes it from Runner heartbeats until the reply"
- Mode: run
- Given: A connected Discord thread run starts typing on admission and remains in progress.
- When: The Runner heartbeats after nine seconds, completes the run, then heartbeats again.
- Then: Typing is only in the source, refresh adds one typing event, and HTTP 200 advertises a six-second refresh. One reply is delivered. Subsequent heartbeat is HTTP 404 and does not refresh typing.

## internal-callbacks-discord-043

- Vitest: "Discord processing status > keeps typing fresh when the first heartbeat arrives after 500 ms"
- Mode: run
- Given: A Discord run starts with successful typing on admission. The Runner's first heartbeat arrives after 500 ms.
- When: The Runner heartbeats then returns six seconds later for the next refresh and completes the run.
- Then: The first heartbeat does not repeat the fresh typing request. The response advertises a six-second refresh interval. The next heartbeat refreshes typing once and the final Discord reply is delivered.

## internal-callbacks-discord-044

- Vitest: "Discord processing status > keeps typing fresh when the first heartbeat arrives after 4000 ms"
- Mode: run
- Given: A Discord run starts with successful typing on admission. The Runner's first heartbeat arrives after 4,000 ms.
- When: The Runner heartbeats then returns six seconds later for the next refresh and completes the run.
- Then: The first heartbeat adds one typing request. The response advertises a six-second refresh interval. The next heartbeat refreshes typing once and the final Discord reply is delivered.

## internal-callbacks-discord-045

- Vitest: "Discord processing status > recovers a server typing failure at the first heartbeat"
- Mode: run
- Given: The initial typing request for a Discord thread run fails because of HTTP 500.
- When: The provider recovers before the first Runner heartbeat four seconds later, and the Runner then completes the run.
- Then: The first heartbeat causes one effective typing refresh to the source thread and the final answer is delivered.

## internal-callbacks-discord-046

- Vitest: "Discord processing status > recovers a network typing failure at the first heartbeat"
- Mode: run
- Given: The initial typing request for a Discord thread run fails because of a network failure.
- When: The provider recovers before the first Runner heartbeat four seconds later, and the Runner then completes the run.
- Then: The first heartbeat causes one effective typing refresh to the source thread and the final answer is delivered.

## internal-callbacks-discord-047

- Vitest: "Discord processing status > shows typing when a queued Discord follow-up is admitted and when it launches"
- Mode: run
- Given: An active Discord run already has typing displayed in its source thread.
- When: A signed follow-up arrives after nine seconds and is queued. Another nine seconds later the Runner completes the original run.
- Then: Admission of the queued input refreshes typing once. Completion sends one first-run reply and launches one new run, which refreshes typing once again in the same thread.

## internal-callbacks-discord-048

- Vitest: "Discord processing status > delivers the reply when Discord rejects typing with HTTP 403"
- Mode: run
- Given: A Discord run is executing but the provider rejects every typing request with HTTP 403.
- When: The Runner attempts a typing refresh and completes the run.
- Then: There are no successful typing events. Exactly one final reply is delivered despite provider typing failure.

## internal-callbacks-discord-049

- Vitest: "Discord processing status > delivers the reply when Discord rejects typing with HTTP 500"
- Mode: run
- Given: A Discord run is executing but the provider rejects every typing request with HTTP 500.
- When: The Runner attempts a typing refresh and completes the run.
- Then: There are no successful typing events. Exactly one final reply is delivered despite provider typing failure.

## internal-callbacks-discord-050

- Vitest: "Discord processing status > waits out a typing rate limit without delaying the reply"
- Mode: run
- Given: The first Discord typing request returns HTTP 429 with a sixty-second retry window.
- When: The Runner heartbeats after nine seconds, waits another sixty seconds, heartbeats again, and completes the task.
- Then: The first heartbeat makes no repeat typing request during backoff. The next one makes the second typing attempt successfully and completion delivers one reply.

## internal-callbacks-discord-051

- Vitest: "Discord processing status > stops typing after binding revocation"
- Mode: run
- Given: A Discord run has been admitted, then the user disconnects the binding before the first heartbeat refresh.
- When: The Runner heartbeats after nine seconds.
- Then: The heartbeat succeeds without making a Discord typing request.

## internal-callbacks-discord-052

- Vitest: "Discord processing status > stops typing after member revocation"
- Mode: run
- Given: A Discord run has been admitted, then Discord denies the user's membership before the first heartbeat refresh.
- When: The Runner heartbeats after nine seconds.
- Then: The heartbeat succeeds without making a Discord typing request.

## internal-callbacks-discord-053

- Vitest: "Discord processing status > stops typing after binding revocation while permission reuse is warm"
- Mode: run
- Given: A Discord run has verified typing permissions and its second heartbeat reuses them within 45 seconds. The user then disconnects while that permission reuse is still warm.
- When: The Runner sends another heartbeat before reuse would otherwise expire.
- Then: The public integration status shows disconnected and clears the guild and Discord user IDs. Heartbeat still advertises the six-second refresh interval, but there is no new provider typing request.

## internal-callbacks-discord-054

- Vitest: "Discord processing status > refreshes typing without repeating Discord permission reads inside the reuse window"
- Mode: run
- Given: A Discord run's first refresh reads current provider channel permissions.
- When: The Runner heartbeats nine seconds later during the 45-second reuse window, then heartbeats again after the window.
- Then: The within-window refresh issues typing with no additional channel reads. Once the window elapses, the provider channel permissions are read again.

## internal-callbacks-discord-055

- Vitest: "Discord processing status > stops typing after member revocation once the reuse window ends"
- Mode: run
- Given: A running Discord task already has reused typing authorization and the sender later loses guild membership.
- When: The Runner heartbeats after that 45-second reuse period expires, then heartbeats again after nine seconds.
- Then: Neither post-expiry heartbeat adds a typing event.

## internal-callbacks-discord-056

- Vitest: "Discord processing status > pauses all typing after a rate limit on a Discord permission read"
- Mode: run
- Given: A Discord thread run's provider permission lookup returns HTTP 429 with a thirty-second retry delay.
- When: A second task is admitted in another channel during the pause. The original Runner heartbeats during the pause and after it ends, then completes.
- Then: There is a permission lookup attempt but no added typing on either conversation during the pause. A heartbeat after the limit expires adds one typing event, and the original task still delivers its answer.
