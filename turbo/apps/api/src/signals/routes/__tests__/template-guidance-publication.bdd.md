# template-guidance-publication

## template-guidance-publication-001

- Vitest: "uses explicit PPTX for an HTML-only template without a Presentation tag"
- Mode: run
- Given: Row `explicit PPTX`. A staff workspace owner has the presentation output-format and presentation-convert feature switches on, and has published an HTML-only presentation template (SKILL.md and design-system.md) through `POST /api/presentation-templates`.
- When: The owner sends "Use this imported template and deliver the deck as PPTX." with that template selected via `POST /api/chat/events`, and a Runner picks up the Run.
- Then: The execution prompt contains the request and no "Create a presentation." or presentation-defaults section; the user message has no `additional_info` (Presentation tag) parts. The template bundle contains exactly the published files. The system prompt says to author the deck as semantic HTML, CSS and SVG, has one `- Presentation output:` policy line with the explicit request → saved preference → HTML order, tells the template to use the enabled HTML-to-PPTX conversion and report blockers, and includes the `okou presentation convert … --verify` command, the "HTML-to-PPTX conversion: run" step, slide-image inspection and converting an existing HTML deck without regenerating it.

## template-guidance-publication-002

- Vitest: "uses default HTML for an HTML-only template without a Presentation tag"
- Mode: run
- Given: Row `default HTML`. A staff workspace owner has the presentation output-format switch on and presentation-convert off, and has published an HTML-only presentation template through `POST /api/presentation-templates`.
- When: The owner sends "Use this imported template for a quarterly planning deck." with that template selected via `POST /api/chat/events`, and a Runner picks up the Run.
- Then: The execution prompt contains the request and no "Create a presentation." or presentation-defaults section; the user message has no `additional_info` parts. The template bundle contains exactly the published files. The system prompt says to author the deck as semantic HTML, CSS and SVG, has one `- Presentation output:` policy line with the explicit request → saved preference → HTML order and the template's HTML-to-PPTX conversion and blocker guidance, and tells the agent to host the finished HTML deck with `okou host`.

## template-guidance-publication-003

- Vitest: "uses legacy explicit PPTX for an HTML-only template without a Presentation tag"
- Mode: run
- Given: Row `legacy explicit PPTX`. A staff workspace owner has the presentation output-format switch off and presentation-convert on, and has published an HTML-only presentation template through `POST /api/presentation-templates`.
- When: The owner sends "Use this imported template and deliver the deck as PPTX." with that template selected via `POST /api/chat/events`, and a Runner picks up the Run.
- Then: The execution prompt contains the request and no "Create a presentation." or presentation-defaults section; the user message has no `additional_info` parts. The template bundle contains exactly the published files. The system prompt says to author the deck as semantic HTML, CSS and SVG, has no `- Presentation output:` policy line, the template section says to deliver HTML by default and convert to PPTX only on explicit request, and the prompt includes the legacy "Only when the user explicitly requests PowerPoint/PPTX conversion…" `okou presentation convert` instruction.

## template-guidance-publication-004

- Vitest: "keeps the accepted user-template snapshot after delete during startup"
- Mode: run
- Given: Row `user-template`, `delete`. A workspace member has published a user template with an accepted guidance revision. While the Run's template package is being signed during startup, the owner deletes the template with `DELETE /api/user-templates/:templateId`.
- When: The owner sends a chat message selecting that template via `POST /api/chat/events` and a Runner picks up the Run.
- Then: The change happens during startup, the Run reads back as `running`, and its template bundle contains exactly the accepted revision's guidance files.

## template-guidance-publication-005

- Vitest: "keeps the accepted presentation-template snapshot after delete during startup"
- Mode: run
- Given: Row `presentation-template`, `delete`. A workspace member has published a presentation template with an accepted guidance revision. While the Run's template package is being signed during startup, the owner deletes it with `DELETE /api/presentation-templates/:templateId`.
- When: The owner sends a chat message selecting that template via `POST /api/chat/events` and a Runner picks up the Run.
- Then: The change happens during startup, the Run reads back as `running`, and its template bundle contains exactly the accepted revision's guidance files.

## template-guidance-publication-006

- Vitest: "keeps the accepted user-template snapshot after replace during startup"
- Mode: run
- Given: Row `user-template`, `replace`. A workspace member has published a user template with an accepted guidance revision. While the Run's template package is being signed during startup, the owner replaces the package with `PUT /api/user-templates/:templateId/package`.
- When: The owner sends a chat message selecting that template via `POST /api/chat/events` and a Runner picks up the Run.
- Then: The replacement succeeds with HTTP 200 during startup, the Run reads back as `running`, and its template bundle contains exactly the accepted revision's guidance files, not the replacement.

