# discord-ingress

## discord-ingress-001

- Vitest: "canonical Discord ingress > deduplicates each channel admission and launch, with typing before context and concurrent launch reads"
- Mode: run
- Given: A linked Discord member sends an attachment-bearing message in a guild channel. Message Content is available for guild context. The provider can pause the attachment download to expose admission separately from launch.
- When: Discord delivers the message, then the provider finishes the attachment read. Independent launch lookup responses can wait for one another to start.
- Then: The bot starts typing in the message's source before reading message context. Admission makes nine Discord GETs with unique URLs and one Clerk membership lookup. Launch reads fresh authority with seven independent channel, guild, sender, bot and application reads provider GETs and one Clerk membership lookup. The resulting owned run contains the attachment request.

## discord-ingress-002

- Vitest: "canonical Discord ingress > deduplicates each thread admission and launch, with typing before context and concurrent launch reads"
- Mode: run
- Given: A linked Discord member sends an attachment-bearing message in a public guild thread with an unavailable quoted starter. Message Content is available for guild context. The provider can pause the attachment download to expose admission separately from launch.
- When: Discord delivers the message, then the provider finishes the attachment read. Independent launch lookup responses can wait for one another to start.
- Then: The bot starts typing in the message's source before reading message context. Admission makes twelve Discord GETs with unique URLs and one Clerk membership lookup. Launch reads fresh authority with the source authorization reads plus the parent channel provider GETs and one Clerk membership lookup. The resulting owned run contains the attachment request.

## discord-ingress-003

- Vitest: "canonical Discord ingress > deduplicates each private thread admission and launch, with typing before context and concurrent launch reads"
- Mode: run
- Given: A linked Discord member sends an attachment-bearing message in a private guild thread with a quoted starter and ordinary members without Manage Threads. Message Content is available for guild context. The provider can pause the attachment download to expose admission separately from launch.
- When: Discord delivers the message, then the provider finishes the attachment read. Independent launch lookup responses can wait for one another to start.
- Then: The bot starts typing in the message's source before reading message context. Admission makes thirteen Discord GETs with unique URLs and one Clerk membership lookup. Launch reads fresh authority with source and parent checks plus distinct thread membership for the sender and bot provider GETs and one Clerk membership lookup. The resulting owned run contains the attachment request.

## discord-ingress-004

- Vitest: "canonical Discord ingress > deduplicates each dm admission and launch, with typing before context and concurrent launch reads"
- Mode: run
- Given: A linked Discord member sends an attachment-bearing message in a bot DM. Message Content is available for guild context. The provider can pause the attachment download to expose admission separately from launch.
- When: Discord delivers the message, then the provider finishes the attachment read. Independent launch lookup responses can wait for one another to start.
- Then: The bot starts typing in the message's source before reading message context. Admission makes three Discord GETs with unique URLs and one Clerk membership lookup. Launch reads fresh authority with only the current DM channel and bot identity provider GETs and one Clerk membership lookup. The resulting owned run contains the attachment request.

## discord-ingress-005

- Vitest: "canonical Discord ingress > reads fresh permissions on the next message and does not type after revocation"
- Mode: run
- Given: A connected member sends a guild mention while authorized. Discord then revokes their channel permissions.
- When: Discord delivers a second mention from the same member and source.
- Then: The second request refreshes role permissions once, reads no message content and starts no typing. One thread and only the prior authorized input are visible.

## discord-ingress-006

- Vitest: "canonical Discord ingress > admits one chat for a linked sender before workspace bootstrap, including replay"
- Mode: run
- Given: A newly linked Discord sender has a valid connection and one DM binding while their Okou workspace agent setup has not finished.
- When: Discord delivers a guild mention before workspace bootstrap is complete and later replays it using another delivery event ID.
- Then: The first response is accepted and creates one chat. Replay responds duplicate and changes neither the thread list nor the Discord messages already delivered.

## discord-ingress-007

- Vitest: "canonical Discord ingress > copies the Chat browser preference (true) into new threads without changing existing routes"
- Mode: run
- Given: A linked Discord user sets the default cloud browser preference to enabled.
- When: They start a guild task, complete it, switch the default to disabled, then send a follow-up in the same guild thread and start a new DM.
- Then: The original thread's public listing and metadata stay enabled. The new DM's listing and metadata use disabled.

