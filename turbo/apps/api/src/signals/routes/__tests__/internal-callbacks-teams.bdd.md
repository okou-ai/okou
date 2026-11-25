# internal-callbacks-teams

## internal-callbacks-teams-001

- Vitest: "Teams chat callbacks > steers queued Teams personal input into the dispatched Run"
- Mode: run
- Given: An onboarded, paid, connected Teams member has an active Runner execution for a personal message. Its steerable input read initially returns null.
- When: The member sends another personal message while the run is active. The Runner reads and acknowledges the pending input, then completes the original run.
- Then: The Runner receives the new event ID and prompt with current tenant, personal conversation, current activity and thread IDs. It contains neither the first activity ID nor team or channel IDs. Acknowledging returns `steered`, later input reads null, and the run reads as completed.

## internal-callbacks-teams-002

- Vitest: "Teams chat callbacks > terminalizes owned Teams accepted dispatch after a test-body failure"
- Mode: run
- Intent: review
- Given: The owned Teams test fixture has an installed bot and a connected member. The fixture accepts a personal message without assigning the Run to a Runner.
- When: The test body throws a controlled error and fixture cleanup runs.
- Then: The test error is propagated. The public run log reads one running entry before cleanup and the same entry cancelled afterwards. Integration status stays installed and connected with the same tenant.

## internal-callbacks-teams-003

- Vitest: "Teams chat callbacks > terminalizes owned Teams dispatched Run after a test-body failure"
- Mode: run
- Intent: review
- Given: The owned Teams test fixture has an installed bot and a connected member. The fixture accepts a personal message and the Runner has already picked up execution.
- When: The test body throws a controlled error and fixture cleanup runs.
- Then: The test error is propagated. The public run log reads one running entry before cleanup and the same entry cancelled afterwards. Integration status stays installed and connected with the same tenant.

## internal-callbacks-teams-004

- Vitest: "Teams chat callbacks > preserves queued Teams stored context"
- Mode: run
- Given: A connected Teams member has a running personal message which occupies the conversation, and the next signed message is queued.
- When: The Runner completes the first run and requests the newly launched run's execution.
- Then: The new prompt equals the queued text. The system context carries its tenant ID and name, Teams app ID, personal conversation and current activity IDs, and the sender's display name, user principal name and Teams ID, with no channel or team fields.

## internal-callbacks-teams-005

- Vitest: "Teams chat callbacks > preserves queued Teams published launch material"
- Mode: run
- Given: A connected Teams member's second personal message is queued while the first runs.
- When: The Runner finishes the first and reads the execution and public Run record for the second.
- Then: The launch prompt matches the stored run prompt. Its system context identifies Microsoft Teams and the new message's activity ID as its thread ID.

## internal-callbacks-teams-006

- Vitest: "Teams chat callbacks > delivers queued Teams admission failures with launch material"
- Mode: run
- Given: A Teams member's queued personal message has its own activity ID and the workspace plan is cancelled before the currently running message completes.
- When: The Runner posts successful completion with its sandbox bearer token to `POST /api/webhooks/run/complete`, then repeats it.
- Then: Both callbacks return HTTP 200 with the same successful completed response. Teams receives one `Add credits` reply to the queued activity in the original personal conversation. Run logs contain no run for the queued prompt before or after replay, and replay sends no more replies.

## internal-callbacks-teams-007

- Vitest: "Teams chat callbacks > uses installation bot identity when the activity omits it"
- Mode: run
- Given: A Teams member has an active personal run and the next signed Teams message lacks a recipient object.
- When: The first run completes and the next run is launched.
- Then: The Runner receives the queued text and system context with the installed bot's ID and name `Nova`.

## internal-callbacks-teams-008

- Vitest: "Teams chat callbacks > resumes the forked thread after forking a personal message thread"
- Mode: run
- Given: A connected Teams user completes a main DM run and a separate personal reply-thread run with different native session IDs.
- When: The same user sends a new activity in the forked thread after both runs finish and the Runner reads the launched input.
- Then: The Runner receives the native continuation ID belonging to the forked reply thread.

## internal-callbacks-teams-009

- Vitest: "Teams chat callbacks > resumes the main session after forking a personal message thread"
- Mode: run
- Given: A connected Teams user completes a main DM run and a separate personal reply-thread run with different native session IDs.
- When: The same user sends an unthreaded message in their main DM after both runs finish and the Runner reads the launched input.
- Then: The Runner receives the native continuation ID belonging to the original main DM.