## template-guidance-publication-007

- Vitest: "keeps the accepted user-template snapshot after revoke during startup"
- Mode: run
- Given: Row `user-template`, `revoke`. Another workspace member published a user template and shared it with the organization. While the Run's template package is being signed during startup, the publisher sets it back to private with `PATCH /api/user-templates/:templateId`.
- When: The owner (a different member) sends a chat message selecting that template via `POST /api/chat/events` and a Runner picks up the Run.
- Then: The revocation succeeds during startup, the Run reads back as `running`, and its template bundle contains exactly the accepted revision's guidance files.

## template-guidance-publication-008

- Vitest: "keeps the accepted presentation-template snapshot after revoke during startup"
- Mode: run
- Given: Row `presentation-template`, `revoke`. Another workspace member published a presentation template and made it public. While the Run's template package is being signed during startup, the publisher sets it back to private with `PATCH /api/presentation-templates/:templateId`.
- When: The owner (a different member) sends a chat message selecting that template via `POST /api/chat/events` and a Runner picks up the Run.
- Then: The revocation succeeds during startup, the Run reads back as `running`, and its template bundle contains exactly the accepted revision's guidance files.

## template-guidance-publication-009

- Vitest: "keeps the accepted user-template snapshot after metadata during startup"
- Mode: run
- Given: Row `user-template`, `metadata`. A workspace member has published a user template. While the Run's template package is being signed during startup, the owner renames it with `PATCH /api/user-templates/:templateId`.
- When: The owner sends a chat message selecting that template via `POST /api/chat/events` and a Runner picks up the Run.
- Then: The rename succeeds with HTTP 200 during startup, the Run reads back as `running`, and its template bundle contains exactly the accepted revision's guidance files.

## template-guidance-publication-010

- Vitest: "keeps the accepted presentation-template snapshot after metadata during startup"
- Mode: run
- Given: Row `presentation-template`, `metadata`. A workspace member has published a presentation template. While the Run's template package is being signed during startup, the owner renames it with `PATCH /api/presentation-templates/:templateId`.
- When: The owner sends a chat message selecting that template via `POST /api/chat/events` and a Runner picks up the Run.
- Then: The rename succeeds with HTTP 200 during startup, the Run reads back as `running`, and its template bundle contains exactly the accepted revision's guidance files.

## template-guidance-publication-011

- Vitest: "user-template bundle publication > uses the FIFO head's template when a later send supplies a different prefetch candidate"
- Mode: run
- Given: Kind `user-template`. The concurrent run limit is 1 and a blocker Run occupies the slot. The member has published two user templates (`head` and `later`) and queued "Use the head template" in a thread with the head template; the limit is then raised so capacity is free without a pick.
- When: The member sends "Use the later template" with the later template to the same thread via `POST /api/chat/events`, then the first launched Run is cancelled.
- Then: The first launched Run carries the head template's guidance files, and after it is cancelled the next Run carries the later template's guidance files.

## template-guidance-publication-012

- Vitest: "user-template bundle publication > captures claude-code guidance at dispatch and rejects later selection of a deleted template"
- Mode: run
- Given: Kind `user-template`, row `claude-code` (model `claude-fable-5-1`, Codex execution off, subscription Pi model configured). The member published a user template with guidance A plus `retired.txt`, sent a Run selecting it, replaced the package with guidance B, and sent a second Run selecting it.
- When: Both Runs are picked up by a Runner, the template is deleted with `DELETE /api/user-templates/:templateId`, and the member then sends a new message whose user message selects the deleted template via `POST /api/chat/events`.
- Then: The first Run uses the `claude-code` agent type and its template bundle mounts before the Memory mount. The first Run's bundle still holds guidance A plus `retired.txt`, and the second Run's bundle holds guidance B. The new send returns HTTP 201, then its input is rejected and the thread shows an `output.error` "Custom template not found".

## template-guidance-publication-013

- Vitest: "user-template bundle publication > captures codex guidance at dispatch and rejects later selection of a deleted template"
- Mode: run
- Given: Kind `user-template`, row `codex` (model `gpt-6-luna`, Codex execution on, subscription Pi model configured). The member published a user template with guidance A plus `retired.txt`, sent a Run selecting it, replaced the package with guidance B, and sent a second Run selecting it.
- When: Both Runs are picked up by a Runner, the template is deleted with `DELETE /api/user-templates/:templateId`, and the member then sends a new message whose user message selects the deleted template via `POST /api/chat/events`.
- Then: The first Run uses the `codex` agent type and its template bundle mounts before the Memory mount. The first Run's bundle still holds guidance A plus `retired.txt`, and the second Run's bundle holds guidance B. The new send returns HTTP 201, then its input is rejected and the thread shows an `output.error` "Custom template not found".