## discord-ingress-008

- Vitest: "canonical Discord ingress > copies the Chat browser preference (false) into new threads without changing existing routes"
- Mode: run
- Given: A linked Discord user sets the default cloud browser preference to disabled.
- When: They start a guild task, complete it, switch the default to enabled, then send a follow-up in the same guild thread and start a new DM.
- Then: The original thread's public listing and metadata stay disabled. The new DM's listing and metadata use enabled.

## discord-ingress-009

- Vitest: "canonical Discord ingress > ignores unmentioned messages without canonical chat or provider thread side effects"
- Mode: run
- Given: A connected sender posts ordinary guild chatter without mentioning the bot.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The receipt reports ignored. There is no Okou chat, no provider message, and no additional Discord channel or thread.

## discord-ingress-010

- Vitest: "canonical Discord ingress > uses a connected account in another server after the bot leaves its original server"
- Mode: run
- Given: A connected member can use the bot and authorize it in a different guild from their original connection. The bot later loses membership of that different guild.
- When: Discord first sends an authorized mention from the different guild, then another after the bot leaves.
- Then: The first receipt is accepted and produces one owned run. The second receipt is also accepted at the transport boundary but produces no additional chat or input. The personal binding stays connected.

## discord-ingress-011

- Vitest: "canonical Discord ingress > uses the account's bot DM when its original server is no longer shared"
- Mode: run
- Given: The member still has a valid Discord account link and verified bot DM, while the original guild is no longer the bot's shared server.
- When: Discord delivers a direct message in that bot DM.
- Then: The member still gets an owned thread with one input and a launched run.

## discord-ingress-012

- Vitest: "canonical Discord ingress > replies to unconnected guild mentions with a setup link (installed)"
- Mode: run
- Given: An unconnected Discord member mentions the app in a server that has an installation. A second unconnected sender can also mention it.
- When: Discord delivers the first mention, replays it, and delivers the second sender's distinct mention.
- Then: The first request is ignored for chat admission, but replies in the source channel to the exact incoming ID with the sender mention, connect explanation and guild-specific settings link. Provider mention parsing and replied-user notification are off. Replay produces no duplicate; the other sender gets their own notice. No Okou chat or Discord thread is created.

## discord-ingress-013

- Vitest: "canonical Discord ingress > replies to unconnected guild mentions with a setup link (uninstalled)"
- Mode: run
- Given: An unconnected Discord member mentions the app in a server that has no installation. A second unconnected sender can also mention it.
- When: Discord delivers the first mention, replays it, and delivers the second sender's distinct mention.
- Then: The first request is ignored for chat admission, but replies in the source channel to the exact incoming ID with the sender mention, connect explanation and guild-specific settings link. Provider mention parsing and replied-user notification are off. Replay produces no duplicate; the other sender gets their own notice. No Okou chat or Discord thread is created.

## discord-ingress-014

- Vitest: "canonical Discord ingress > ignores unmentioned guild chatter even while the identity provider is failing"
- Mode: run
- Given: Clerk's organization membership lookup is unavailable. A Discord guild message does not mention the bot.
- When: Discord delivers the message.
- Then: The acceptance body has `ok: true`, `outcome: ignored`, and `reason: no-explicit-mention`.

## discord-ingress-015

- Vitest: "canonical Discord ingress > does not consume a message receipt when another message already owns its event ID"
- Mode: run
- Given: Two distinct DM messages arrive from the same connected member, but the first event already owns the delivery event ID used by the second.
- When: Discord submits the second with the conflicting event ID, then with a fresh event ID.
- Then: The conflicting request returns HTTP 500. The later request is accepted and the member's single DM thread contains both original prompts.

## discord-ingress-016

- Vitest: "canonical Discord ingress > rolls back a losing application's receipt when another connection wins the message"
- Mode: run
- Given: Two different connected Discord members and application contexts submit receipts for the same physical message ID, with different private bodies and distinct delivery IDs.
- When: The first request is blocked on its membership lookup while the second commits. After the competing connection is removed, Discord retries the first member's message in its original application context.
- Then: The competing delivery is HTTP 200 accepted. The first attempt returns HTTP 500 without disclosing its private body and creates no first-member chat. The later retry is accepted and creates one chat containing only the first member's intended prompt.

