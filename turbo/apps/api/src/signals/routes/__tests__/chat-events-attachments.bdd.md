# chat-events-attachments

## chat-events-attachments-001

- Vitest: "CHAT-02: generation templates and attachments > uses the userMessage document for the runtime prompt"
- Mode: run
- Given: A signed-in Pro member with Claude Fable 5.1 as default model has a completed uploaded file "brief.pdf".
- When: The member sends `POST /api/chat/events` with a structured message containing an illustration template part, the file part, text with a linked chat thread "Roadmap", two feedback parts quoting a mail draft (one with a linked-thread note), and a Slack source part.
- Then: The run's execution prompt is the template marker, then the `[Web file] brief.pdf (application/pdf)` line with the file ID, then the rendered text and feedback, separated by blank lines; the appended system prompt contains "# Inline Templates" and the illustration style ID. The stored `input.prompt` has null content and the submitted parts plus a `model` part with `claude-fable-5-1`.

## chat-events-attachments-002

- Vitest: "CHAT-02: generation templates and attachments > lists the chat threads the message links"
- Mode: run
- Given: A signed-in Pro member has an existing Chat.
- When: The member sends `POST /api/chat/events` with a structured message that links a chat thread titled `Q3 "launch" plan` both directly and inside a feedback note.
- Then: The run's appended system prompt contains a "# Referenced conversations" section listing the thread once with its escaped title and `CHAT_THREAD_ID`, followed by the note that work sent with `okou chat send` runs independently and that a chat-run-finished Workflow automation is needed for completion notifications.

## chat-events-attachments-003

- Vitest: "CHAT-02: generation templates and attachments > projects referenced passages without requiring every feedback note"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with two feedback parts, one with a note "Clarify the owner" and one with an empty note.
- Then: The run prompt is "The user quoted 2 parts of your reply:" followed by both quoted passages separated by `---`, with the note only after the first. The appended system prompt has no referenced-conversations section, and the stored message keeps both feedback parts unchanged.

## chat-events-attachments-004

- Vitest: "CHAT-02: generation templates and attachments > attributes artifact quotes to stored snapshots without granting file access"
- Mode: run
- Given: A signed-in Pro member, and another user owns an uploaded file "current-name.md" that the member cannot read (`GET /api/web/file-url` returns HTTP 404).
- When: The member sends `POST /api/chat/events` with two feedback quotes whose artifact source names that file ID, the snapshot "quoted-name.md" and an artifact ID.
- Then: The run prompt attributes both passages to the file "quoted-name.md" with its file ID (multi-line quotes rendered line by line, followed by the note) and contains neither the artifact ID nor the upload URL. The stored message keeps both feedback parts, and the member still gets HTTP 404 for the file URL.

## chat-events-attachments-005

- Vitest: "CHAT-02: generation templates and attachments > keeps artifact quotes separate when fileId differs"
- Mode: run
- Given: A signed-in Pro member. (Row: the two artifact quote sources differ by `fileId`.)
- When: The member sends `POST /api/chat/events` with two feedback quotes whose artifact sources share the filename "brief.md" but have different file IDs.
- Then: The run prompt is "The user quoted 2 selected passages:" with a separate `Source: a file "brief.md" (file ID: …)` line for each passage and its own file ID.

## chat-events-attachments-006

- Vitest: "CHAT-02: generation templates and attachments > keeps artifact quotes separate when filenameSnapshot differs"
- Mode: run
- Given: A signed-in Pro member. (Row: the two artifact quote sources differ by `filenameSnapshot`.)
- When: The member sends `POST /api/chat/events` with two feedback quotes on the same file ID, snapshotted as "brief.md" and "renamed.md".
- Then: The run prompt is "The user quoted 2 selected passages:" with separate source lines for "brief.md" and "renamed.md", each with the shared file ID.

## chat-events-attachments-007

- Vitest: "CHAT-02: generation templates and attachments > keeps artifact quotes separate when artifactId differs"
- Mode: run
- Given: A signed-in Pro member. (Row: the two artifact quote sources differ by `artifactId`.)
- When: The member sends `POST /api/chat/events` with two feedback quotes on the same file and filename, where only the second carries an artifact ID.
- Then: The run prompt is "The user quoted 2 selected passages:" with a separate `Source: a file "brief.md"` line for each passage, and it does not contain the artifact ID.