## template-guidance-publication-014

- Vitest: "user-template bundle publication > captures pi guidance at dispatch and rejects later selection of a deleted template"
- Mode: run
- Given: Kind `user-template`, row `pi` (model `gpt-6-luna`, Codex execution off, subscription Pi model configured). The member published a user template with guidance A plus `retired.txt`, sent a Run selecting it, replaced the package with guidance B, and sent a second Run selecting it.
- When: Both Runs are picked up by a Runner, the template is deleted with `DELETE /api/user-templates/:templateId`, and the member then sends a new message whose user message selects the deleted template via `POST /api/chat/events`.
- Then: The first Run uses the `pi` agent type and its template bundle mounts before the Memory mount. The first Run's bundle still holds guidance A plus `retired.txt`, and the second Run's bundle holds guidance B. The new send returns HTTP 201, then its input is rejected and the thread shows an `output.error` "Custom template not found".

## template-guidance-publication-015

- Vitest: "user-template bundle publication > keeps an uncertain object publication out of the catalog and safely reuses its immutable bytes"
- Mode: run
- Given: Kind `user-template`. A signed-in member has uploaded source, preview and package files. Storage stores the template bundle object but the provider's response to that first write is lost.
- When: The member publishes with `POST /api/user-templates`, lists templates with `GET /api/user-templates`, retries the same publish, and lists again.
- Then: The first publish returns HTTP 500 and the list is empty. The retry returns HTTP 200 and the list then contains exactly one template.

## template-guidance-publication-016

- Vitest: "presentation-template bundle publication > uses the FIFO head's template when a later send supplies a different prefetch candidate"
- Mode: run
- Given: Kind `presentation-template`. The concurrent run limit is 1 and a blocker Run occupies the slot. The member has published two presentation templates (`head` and `later`) and queued "Use the head template" in a thread with the head template; the limit is then raised so capacity is free without a pick.
- When: The member sends "Use the later template" with the later template to the same thread via `POST /api/chat/events`, then the first launched Run is cancelled.
- Then: The first launched Run carries the head template's guidance files, and after it is cancelled the next Run carries the later template's guidance files.

## template-guidance-publication-017

- Vitest: "presentation-template bundle publication > captures claude-code guidance at dispatch and rejects later selection of a deleted template"
- Mode: run
- Given: Kind `presentation-template`, row `claude-code` (model `claude-fable-5-1`, Codex execution off, subscription Pi model configured). The member published a presentation template with guidance A plus `retired.txt` and sent two Runs selecting it.
- When: Both Runs are picked up by a Runner, the template is deleted with `DELETE /api/presentation-templates/:templateId`, and the member then sends a new message whose user message selects the deleted template via `POST /api/chat/events`.
- Then: The first Run uses the `claude-code` agent type and its template bundle mounts before the Memory mount. Both Runs' bundles still hold guidance A plus `retired.txt`. The new send returns HTTP 201, then its input is rejected and the thread shows an `output.error` "Presentation template not found".

## template-guidance-publication-018

- Vitest: "presentation-template bundle publication > captures codex guidance at dispatch and rejects later selection of a deleted template"
- Mode: run
- Given: Kind `presentation-template`, row `codex` (model `gpt-6-luna`, Codex execution on, subscription Pi model configured). The member published a presentation template with guidance A plus `retired.txt` and sent two Runs selecting it.
- When: Both Runs are picked up by a Runner, the template is deleted with `DELETE /api/presentation-templates/:templateId`, and the member then sends a new message whose user message selects the deleted template via `POST /api/chat/events`.
- Then: The first Run uses the `codex` agent type and its template bundle mounts before the Memory mount. Both Runs' bundles still hold guidance A plus `retired.txt`. The new send returns HTTP 201, then its input is rejected and the thread shows an `output.error` "Presentation template not found".

## template-guidance-publication-019

- Vitest: "presentation-template bundle publication > captures pi guidance at dispatch and rejects later selection of a deleted template"
- Mode: run
- Given: Kind `presentation-template`, row `pi` (model `gpt-6-luna`, Codex execution off, subscription Pi model configured). The member published a presentation template with guidance A plus `retired.txt` and sent two Runs selecting it.
- When: Both Runs are picked up by a Runner, the template is deleted with `DELETE /api/presentation-templates/:templateId`, and the member then sends a new message whose user message selects the deleted template via `POST /api/chat/events`.
- Then: The first Run uses the `pi` agent type and its template bundle mounts before the Memory mount. Both Runs' bundles still hold guidance A plus `retired.txt`. The new send returns HTTP 201, then its input is rejected and the thread shows an `output.error` "Presentation template not found".