## discord-ingress-017

- Vitest: "canonical Discord ingress > creates one owned input and run across concurrent relay retries"
- Mode: run
- Given: A linked Discord user sends one bot mention and the application lacks Message Content access.
- When: Two concurrent Gateway deliveries use the same physical message but different delivery IDs.
- Then: One receipt is accepted and one duplicate. One owned chat contains one input with the normalized mention and Discord source link, and one Run is launched with the original text. The public projection contains neither connection ID nor conversation context. The Runner's context explains that Message Content is unavailable.

## discord-ingress-018

- Vitest: "canonical Discord ingress > publishes one owned thread and created event for concurrent distinct messages on the same physical key"
- Mode: run
- Given: A linked Discord member has a single physical guild thread source and two different input messages.
- When: The Gateway submits them concurrently and later replays both under different delivery IDs.
- Then: Both original receipts are accepted. The member sees one owned chat and both normalized mention inputs, with one created lifecycle event matching model, model settings and browser state. Lifecycle sequence IDs are unique and ordered, and no further page exists. Both replays report duplicate and change neither input IDs nor the created events.

## discord-ingress-019

- Vitest: "canonical Discord ingress > publishes one owned dm and created event for concurrent distinct messages on the same physical key"
- Mode: run
- Given: A linked Discord member has a single physical bot DM source and two different input messages.
- When: The Gateway submits them concurrently and later replays both under different delivery IDs.
- Then: Both original receipts are accepted. The member sees one owned chat and both plain direct-message inputs, with one created lifecycle event matching model, model settings and browser state. Lifecycle sequence IDs are unique and ordered, and no further page exists. Both replays report duplicate and change neither input IDs nor the created events.

## discord-ingress-020

- Vitest: "canonical Discord ingress > keeps deleted DM receipts consumed while a new message creates a new owned chat"
- Mode: run
- Given: A linked Discord sender already has an owned DM thread created from their first message.
- When: The sender deletes the Okou thread, then the Gateway replays the original message and follows it with a genuinely new message.
- Then: The deleted thread metadata is HTTP 404 and the old receipt still reports duplicate without recreating anything. The new receipt is accepted, creates a distinct thread with one input, and lifecycle readback includes the original created and deleted thread plus the replacement create.

## discord-ingress-021

- Vitest: "canonical Discord ingress > tells a Discord run how its final reply and files reach Discord"
- Mode: run
- Given: A linked guild sender mentions the bot to ask for a report file.
- When: Discord delivers the request and the Runner reads the resulting execution.
- Then: The instructions identify the final answer as automatically delivered, warn against sending it twice, distinguish inaccessible private artifact links from an uploaded file, and name the Discord file upload and install-link operations, including that link creation alone is not proof of joining.

## discord-ingress-022

- Vitest: "canonical Discord ingress > requires sender public-thread creation permission even when the other party is an administrator"
- Mode: run
- Given: A guild sender and bot share view, send and history access, but the sender lacks Create Public Threads while the other party is an administrator.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted, but there is no native reply thread or canonical input. One reply in the guild channel says `I couldn't process this Discord message. Please send it again.` and a replay sends no additional notice.

## discord-ingress-023

- Vitest: "canonical Discord ingress > requires bot public-thread creation permission even when the other party is an administrator"
- Mode: run
- Given: A guild sender and bot share view, send and history access, but the bot lacks Create Public Threads while the other party is an administrator.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted, but there is no native reply thread or canonical input. One reply in the guild channel says `I couldn't process this Discord message. Please send it again.` and a replay sends no additional notice.

## discord-ingress-024

- Vitest: "canonical Discord ingress > does not send or replay a terminal notice when Discord channel access fails with 403"
- Mode: run
- Given: A connected sender mentions the bot from a guild channel. Discord rejects the reply-thread create with HTTP 400 and subsequent source-channel access returns HTTP 403.
- When: The Gateway delivers the signed message and later replays it.
- Then: The transport reports accepted initially and duplicate on replay; no native thread is created and no terminal notice is delivered on either attempt.

