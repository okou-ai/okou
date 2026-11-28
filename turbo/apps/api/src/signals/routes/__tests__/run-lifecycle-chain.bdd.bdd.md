# run-lifecycle-chain.bdd

## run-lifecycle-chain.bdd-001

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > names the deck guide in the agent tools prompt"
- Mode: run
- Given: An entitled member with a registered Runner group.
- When: The member starts a chat Run with the prompt `turn this deck into a template` and the Runner reads the execution input.
- Then: The system prompt tells the agent to pull `skill:presentation-reverse-template` with `okou resource pull ... --dir ./generated/resources`, read `./generated/resources/reverse-template/SKILL.md` including its page-rendering and publish steps, and does not say to prefer Markdown as the primary deliverable.

## run-lifecycle-chain.bdd-002

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > guides ordinary runs to choose document formats by content"
- Mode: run
- Given: An entitled member with a registered Runner group and default output preferences.
- When: The member starts a chat Run asking to `write a project update` and the Runner reads the execution input.
- Then: The system prompt tells the agent to honor an explicitly requested format, use Markdown for text documents and HTML for visual or interactive deliverables, and keep Markdown as the source of truth with DOCX or PDF export by the user.

## run-lifecycle-chain.bdd-003

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > honors Markdown-first output opt-outs in run guidance"
- Mode: run
- Given: An entitled member has turned off the Markdown-first output feature switch.
- When: The member starts a chat Run asking to `write a project update` and the Runner reads the execution input.
- Then: The system prompt tells the agent to choose a suitable format based on the user's preferences and use, and omits the portable Markdown deliverable guidance.

## run-lifecycle-chain.bdd-004

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > advertises the installed Okou CLI in execution input"
- Mode: run
- Given: An entitled member with a registered Runner group.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt states `You have access to the Okou CLI. Run commands with: \`okou <command>\`.`

## run-lifecycle-chain.bdd-005

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > advertises private artifact sharing and downloads"
- Mode: run
- Given: An entitled member.
- When: The member starts a chat Run asking to share a report and the Runner reads the execution input.
- Then: The system prompt contains a line saying only the owner can change visibility of `/artifacts/xxx` links (see `okou artifact --help`) and the guidance to download private artifacts locally using `okou artifact download -h`.

## run-lifecycle-chain.bdd-006

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > advertises current Run usage and grants its Run capability"
- Mode: run
- Given: An entitled member with a registered Runner group.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt contains a line advertising `okou run usage --json` for current Run usage, and the Run's Okou token carries the `run-usage:read` capability.

## run-lifecycle-chain.bdd-007

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > advertises Lark messaging only while the organization rollout is enabled"
- Mode: run
- Given: An entitled member whose organization does not have the Lark rollout enabled.
- When: The member starts a chat Run, then enables the Lark integration feature switch and starts another, and the Runner reads both execution inputs.
- Then: The first system prompt does not mention `okou lark` but includes `okou feishu message send --help`. The second contains the Lark messaging guidance and `okou lark message send --help`.

## run-lifecycle-chain.bdd-008

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > dispatches execution input without connector scope"
- Mode: run
- Given: An entitled member with no connectors and a registered Runner group.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The system prompt includes `Timezone: UTC` and no user timezone is set. The environment has a `CLAUDE_CODE_OAUTH_TOKEN`, and there are no billable firewalls or connector runtime targets.

## run-lifecycle-chain.bdd-009

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > adopts a newly connected sibling account after repeated runs"
- Mode: run
- Given: An entitled member has connected X through OAuth.
- When: The member starts and cancels two Runs, connects Slack, starts and cancels a third Run, and searches connectors for `youtube`.
- Then: The first two Runs target only the X account. The third targets exactly the X and Slack accounts. The connector search includes `youtube`.

## run-lifecycle-chain.bdd-010

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > admits the connected account across a catalog capability change"
- Mode: run
- Given: An entitled member has connected X through OAuth.
- When: The member starts a Run with the Cal.com OAuth client configured and another with it unconfigured, and the Runner reads each execution input.
- Then: Both Runs target exactly the connected X account.