## internal-callbacks-teams-010

- Vitest: "Teams chat callbacks > preserves Teams canonical input"
- Mode: run
- Given: A connected workspace admin can send signed Teams channel activities and has debug visibility.
- When: Teams delivers a bot mention for a threaded task and the admin reads new Okou thread events and messages.
- Then: A created thread has cloud browser enabled. The canonical input reads back with null legacy content and a version 1 message containing the normalized `@Nova` text followed by a Teams source link with channel, activity and tenant identifiers.

## internal-callbacks-teams-011

- Vitest: "Teams chat callbacks > preserves Teams completed delivery"
- Mode: run
- Given: A connected admin sends a signed Teams channel mention that produces a canonical input with text and a Teams source link.
- When: The Runner heartbeats with the sandbox token and then completes the run successfully.
- Then: Heartbeat makes no Teams token, activity or reaction requests. Completion uses installed bot credentials and sends one Markdown reply `Task completed successfully.` to the original activity and tenant. It removes the thought-bubble reaction, stores the same output message in the Okou thread, and sends the original task text to the summary provider.

## internal-callbacks-teams-012

- Vitest: "Teams chat callbacks > participant callbacks > delivers a reply naming the new participant with a fresh summary"
- Mode: run
- Given: One connected participant has completed a run in a Teams channel thread. A second connected workspace participant named Grace Hopper has their own model preference.
- When: The second participant posts a follow-up into the same external thread and completes their run.
- Then: Teams receives a second reply naming Grace Hopper. The summary provider receives a new summary request whose user content includes the follow-up text.

## internal-callbacks-teams-013

- Vitest: "Teams chat callbacks > participant callbacks > starts a fresh native context for the new participant"
- Mode: run
- Given: A Teams channel thread contains a completed native session for the first connected member. Another connected member has their own model preference.
- When: The second member posts a follow-up in that Teams thread and the Runner reads the execution request.
- Then: The Runner's native continuation has null session and generation run IDs for the second member.

## internal-callbacks-teams-014

- Vitest: "Teams chat callbacks > participant callbacks > resumes the original session after another participant completes"
- Mode: run
- Given: The original connected Teams member's run completed with a native session in a channel thread. A different participant subsequently sends a follow-up and completes their own run.
- When: The original participant next follows up in the same external thread.
- Then: The original participant's Runner input resumes their original native session ID.

## internal-callbacks-teams-015

- Vitest: "Teams chat callbacks > posts readable failed run replies for Cannot continue session from history without persisting a thread session"
- Mode: run
- Given: A connected Teams member mentions the bot in a channel thread and the Runner has its sandbox token.
- When: The Runner completes with an internal session-history error without a structured reason, then the same member sends a follow-up in that thread.
- Then: Teams receives one readable reply containing the generic safe error text and a deletion of its thought-bubble reaction. The same-thread follow-up starts and its Runner input is available.

## internal-callbacks-teams-016

- Vitest: "Teams chat callbacks > posts readable failed run replies for insufficient_credits without persisting a thread session"
- Mode: run
- Given: A connected Teams member mentions the bot in a channel thread and the Runner has its sandbox token.
- When: The Runner completes with `insufficient_credits`, then the same member sends a follow-up in that thread.
- Then: Teams receives one readable reply containing a billing settings link and a deletion of its thought-bubble reaction. The same-thread follow-up starts and its Runner input is available.

## internal-callbacks-teams-017

- Vitest: "Teams chat callbacks > does not post replies when the Teams installation is missing"
- Mode: run
- Given: A Teams channel task was already dispatched and its workspace bot is uninstalled before completion.
- When: The Runner completes successfully. The bot is later reinstalled and reconnected and the member follows up in the same thread.
- Then: The completion makes no Teams token, reply, or reaction requests while uninstalled. After reinstall the same-thread follow-up can be dispatched and its execution input is available.

## internal-callbacks-teams-018

- Vitest: "Teams chat callbacks > keeps the canonical session without resending a rejected Teams reply"
- Mode: run
- Given: A connected member has a dispatched Teams channel run. The provider rejects the terminal reply attempt with HTTP 500.
- When: The Runner sends the same successful completion twice, then the member follows up in the same Teams thread.
- Then: There is exactly one attempted Teams success reply and one thought-bubble reaction removal. The follow-up's Runner input resumes the original completed native session despite the provider's rejected reply.