## chat-events-attachments-008

- Vitest: "CHAT-02: generation templates and attachments > keeps artifact, mail and source-less quotes in order"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with three feedback quotes: one from an artifact file, one from a sent email with a provider sent ID, and one without a source.
- Then: The run prompt is "The user quoted 3 selected passages:" with, in order, the file source line and passage, the `Source: a sent email (mail ID: …, sent ID: …)` line and passage, and the source-less passage, separated by `---`.

## chat-events-attachments-009

- Vitest: "CHAT-02: generation templates and attachments > projects forwarded passages from the authoritative source title"
- Mode: run
- Given: A signed-in Pro member has a source chat run whose thread is renamed "Source launch plan", and an empty target Chat.
- When: The member sends `POST /api/chat/events` to the target Chat with a quoted passage and `sourceRunId` set to the source run.
- Then: The send returns HTTP 201 for the target thread, the launched run's prompt is 'The user forwarded this from the chat "Source launch plan":' followed by the quote, and the stored message gains a `chat_thread` part with the source run, source thread and title "Source launch plan".

## chat-events-attachments-010

- Vitest: "CHAT-02: generation templates and attachments > preserves common source labels in forwarded prompts"
- Mode: run
- Given: A signed-in Pro member has a launched source chat run whose thread is renamed "Source launch plan".
- When: For each of four cases the member sends `POST /api/chat/events` to a new Chat with `sourceRunId`: an artifact quote without a note, a mail-draft quote with a note, a sent-email quote, and two passages from one draft with a note.
- Then: Each send returns HTTP 201 and the run prompt starts with 'The user forwarded this from the chat "Source launch plan":' (or "forwarded 2 parts" for the multi-passage case) followed by the matching `Source:` label (file with file ID, email draft with mail draft ID, or sent email with mail and sent IDs), the passages and any note. The stored message keeps the submitted parts plus a `chat_thread` part for the source run.

## chat-events-attachments-011

- Vitest: "CHAT-02: generation templates and attachments > projects multiple inline templates into one ordered prompt and one shared context"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with text interleaving an illustration template and a workflow template, plus a feedback note that references the illustration template again and the Taped Consulting presentation template.
- Then: The run prompt numbers the markers #1–#4 in order ("Use [Template #1 …] for the dog, then [Template #2 …] for the follow-up" and "Restyle with [Template #3 …] and [Template #4: Taped Consulting Presentation (presentation)]"). The appended system prompt has exactly one "# Inline Templates" heading, sections for templates #1–#4, the selected Taped Consulting template line, and the style and workflow IDs. The stored message has null content and the submitted parts plus the model part.

## chat-events-attachments-012

- Vitest: "CHAT-02: generation templates and attachments > routes an attached presentation to its undefined format package and preserves the selection"
- Mode: run
- Given: A signed-in Pro member. (Row: no output format.)
- When: The member sends `POST /api/chat/events` with text and a Schoolhouse presentation template part with a color system and no output format.
- Then: The run's appended system prompt pulls `template:html-ppt-schoolhouse-runbook`, states "Output format: HTML", references `./generated/resources/schoolhouse/SKILL.md`, says the message wins over the format preference, and says to keep all slides in index.html. The stored message keeps the template part unchanged.

## chat-events-attachments-013

- Vitest: "CHAT-02: generation templates and attachments > routes an attached presentation to its html format package and preserves the selection"
- Mode: run
- Given: A signed-in Pro member. (Row: output format `html`.)
- When: The member sends `POST /api/chat/events` with text and a Schoolhouse presentation template part with output format `html`.
- Then: The run's appended system prompt pulls `template:html-ppt-schoolhouse-runbook`, states "Output format: HTML", references `./generated/resources/schoolhouse/SKILL.md`, says the message wins over the format preference, and says to keep all slides in index.html. The stored message keeps the template part unchanged.

## chat-events-attachments-014