## run-lifecycle-chain.bdd-011

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > reuses current validator package authority"
- Mode: run
- Given: An entitled member has connected X through OAuth, and the deployment has a fixed commit SHA.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The execution's X firewall entry is exactly a built-in `x` entry with a source ID.

## run-lifecycle-chain.bdd-012

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > fails unavailable storage signing and preserves the complete manifest on a fresh retry"
- Mode: run
- Given: An entitled member on the native Runner route has completed a Run that committed a new Memory version, and has 17 read-only connector skills. Signing the Memory archive URL fails.
- When: The member continues the conversation, which fails during preparation; then signing recovers and the member retries in the same conversation.
- Then: The failed continuation appears in `GET /api/logs` as `failed`. The retry's execution includes all 17 skill bundles and a canonical Memory mount at the committed version with writeback, and no storage mount carries `orgId` or `userId`.

## run-lifecycle-chain.bdd-013

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > starts a Run for a member before Memory initialization finishes"
- Mode: run
- Given: An entitled workspace uses the native Runner route; a new member of that workspace with a personal subscription has never initialized Memory.
- When: The member starts a chat Run, the Runner reads the execution input, the Run is cancelled, and the member starts a second Run.
- Then: The first execution's Memory mount is empty with writeback and has a storage ID and version ID. The second Run's Memory mount is identical to the first.

## run-lifecycle-chain.bdd-014

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > prepares the storage manifest without uploading empty artifact objects"
- Mode: run
- Given: An entitled member on the native Runner route has a provisioned workspace and a newly created workflow.
- When: The member starts a chat Run, the Runner reads the execution input, and the sandbox prepares a Memory upload via `POST /api/webhooks/run/storages/prepare`.
- Then: The execution includes the workflow's skill bundle mounted at `/home/user/.claude/skills/<name>` with digest, size and download URL. The Memory mount is empty with a storage ID, version ID and `missingRootPolicy` `preserveParentVersion`, and no archive URL. No object was uploaded under the Memory storage prefix while the Run was being prepared.

## run-lifecycle-chain.bdd-015

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > resolves Connector and memory artifacts with exact candidates"
- Mode: run
- Given: An entitled member on the native Runner route has one read-only connector skill; Run context diagnostics are captured.
- When: The member starts a chat Run, the Runner reads the execution input, and the member requests `GET /api/runs/:id/context`.
- Then: The Run starts as `running`. The execution includes the connector skill bundle with its exact digest and size and a canonical Memory mount. The Run context returns HTTP 200 listing the Memory mount's path, name, version and `writeback: true`.

## run-lifecycle-chain.bdd-016

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > returns canonical storage manifests without API-only ownership fields"
- Mode: run
- Given: An entitled member on the native Runner route.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The canonical storage manifest includes a `memory` mount with writeback, and no storage mount includes `orgId` or `userId`.

## run-lifecycle-chain.bdd-017

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > persists canonical mounts across historyless session continuation"
- Mode: run
- Given: An entitled member on the native Runner route has two read-only connector skills.
- When: A first Run prepares and commits a new Memory version via the sandbox storage webhooks and completes with a native-only session and that Memory output via `POST /api/webhooks/run/complete`; the member then continues the conversation.
- Then: The first Run records a framework session ID. The continuation's execution includes both skill bundles and a Memory mount with the same storage ID, the committed version, the same mount path and writeback.

## run-lifecycle-chain.bdd-018

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > keeps a committed artifact head after initial empty artifact creation"
- Mode: run
- Given: A member with initialized native Memory starts a Run whose Memory mount is empty.
- When: The sandbox prepares and commits an empty Memory version, then prepares and commits a version with `artifact.txt` via `POST /api/webhooks/run/storages/prepare` and `/commit`, and the member starts a new Run.
- Then: The initial mount is empty with no archive URL. Preparing the empty version returns exactly that version with `existing: true`, and committing it returns success with 0 files and `deduplicated: true` without any storage requests. The new version's upload key ends with `/<version>/archive.tar.gz`, no manifest of the empty base is read, and the commit returns success with 1 file. The next Run's Memory mount has that version and an archive URL and is not empty.