## discord-ingress-025

- Vitest: "canonical Discord ingress > does not send or replay a terminal notice when Discord channel access fails with 404"
- Mode: run
- Given: A connected sender mentions the bot from a guild channel. Discord rejects the reply-thread create with HTTP 400 and subsequent source-channel access returns HTTP 404.
- When: The Gateway delivers the signed message and later replays it.
- Then: The transport reports accepted initially and duplicate on replay; no native thread is created and no terminal notice is delivered on either attempt.

## discord-ingress-026

- Vitest: "canonical Discord ingress > does not send or replay a terminal notice when Discord channel access fails with 502"
- Mode: run
- Given: A connected sender mentions the bot from a guild channel. Discord rejects the reply-thread create with HTTP 400 and subsequent source-channel access returns HTTP 502.
- When: The Gateway delivers the signed message and later replays it.
- Then: The transport reports accepted initially and duplicate on replay; no native thread is created and no terminal notice is delivered on either attempt.

## discord-ingress-027

- Vitest: "canonical Discord ingress > does not resend a terminal notice when its delivery is rate limited"
- Mode: run
- Given: A linked sender's mention lacks public-thread creation authority. While sending the terminal notice, Discord rate-limits the notice before acceptance.
- When: Discord delivers the initial message and then replays it with a new delivery event ID.
- Then: The Gateway initially reports accepted and then duplicate. No notice is delivered. Replay leaves provider delivery unchanged.

## discord-ingress-028

- Vitest: "canonical Discord ingress > does not resend a terminal notice when its delivery is response lost"
- Mode: run
- Given: A linked sender's mention lacks public-thread creation authority. While sending the terminal notice, Discord accepts the notice but its network response is lost.
- When: Discord delivers the initial message and then replays it with a new delivery event ID.
- Then: The Gateway initially reports accepted and then duplicate. One notice telling the member to send the message again is already delivered in the source channel. Replay leaves provider delivery unchanged.

## discord-ingress-029

- Vitest: "canonical Discord ingress > keeps one canonical error and one reply when an attachment disappears after routing"
- Mode: run
- Given: The signed payload from a linked Discord thread member included an attachment, but its authorized provider refresh no longer lists it.
- When: The Gateway delivers the message, then retries after Discord can return the attachment.
- Then: The first receipt is accepted. The owner reads one canonical safe output error and corresponding sidebar sort update, with no active input or Run. One native reply carries the same error. Replay reports duplicate and changes neither thread projection nor reply count.

## discord-ingress-030

- Vitest: "canonical Discord ingress > applies public-thread creation authority: both role grants"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is granted to both through guild roles.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. One canonical input with a Run is visible and the launched prompt contains the current message.

## discord-ingress-031

- Vitest: "canonical Discord ingress > applies public-thread creation authority: sender role deny"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is overridden with a deny on the sender role.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. No canonical input is admitted.

## discord-ingress-032

- Vitest: "canonical Discord ingress > applies public-thread creation authority: bot role deny"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is overridden with a deny on the bot role.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. No canonical input is admitted.

## discord-ingress-033

- Vitest: "canonical Discord ingress > applies public-thread creation authority: sender member deny"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is denied explicitly for the sender member.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. No canonical input is admitted.

## discord-ingress-034

- Vitest: "canonical Discord ingress > applies public-thread creation authority: bot member deny"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is denied explicitly for the bot member.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. No canonical input is admitted.

## discord-ingress-035

- Vitest: "canonical Discord ingress > applies public-thread creation authority: aggregated role allow"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is allowed by a second sender role overwrite despite the deny on another role.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. One canonical input with a Run is visible and the launched prompt contains the current message.

## discord-ingress-036

- Vitest: "canonical Discord ingress > applies public-thread creation authority: member allow after role deny"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is allowed explicitly for the sender member after the sender role deny.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. One canonical input with a Run is visible and the launched prompt contains the current message.

## discord-ingress-037

- Vitest: "canonical Discord ingress > applies public-thread creation authority: sender admin despite overwrite"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is granted by sender administrator status despite a sender member overwrite.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. One canonical input with a Run is visible and the launched prompt contains the current message.

## discord-ingress-038

