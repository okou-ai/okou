import { INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME } from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
  type OfficialWorkflowSourceCatalog,
  type OfficialWorkflowSourceDefinition,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";

const MORNING_BRIEF_CONTEXT_INSTRUCTION = `# Morning Brief

Prepare a concise Markdown briefing that helps the user start the day with the most important current work.

## Collect current context

Attempt every applicable source during each scheduled or manual run. Use only the ordinary connector skills, CLI commands, credentials, firewall rules, and capabilities available inside this sandbox.

- Gmail: follow the Gmail connector skill to review recent or unread messages that may need attention. Prefer decisions, requests, deadlines, and blocked work over routine mail.
- GitHub: follow the GitHub connector skill to review relevant notifications, review requests, assigned issues and pull requests, failing checks, and other recent work that may need action.
- Google Calendar: follow the Google Calendar connector skill to review today's schedule and near-term meetings, deadlines, or conflicts.
- Slack (when connected): use \`okou slack channel list --json\` to discover channels shared by the user and Okou. If Slack is not installed or the user is not connected, skip this source without requesting setup. For each returned channel, use \`okou slack message history --channel <id> --oldest <start-ts> --latest <end-ts> --json\` to review the past 24 hours, with fixed Unix timestamps ending at the start of this run. Follow \`nextCursor\` with \`--cursor\` for both channel and history pages, including empty pages with a cursor, and retain the same time bounds. Summarize important discussions, decisions, requests, blockers, deadlines, and follow-ups, prioritizing mentions of the user and their commitments. Group related messages and include channel or message links when available. These commands do not expand thread replies or discover other DMs; state any coverage gaps, including incomplete reads due to access or rate limits, without treating unread messages as absent.
- Unread Chats: run \`okou chat list --unread --all-agents\`. For relevant unread threads, use \`okou chat messages --thread-id <thread-id> --output-dir threads\` to read the authorized history before summarizing it.

If a source, connector, thread, or capability is unavailable, say that it was unavailable and continue with the other sources. Never invent, infer, or claim source data that was not read.

## Produce the briefing

Prepare the briefing as concise Markdown and return it in the Chat. Choose short headings and bullets based on the information actually found instead of following a fixed schema. Prioritize time-sensitive commitments, decisions, blockers, conflicts, and clear next actions; include source names and dates or times when useful.

`;

const MORNING_BRIEF_DELIVERY_INSTRUCTION = `## Decide whether to email the briefing

You own the email decision. Send only when the verified briefing contains useful information worth notifying the user about, such as an upcoming commitment, a decision or request needing attention, a blocker, a conflict, or a clear next action. A completed run, an empty briefing, routine noise, or unavailable sources alone are not reasons to send. When there is nothing useful to notify, skip email and leave the briefing and coverage information in the Chat.

Use only \`okou notify mail --kind morning-brief\` to send to the user's account email. The platform does not send a second completion email for this revision. Do not create Gmail or Outlook drafts, send through a connector, send chat messages, or make other provider-side updates. If the notification command or capability is unavailable, keep the briefing in the Chat and report that email was unavailable; do not substitute another delivery channel or notification kind.

## Send once per automation event

Read the server-provided Automation identity block in this run's prompt. Use its exact \`automationId\` and \`automationEventId\` to form the idempotency key \`morning-brief:<automationId>:<automationEventId>\`. This identity comes from Okou, not from the external event payload. Never use the current clock, only a calendar date, or a Run ID: retries of one event must reuse its key, while separate manual requests must remain distinct even when they share a timestamp.

If the Automation identity block or either ID is missing, do not invent a key or send a new notification; report the missing context in the Chat. If a resumed event already submitted a notification, retain its original key and exact subject and body instead of deriving a replacement key from the current prompt.

Save the final briefing to a UTF-8 Markdown file, within the CLI's 8000-character body limit. Choose a concise subject within its 180-character limit, then call:

\`okou notify mail --kind morning-brief --subject "Morning Brief" --file brief.md --idempotency-key "<event-key>" --json\`

Preserve the exact subject, file contents, and event key for retries. A \`queued\` receipt means delivery was accepted into the outbox; the delivery service owns provider retries, so do not submit another notification or wait for inbox delivery. \`sent\` means the provider accepted it, not that the user read or received it. Use \`okou notify get <notification-id> --json\` when you need the receipt's current status. Respect \`skipped\` and \`failed\` receipts without choosing a new key to force another attempt. After a transport timeout, retry only the same key and exact content, or query the receipt if its ID is known. On a content conflict, do not change the key or regenerate the briefing to resend; report the unresolved delivery state in the Chat. If the original content cannot be recovered, do not start a new notification for this event.

Do not read application database tables or use internal application APIs, signed input or output URLs, or callback endpoints.`;