## run-lifecycle-chain.bdd-019

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > keeps a direct launch claimable when run-context ingest fails"
- Mode: run
- Given: An entitled member; the diagnostic store rejects the Run context record for this prompt.
- When: The member starts a chat Run, the Runner reads the execution input, and the member requests `GET /api/runs/:id/context`.
- Then: The Run starts as `running` and the execution carries the prompt. The Run context returns HTTP 404.

## run-lifecycle-chain.bdd-020

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > keeps a direct launch claimable when sandbox telemetry ingest fails"
- Mode: run
- Given: An entitled member; ingest of sandbox operation telemetry fails.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The Run starts as `running` and the execution carries the prompt.

## run-lifecycle-chain.bdd-021

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > resumes the Agent execution session for a continued run"
- Mode: run
- Given: An entitled member on the native Runner route completed a first Run with a native-only Claude session via `POST /api/webhooks/run/complete`.
- When: The member continues the same conversation and the Runner reads the new execution input.
- Then: The execution's native continuation resumes the first Run's CLI session ID with a generation Run ID.

## run-lifecycle-chain.bdd-022

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > creates, dispatches, reports, and completes a Run through public APIs"
- Mode: run
- Given: A chat-ready member on the Pro tier with `claude-fable-5-1` selected.
- When: The member starts a chat Run; the Runner reads the execution input; the sandbox sends heartbeat, telemetry, one event and completion via `/api/webhooks/run/heartbeat`, `/telemetry`, `/events` and `/complete`; the member then tries `POST /api/runs/:id/cancel`.
- Then: The Run starts `running` with a thread UUID and the queue shows tier `pro` with 1 active Run. The execution carries the prompt, a `CLAUDE_CODE_OAUTH_TOKEN` and the `claude-code` agent, and the Run reads as `running` with `startedAt`. All webhooks return HTTP 200; the Run becomes `completed` with `completedAt` and a framework session ID, the queue drains to 0, and cancelling the completed Run returns HTTP 400.

## run-lifecycle-chain.bdd-023

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > resumes the previous session when a run continues the same thread"
- Mode: run
- Given: An entitled member on the native Runner route completed a first Run with a native-only session; a colleague in the same organization and a Pro user in another organization also exist.
- When: The member continues the conversation, the continuation completes reusing the session, and the colleague and outside user send messages into the conversation via `POST /api/chat/events`.
- Then: The continuation resumes the first CLI session ID, and both Runs report the same framework session ID. The colleague and the outside user each receive HTTP 404 with `NOT_FOUND`, and the first Run stays `completed`.

## run-lifecycle-chain.bdd-024

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > resumes thread sessions only on the same runtime and family"
- Mode: run
- Given: An entitled member uses native subscription models with `gpt-6-astra` selected and completed a first Run with a native-only session.
- When: A Runner heartbeats with no admittable profiles, the member continues on the same model, cancels it, then continues on the native Claude model.
- Then: The same-model continuation resumes the first session, keeps identical storage mounts, uses source `gpt-6-astra` via `codex-oauth-token`, and has no billable firewalls. The continuation on the Claude model runs the `claude-code` agent.

## run-lifecycle-chain.bdd-025

- Vitest: "CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks > requires an active producer list even when the Runner has no producers"
- Mode: run
- Given: A Runner reports its whole-state heartbeat.
- When: The Runner sends `POST /api/runners/heartbeat` with an empty `activeReuseProducers` list, then a full raw snapshot that omits `activeReuseProducers`.
- Then: The first heartbeat returns HTTP 200 with exactly `{ ok: true }`. The second returns HTTP 400 with code `BAD_REQUEST`.