## template-guidance-publication-020

- Vitest: "presentation-template bundle publication > keeps an uncertain object publication out of the catalog and safely reuses its immutable bytes"
- Mode: run
- Given: Kind `presentation-template`. A signed-in member has uploaded source, preview and package files. Storage stores the template bundle object but the provider's response to that first write is lost.
- When: The member publishes with `POST /api/presentation-templates`, lists templates with `GET /api/presentation-templates`, retries the same publish, and lists again.
- Then: The first publish returns HTTP 500 and the list is empty. The retry returns HTTP 200 and the list then contains exactly one template.

## template-guidance-publication-021

- Vitest: "delivers a Skill and template with the same immutable bundle at their own mounts"
- Mode: run
- Given: A workspace member created a custom HTTP connector with a Skill and a secret, then published a document user template whose package is the same archive as that connector Skill bundle.
- When: The member sends a message whose user message selects the template via `POST /api/chat/events`, and a Runner picks up the Run.
- Then: The execution has a user-template bundle for that template, and the Skills bundles include an entry with the same SHA-256, size and download URL mounted at a `/skills/custom-bundle-reuse-…` path.

## template-guidance-publication-022

- Vitest: "mounts every user-template kind and presentation guidance once in selection order"
- Mode: run
- Given: A workspace member has published a presentation user template, a presentation template, a document user template and an illustration user template (with an example image), each with distinct guidance files.
- When: The member sends one message via `POST /api/chat/events` whose user message selects all templates twice, with document and illustration first in reverse creation order, and a Runner picks up the Run.
- Then: The execution contains exactly one bundle per selected template (four total), the user-template bundles appear in the caller's selection order, and each bundle's files equal the files published for that template.

## template-guidance-publication-023

- Vitest: "allows package replacement and retry after a completed metadata edit"
- Mode: run
- Given: A workspace member has published a user template with guidance A and renamed it to "Renamed before replacement" with organization visibility via `PATCH /api/user-templates/:templateId`.
- When: The member replaces the package with guidance B twice via `PUT /api/user-templates/:templateId/package`, reads `GET /api/user-templates/:templateId`, and sends a Run selecting the template.
- Then: Both replacements return HTTP 200 with the same ID, renamed title and visibility. The read returns the renamed title and `organization` visibility, and the Run's template bundle contains guidance B.

## template-guidance-publication-024

- Vitest: "does not overwrite a concurrent replacement that published first"
- Mode: run
- Given: Row `replacement`. A workspace member has published a user template with guidance A. A stale package replacement is paused while its bundle object is being written.
- When: A second replacement with the `winner` package is applied via `PUT /api/user-templates/:templateId/package` and completes first, then the stale replacement resumes; the member sends a Run selecting the template.
- Then: The winning replacement returns HTTP 200, the stale replacement returns HTTP 409, and the Run's template bundle contains the `winner` guidance.

## template-guidance-publication-025

- Vitest: "does not overwrite a concurrent metadata edit that published first"
- Mode: run
- Given: Row `metadata edit`. A workspace member has published a user template with guidance A. A stale package replacement is paused while its bundle object is being written.
- When: The member renames the template via `PATCH /api/user-templates/:templateId` while the replacement is paused, then the stale replacement resumes; the member sends a Run selecting the template.
- Then: The rename returns HTTP 200 with title "Renamed while publishing", the stale replacement returns HTTP 409, and the Run's template bundle still contains guidance A.

## template-guidance-publication-026

- Vitest: "delivers a valid template archive larger than the Skill bundle ceiling"
- Mode: run
- Given: A workspace member publishes a user template whose stored (uncompressed) archive contains guidance plus two 17 MiB binary assets.
- When: The member publishes via `POST /api/user-templates` and sends a Run selecting the template, and a Runner picks up the Run.
- Then: Publishing returns HTTP 200, the Run's template bundle is larger than 32 MiB, and the decoded `assets/first.bin` matches the uploaded bytes.

## template-guidance-publication-027

- Vitest: "rejects conflicting file and directory names before publication"
- Mode: run
- Given: A signed-in member uploads a template package that contains both a file named `assets` and a file at `assets/logo.png`.
- When: The member publishes it as a presentation user template via `POST /api/user-templates`.
- Then: The API responds with HTTP 400 and the error message "Invalid template guidance package".