- Vitest: "CHAT-02: generation templates and attachments > routes an attached presentation to its pptx format package and preserves the selection"
- Mode: run
- Given: A signed-in Pro member. (Row: output format `pptx`.)
- When: The member sends `POST /api/chat/events` with text and a Schoolhouse presentation template part with output format `pptx`.
- Then: The run's appended system prompt pulls `template:pptx-schoolhouse-runbook`, states "Output format: PPTX", references `./generated/resources/pptx/schoolhouse-native/SKILL.md`, says the message wins over the format preference, and says to author an editable native PPTX. The stored message keeps the template part unchanged.

## chat-events-attachments-015

- Vitest: "CHAT-02: generation templates and attachments > uses runbook names for presentation prompts while preserving picker titles in chat history"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with one template part for every presentation picker item, using picker titles.
- Then: For each item the run prompt contains `[Template #n: <runbook name> (presentation)]` and the appended system prompt contains `Selected presentation template: <runbook name> (<templateId>)`. The stored message keeps the picker-titled parts unchanged plus the model part.

## chat-events-attachments-016

- Vitest: "CHAT-02: generation templates and attachments > preserves the attachment userMessage order in the runtime prompt"
- Mode: run
- Given: A signed-in Pro member has a completed uploaded file "api-input.txt".
- When: The member sends `POST /api/chat/events` with a file part followed by the text "plain API attachment".
- Then: `GET /api/runs/:id` shows the prompt as the `[Web file] api-input.txt (text/plain)` line with the file ID, then the text. The stored message has null content, the file and text parts plus the model part, and displays as "plain API attachment".

## chat-events-attachments-017

- Vitest: "CHAT-02: generation templates and attachments > uses only the canonical template part"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with the prompt "draw a dog" and a structured message holding the text and an illustration template part titled "Illustration template".
- Then: The run prompt is "draw a dog" followed by "[Template #1: Illustration template (illustration)]", the appended system prompt contains "# Inline Templates" and the style ID, and the stored message contains the template part.

## chat-events-attachments-018

- Vitest: "CHAT-02: generation templates and attachments > preserves client-authored additional info in the agent prompt: Create a presentation.\nNumber of slides: 10."
- Mode: run
- Given: A signed-in Pro member. (Row: additional info "Create a presentation.\nNumber of slides: 10.")
- When: The member sends `POST /api/chat/events` with an `additional_info` part with that text and the text "Our launch brief".
- Then: `GET /api/runs/:id` shows the prompt as the additional info, a blank line and "Our launch brief". The stored message contains both parts and displays as "Our launch brief".

## chat-events-attachments-019

- Vitest: "CHAT-02: generation templates and attachments > preserves client-authored additional info in the agent prompt: Create a video.\nDuration: 6s.\nAudio: off."
- Mode: run
- Given: A signed-in Pro member. (Row: additional info "Create a video.\nDuration: 6s.\nAudio: off.")
- When: The member sends `POST /api/chat/events` with an `additional_info` part with that text and the text "Our launch brief".
- Then: `GET /api/runs/:id` shows the prompt as the additional info, a blank line and "Our launch brief". The stored message contains both parts and displays as "Our launch brief".

## chat-events-attachments-020

- Vitest: "CHAT-02: generation templates and attachments > preserves client-authored additional info in the agent prompt: Create an image.\nAspect ratio: 1:1."
- Mode: run
- Given: A signed-in Pro member. (Row: additional info "Create an image.\nAspect ratio: 1:1.")
- When: The member sends `POST /api/chat/events` with an `additional_info` part with that text and the text "Our launch brief".
- Then: `GET /api/runs/:id` shows the prompt as the additional info, a blank line and "Our launch brief". The stored message contains both parts and displays as "Our launch brief".

## chat-events-attachments-021