- Vitest: "canonical Discord ingress > applies public-thread creation authority: bot admin despite overwrite"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is granted by bot administrator status despite a bot member overwrite.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. One canonical input with a Run is visible and the launched prompt contains the current message.

## discord-ingress-039

- Vitest: "canonical Discord ingress > applies public-thread creation authority: sender owner despite overwrite"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is granted by guild ownership despite the sender member deny.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. One canonical input with a Run is visible and the launched prompt contains the current message.

## discord-ingress-040

- Vitest: "canonical Discord ingress > applies public-thread creation authority: announcement parent"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is available on an announcement parent.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. One canonical input with a Run is visible and the launched prompt contains the current message.

## discord-ingress-041

- Vitest: "canonical Discord ingress > applies public-thread creation authority: forum parent"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is not supported for a forum parent.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. No canonical input is admitted.

## discord-ingress-042

- Vitest: "canonical Discord ingress > applies public-thread creation authority: media parent"
- Mode: run
- Given: A linked sender mentions the bot from a Discord parent channel. Both have ordinary message access, and current public-thread authority is not supported for a media parent.
- When: Discord delivers the signed mention through `POST /api/internal/discord/gateway`.
- Then: The Gateway reports accepted and creates no native thread yet. No canonical input is admitted.

## discord-ingress-043

- Vitest: "canonical Discord ingress > keeps two users in one physical Discord thread in separate owned chats"
- Mode: run
- Given: Two connected users share the same Discord server and Okou workspace. The first sender already used a bot mention to start an owned task.
- When: The second user posts a private task as a bot mention inside the same native Discord thread.
- Then: Each authenticated user sees one different Okou thread, and neither projection contains the other person's private task.

## discord-ingress-044

- Vitest: "canonical Discord ingress > preserves account connections across temporary unavailability, bot removal, and replay"
- Mode: run
- Given: A signed-in Discord member has an existing personal binding and the Gateway can report the original guild becoming unavailable and then removed.
- When: Discord sends both lifecycle events. The member reinstalls through normal OAuth, Discord replays the removal, and the member sends a new bot mention.
- Then: All removals are ignored for the binding and produce no Discord realtime change notice. The user stays connected with the same connection ID after reinstall. Replay keeps it connected, and the new message produces one canonical input.

## discord-ingress-045

- Vitest: "canonical Discord ingress > does not launch an accepted message again after disconnect and reinstall"
- Mode: run
- Given: An accepted Discord mention launched one run. The owner disconnects and later reconnects the same identity with a different connection ID.
- When: The Gateway replays the previously accepted message after reconnect.
- Then: The replay reports duplicate and the public thread list and original input remain unchanged.

## discord-ingress-046

- Vitest: "canonical Discord ingress > pins guild and DM models when each thread is created"
- Mode: run
- Given: A connected Discord sender has an existing guild thread and can choose both Opus and Fable subscription models.
- When: The member changes their default to Opus, follows up in the guild thread, then starts a new DM. Later they change their default to Fable and send another DM.
- Then: The original guild thread keeps its selected model and gains a second input. The DM remains one thread on its initially pinned `claude-opus-5-5`; the later input runs on Opus and does not import the earlier private DM reply into its execution context.

## discord-ingress-047

- Vitest: "canonical Discord ingress > keeps the same DM thread when its connected sender moves to a new physical channel"
- Mode: run
- Given: A connected member ran an earlier task in their original Discord DM. Discord replaces the physical channel with a new one for the same recipient.
- When: The member sends a new message from the new channel.
- Then: One Okou thread with the original ID and Fable model contains both inputs. The second cites the new DM message URL and launches execution with the newly sent text.

## discord-ingress-048

- Vitest: "canonical Discord ingress > updates the main DM thread model without changing the member default"
- Mode: run
- Given: A linked Discord member has an existing DM thread and a previously read global model and service tier.
- When: The member changes only the thread's selection to `gpt-6-astra` with Codex Fast and sends another DM.
- Then: Thread metadata and listing report GPT Astra with priority tier, but global model and tier stay unchanged. The launched DM input uses GPT Astra and the Runner environment carries the Fast Codex tier.

## discord-ingress-049