const MORNING_BRIEF_SUGGESTION_INSTRUCTION = `## Curate next-step suggestions

Before completing the briefing or making its email decision, run \`okou suggestion list --json\` to inspect the user's active suggestions and recent consumed/removed identities. Only Okou, the primary Agent, manages this user-owned pool. Retain useful actions, update changed content or priority, withdraw obsolete actions, and create verified new actions. There may be zero to ten active suggestions; do not fill a quota or replace the pool by calendar date. Larger integer priorities appear first, with no requirement for consecutive or unique values.

Use \`okou suggestion create --file suggestion.json --json\`, \`okou suggestion update <id> --file changes.json --json\`, and \`okou suggestion delete <id> --json\`. A creation file contains a stable UUID \`id\`, concise \`title\` and \`rationale\`, integer \`priority\`, nullable \`threadId\`, and \`draft\` in the normal saved composer format: \`{ "draftUserMessage": { "version": 1, "parts": [{ "type": "text", "text": "A self-contained next-step prompt" }] }, "draftAttachments": null }\`. Existing authorized conversations use their exact thread ID; new conversations use null and are handled by Okou. Include verified background and source references in the draft. Do not modify the user's live composer or execute suggested work.

Preserve the same UUID and exact creation file after an uncertain result. A consumed/removed identity is terminal; do not replay it to restore an item. A genuinely new next action needs a new UUID. If the pool is full, explicitly decide which item to withdraw before creating another. If the command or capability is unavailable, explicitly report that suggestion curation was unavailable and why; continue producing the useful briefing and its normal email decision without another publication channel. Otherwise, complete this phase even when no new suggestions are warranted, and briefly report whether existing suggestions were retained, updated, removed, or new ones published.`;

const MORNING_BRIEF_INSTRUCTION =
  MORNING_BRIEF_CONTEXT_INSTRUCTION + MORNING_BRIEF_DELIVERY_INSTRUCTION;

// Temporary AgentSuggestion rollout (#39591): at GA, include the curation phase
// in MORNING_BRIEF_INSTRUCTION, switch installations back to morning-brief,
// retire internal-test-morning-brief, and remove the rollout selection code.
// Retain immutable revisions needed by captured and historical Runs.
const INTERNAL_TEST_MORNING_BRIEF_INSTRUCTION = [
  MORNING_BRIEF_CONTEXT_INSTRUCTION.trimEnd(),
  MORNING_BRIEF_SUGGESTION_INSTRUCTION,
  MORNING_BRIEF_DELIVERY_INSTRUCTION,
].join("\n\n");

function morningBriefDefinition(
  name: string,
  instruction: string,
): OfficialWorkflowSourceDefinition {
  return {
    name,
    lifecycle: "active",
    workflow: {
      displayName: "Morning Brief",
      description:
        "Summarize today's email, GitHub, calendar, connected Slack activity from the past 24 hours, and unread Chat priorities.",
      instruction,
      files: [],
    },
    blueprints: [
      {
        key: "daily-delivery",
        parameters: [],
        desiredState: {
          kind: "schedule",
          schedule: {
            type: "cron",
            cronExpression: "0 7 * * *",
          },
        },
      },
    ],
    presentation: { category: "productivity" },
  };
}

/**
 * The sole deployed source candidate. Every Definition uses the same validated
 * release boundary and immutable shared-artifact publication path.
 */
export const OFFICIAL_WORKFLOW_SOURCE_CATALOG: OfficialWorkflowSourceCatalog =
  Object.freeze<OfficialWorkflowSourceCatalog>({
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
    definitions: [
      morningBriefDefinition("morning-brief", MORNING_BRIEF_INSTRUCTION),
      morningBriefDefinition(
        INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME,
        INTERNAL_TEST_MORNING_BRIEF_INSTRUCTION,
      ),
      {
        name: "connector-doctor",
        lifecycle: "retired",
        presentation: { category: "productivity" },
      },
    ],
  });