- Vitest: "CHAT-02: generation templates and attachments > includes cover capture and publishing guidance for templates and revisions"
- Mode: run
- Given: A signed-in Pro member in an organization.
- When: The member sends `POST /api/chat/events` with "make a launch deck" and the Playful Launch presentation template with its color system, then a revision in the same thread without a template, then "make a campaign landing page" with the first website template.
- Then: The presentation run prompt is "make a launch deck" plus "[Template #1: Playful Launch Presentation (presentation)]"; its appended system prompt orders Current User Info, Current Integration, Inline Templates, Built-in image model and ends with Restricted Explicit Content, and contains `okou host screenshot`, `--preview`, the selected template line, the runbook pull command, the color system token, the `playful-launch/SKILL.md` path, the index.html rule and `--artifact-kind presentation-html`. The revision prompt has no inline templates but contains `okou host screenshot` and `previewImageUrl`. The website prompt contains the screenshot and preview guidance, inline templates, the template title and ID, the `template:black-slabs` pull command, the image workflow line and the `okou generate image-batch start`/`wait` commands.

## chat-events-attachments-022

- Vitest: "CHAT-02: generation templates and attachments > keeps selected templates usable without recommending disabled managed image generation"
- Mode: run
- Given: A signed-in Pro member has managed image generation disabled as a paid tool.
- When: The member sends `POST /api/chat/events` once each with the Playful Launch presentation, the first website template and the first illustration style.
- Then: Each run's appended system prompt contains "# Inline Templates" and `okou connector search`, and contains no `okou generate image-batch`, `--provider built-in` or "# Built-in image model". The illustration prompt also names the style title and ID and a non-empty style description.

## chat-events-attachments-023

- Vitest: "CHAT-02: generation templates and attachments > uses R2 for archive-backed styles"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with the `image-style:ink-storefront` illustration template.
- Then: The run's appended system prompt contains "Style source: private R2 registry resource image-style:ink-storefront" and `--compile --style-source r2`.

## chat-events-attachments-024

- Vitest: "CHAT-02: generation templates and attachments > is one-shot: a follow-up without re-attaching the style gets no template context"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends "draw a fox" with an illustration style, completes it, sends "another one" in the same thread without a template, then "now make a website" with a website template, and finally "draw a cat" in a new thread, each through `POST /api/chat/events`.
- Then: The first prompt contains "# Inline Templates", the built-in `okou generate image … --compile` command, "Follow the returned packet completely", the no-GitHub-fallback rule, `--compiled-prompt` and the style ID. The follow-up has no inline templates or style ID but has "# This Chat Thread". The website turn names only the website template and its "When you produce a website" guidance without the style ID. The new thread has no inline templates, built-in style command or style ID.

## chat-events-attachments-025

- Vitest: "CHAT-02: generation templates and attachments > injects workflow templates as one-shot context without prior template selections"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends "draw a labeled inbox" with an illustration style, then "create the workflow version" with the first workflow template, then "continue the thread", each in the same thread through `POST /api/chat/events` and each cancelled afterwards.
- Then: The illustration prompt has inline templates and the style ID. The workflow prompt has inline templates, "Auto-inbox label (<id>)", the workflow-setup skill instruction, the save-draft instruction and "Gmail label-applied automation", plus "# Incomplete Rounds Context" with "User: draw a labeled inbox" but no style ID. The follow-up has no inline templates, workflow ID or style ID, and its incomplete-rounds context lists both earlier prompts.

## chat-events-attachments-026

- Vitest: "CHAT-02: generation templates and attachments > rejects unavailable templates at pick and launches all templates once they are shared"
- Mode: run
- Given: A signed-in Pro member; another member of the organization has published a private presentation template and a private custom template.
- When: The member sends `POST /api/chat/events` with an illustration template plus, in turn, the private presentation, an unknown presentation, the private custom template and an unknown custom template; then the owner makes the presentation public and the custom template organization-visible, and the member sends all three templates.
- Then: Each rejected send returns HTTP 201 but settles as `input.rejected` with error `bad_request` and an `output.error` "Presentation template not found" or "Custom template not found", with no run. No storage writes or URL signatures occur and credits are unchanged. After sharing, the run's appended system prompt contains inline templates, the illustration style ID and the SKILL.md paths of the user presentation and custom template directories.

## chat-events-attachments-027