- Vitest: "canonical Discord ingress > pins a busy main DM and captures a web send model before the next pick"
- Mode: run
- Given: The connected Discord member's main DM has one active run.
- When: The member sends from Web into that same thread using GPT Astra and Codex Fast, then terminalizes the original run to free the slot.
- Then: The send returns HTTP 201 and the same thread ID. Its input waits without a run while the thread and global preference already read as GPT Astra and priority. Once picked, it starts on GPT Astra with Fast Codex tier.

## discord-ingress-050

- Vitest: "canonical Discord ingress > keeps another organization's DM replies out of a newly selected organization's run"
- Mode: run
- Given: One Discord identity has two linked Okou organizations and an existing bot reply in the DM about the first organization's private pipeline.
- When: The owner selects the second organization for DMs and sends a new message in the same physical DM.
- Then: The second organization owns the resulting run with the new prompt. Its execution context includes neither the first organization's prior input or reply nor a prior Discord messages section.

## discord-ingress-051

- Vitest: "canonical Discord ingress > requires explicit DM org choice and keeps a replay bound to its original org"
- Mode: run
- Given: One connected Discord identity belongs to multiple Okou organizations and has no selected DM destination.
- When: The Gateway sends a DM before selection. The user selects the first organization and the DM is retried, then selects the second organization and Discord replays the accepted message and sends a new one.
- Then: The first request is ignored until explicit selection, then accepted into the first organization. The replay reports duplicate and creates nothing in the second. A new message creates one chat in the second organization.

## discord-ingress-052

- Vitest: "canonical Discord ingress > tells an unconnected DM sender how to connect about once an hour"
- Mode: run
- Given: A person with no Okou Discord binding sends a bot DM.
- When: Discord delivers the first DM, retries it and sends more DMs immediately and ten minutes later. Two more messages arrive concurrently an hour later.
- Then: The first receipt is ignored for chat and the bot replies in the DM with a `Connect` button to Discord settings. The immediate deliveries and ten-minute follow-up do not repeat it. The later concurrent DMs together produce only one more notice.

## discord-ingress-053

- Vitest: "canonical Discord ingress > asks a DM sender with several workspaces to choose one with /connect"
- Mode: run
- Given: A connected Discord sender has several eligible Okou workspaces and no explicit DM selection.
- When: The Gateway delivers two ordinary DMs.
- Then: Both are ignored for chat admission. Exactly one reply tells the sender to choose a workspace through `/connect`, and neither workspace receives a chat.

## discord-ingress-054

- Vitest: "canonical Discord ingress > imports refreshed attachment metadata while keeping context and signed URLs private"
- Mode: run
- Given: A linked Discord member triggers a guild run with a private text attachment whose initial signed CDN URL is expired. The provider can refresh the attachment metadata and makes 25 long earlier messages readable.
- When: Discord delivers the signed mention. The first download returns HTTP 403; the refetched message yields a working attachment URL. The member reads the thread and requests the Okou file URL, and the Runner fetches execution.
- Then: The input exposes an Okou text file part and the file URL API returns HTTP 200 with an HTTPS download URL. The thread projection contains no private history or old or new signed Discord URLs. The Runner sees `[Web file] notes.txt` and limited recent context marked untrusted, including the newest prior message and excluding the oldest.

## discord-ingress-055

- Vitest: "canonical Discord ingress > replies to the original message while queued without creating an empty thread"
- Mode: run
- Given: The workspace permits only one concurrent run. A first guild mention fills that slot without showing a wait notice.
- When: Discord delivers a distinct second guild mention, then the member cancels and terminalizes the first run.
- Then: The second receipt is accepted promptly and shows a single capacity notice as a reply to the original Discord message, without opening an empty native thread. The member sees a pending canonical input with no run ID until capacity frees. It then launches with the queued prompt and no repeat wait notice.

## discord-ingress-056

- Vitest: "canonical Discord ingress > suppresses input and delivery when the sender disconnects during context import"
- Mode: run
- Given: A Discord mention is underway and the provider's context-history read is still pending.
- When: The signed-in sender disconnects through the public Discord integration API before the provider read finishes.
- Then: Disconnect returns HTTP 200. After the read completes, no owned thread exposes an input prompt and no Discord reply is delivered.