- Vitest: "CHAT-02: generation templates and attachments > injects the pinned public source for a Document template"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with the `document-template:simple-invoice` Document template.
- Then: The run's appended system prompt contains the pinned raw GitHub URL of the simple invoice template at its fixed commit.

## chat-events-attachments-028

- Vitest: "CHAT-02: generation templates and attachments > preserves multiple Document references and their pinned sources in the run"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with text and six Document template parts (creative brief, fixed-price contract, design services, department newsletter, meeting notes, sidebar report).
- Then: The appended system prompt has exactly six "## Template #n (document)" sections in order, each with the selected template title, the pinned raw GitHub source URL, supporting file URLs where defined, layout previews, and the fidelity and fact-replacement instructions. The stored `input.prompt` keeps the six template parts unchanged.

## chat-events-attachments-029

- Vitest: "CHAT-02: generation templates and attachments > rejects unknown generation template selections"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` with an unknown presentation template, a known presentation with an unknown color system, and unknown workflow, website and Document templates.
- Then: Each request returns HTTP 400 with the messages "Unknown generation template", "Unknown generation template color system", "Unknown workflow template", "Unknown website template" and "Unknown document template", and no thread events are created.

## chat-events-attachments-030

- Vitest: "CHAT-02: generation templates and attachments > rejects an unknown thread before accessing attachment storage"
- Mode: run
- Given: A signed-in Pro member.
- When: The member sends `POST /api/chat/events` to a nonexistent thread ID with a file attachment.
- Then: The request returns HTTP 404 with "Chat thread not found", and attachment storage is never queried for the file.

## chat-events-attachments-031

- Vitest: "CHAT-02: generation templates and attachments > refills attachment lookup slots while preserving order and concurrency four"
- Mode: run
- Given: A signed-in Pro member has five uploaded files whose storage metadata lookups are held: the second file is released first and the other four later.
- When: The member sends `POST /api/chat/events` with all five file parts followed by text.
- Then: Exactly four metadata lookups run at once; releasing the second starts the fifth while four remain active, and after the rest are released the send returns HTTP 201 with five lookups, a peak of four concurrent, and no prefix listings. The launched run's prompt contains every file ID in the original order, and resolving each file's URL returns a public URL and a URL that both point at that file's own stored object.

## chat-events-attachments-032

- Vitest: "CHAT-02: generation templates and attachments > falls back to v2 listing when the attachment filename hint is stale"
- Mode: run
- Given: A signed-in Pro member has an uploaded file whose stored name ("current-extension.png") differs from the message's filename snapshot ("stale-extension.txt"); the exact lookup by the snapshot name is not found.
- When: The member sends `POST /api/chat/events` with the file part and text.
- Then: Storage is queried in order: an exact lookup, a v2 prefix listing, then a lookup of the listed object. The created run's prompt contains `[Web file] stale-extension.txt`.

## chat-events-attachments-033

- Vitest: "CHAT-02: generation templates and attachments > uses the v2 listing size with one head of the attachment"
- Mode: run
- Given: A signed-in Pro member has an uploaded file whose exact storage lookup returns metadata without a size, while the v2 listing reports its size.
- When: The member sends `POST /api/chat/events` with the file part and text.
- Then: Storage performs exactly one lookup followed by one v2 listing, the created run's prompt contains `[Web file] incomplete-head.txt`, and the file's resolved public URL points at its stored object.

## chat-events-attachments-034

- Vitest: "CHAT-02: generation templates and attachments > does not create a run when an attachment is missing"
- Mode: run
- Given: A signed-in Pro member references a file whose stored metadata belongs to a different user.
- When: The member sends `POST /api/chat/events` with the file part and the prompt "reject the missing attachment".
- Then: The request returns HTTP 500 with `{ "error": "Internal server error" }` after exactly one exact-key lookup, and `GET /api/logs` lists no run with that prompt.

## chat-events-attachments-035

- Vitest: "CHAT-02: generation templates and attachments > does not create a run when attachment storage fails"
- Mode: run
- Given: A signed-in Pro member, and object storage is unavailable for every request.
- When: The member sends `POST /api/chat/events` with a file part and the prompt "reject the failed attachment lookup".
- Then: The request returns HTTP 500 with `{ "error": "Internal server error" }`, and `GET /api/logs` lists no run with that prompt.

## chat-events-attachments-036

- Vitest: "CHAT-02: generation templates and attachments > does not create a run when attachment resolution is aborted"
- Mode: run
- Given: A signed-in Pro member, and the client disconnects while the attachment is being looked up in storage.
- When: The member sends `POST /api/chat/events` with a file part and the prompt "abort the attachment lookup", and the request is aborted during the storage listing.
- Then: The request is aborted and returns HTTP 500 with `{ "error": "Internal server error" }`, and `GET /api/logs` lists no run with that prompt.

## chat-events-attachments-037

- Vitest: "CHAT-02: generation templates and attachments > persists attachments and injects them into the run prompt"
- Mode: run
- Given: A signed-in Pro member has a completed uploaded image "diagram final 100%.png".
- When: The member sends `POST /api/chat/events` with the file part and the text "read this file".
- Then: The run's prompt contains the `[Web file] diagram final 100%.png (image/png)` line and the file ID, and its appended system prompt mentions `okou web download-file -h` and `okou web upload-file -h`. The stored `input.prompt` keeps the file part with its ID, filename and content type.

## chat-events-attachments-038

- Vitest: "CHAT-02: generation templates and attachments > accepts repeated references to one uploaded file in the same input"
- Mode: run
- Given: A signed-in Pro member has uploaded one image file "repeated attachment.png".
- When: The member sends `POST /api/chat/events` referencing the file three times (once with a different content type snapshot) around the text, and later sends a new message with only the file part.
- Then: Both sends launch runs without any extra storage metadata lookup. The stored message keeps the three file parts in order, and both runs' prompts contain the filename.

## chat-events-attachments-039

- Vitest: "CHAT-02: generation templates and attachments > projects one structured annotated file through its rendered derivative"
- Mode: run
- Given: A signed-in Pro member has an uploaded image "billing-page.png" and its rendered annotated derivative "billing-page.annotated.png".
- When: The member sends `POST /api/chat/events` with a file part that names the annotated file ID and one box annotation with a note, followed by "fix this".
- Then: The run's prompt contains the `[Web file]` line and ID of the annotated derivative and an `[Image annotations]` block with the full file part as JSON, but not the original file's `[Web file]` line. The stored message keeps the file part exactly as sent.

## chat-events-attachments-040

- Vitest: "CHAT-02: generation templates and attachments > keeps a legacy-layout attachment on the legacy CDN for a new send"
- Mode: run
- Given: A signed-in Pro member has an uploaded file "legacy-brand.txt" stored in the legacy layout.
- When: The member sends `POST /api/chat/events` with the file part and text, then resolves the file URL.
- Then: The resolved public URL is on the legacy CDN `https://cdn.vm7.io/`.

## chat-events-attachments-041

- Vitest: "CHAT-02: queued attachments on auto-send > preserves structured part order when a queued message is promoted"
- Mode: run
- Given: A signed-in Pro member has a running anchor chat run and queues a structured message (file "ordered.txt", text and a feedback quote with a note) in the same thread through `POST /api/chat/events`.
- When: The Sandbox completes the anchor run through `POST /api/webhooks/run/complete`.
- Then: The queued message is promoted to an `input.prompt` with a run whose structured message keeps the file, text and feedback parts in order plus the model part, and the run's prompt is the `[Web file] ordered.txt (text/plain)` line with its ID followed by the queued text and rendered feedback.

## chat-events-attachments-042

- Vitest: "CHAT-02: queued attachments on auto-send > carries queued attachments into the auto-sent follow-up run"
- Mode: run
- Given: A signed-in Pro member has a running anchor chat run and queues "queued with attachment" with two uploaded files ("notes.txt" and "details.json") in the same thread through `POST /api/chat/events`.
- When: The Sandbox completes the anchor run through `POST /api/webhooks/run/complete`.
- Then: The promoted `input.prompt` has null content, displays "queued with attachment" and contains both file parts; the original queued message keeps its ID, null content and display text with no run. The follow-up run's prompt contains the text, both `[Web file]` lines and both file IDs.
