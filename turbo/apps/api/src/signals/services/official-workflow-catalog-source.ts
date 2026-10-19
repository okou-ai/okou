import { INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME } from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
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

Okou sends at most one Morning Brief email per automation event and derives its idempotency key from this run's event. Do not pass \`--idempotency-key\`, and do not construct a key from the prompt, the clock, a date, or a Run ID.

Save the final briefing to a UTF-8 Markdown file, within the CLI's 8000-character body limit. Choose a concise subject within its 180-character limit, then call:

\`okou notify mail --kind morning-brief --subject "Morning Brief" --file brief.md --json\`

Preserve the exact subject and file contents for retries. A \`queued\` receipt means delivery was accepted into the outbox; the delivery service owns provider retries, so do not submit another notification or wait for inbox delivery. \`sent\` means the provider accepted it, not that the user read or received it. Use \`okou notify get <notification-id> --json\` when you need the receipt's current status. Respect \`skipped\` and \`failed\` receipts without trying to force another attempt. After a transport timeout, retry only with the exact same subject and content, or query the receipt if its ID is known. A conflict means this event already has a notification with different content; do not regenerate the briefing to resend, and report the unresolved delivery state in the Chat.

Do not read application database tables or use internal application APIs, signed input or output URLs, or callback endpoints.`;

const SUGGESTION_CURATION_INSTRUCTION = `## Curate next-step suggestions

Run \`okou suggestion list --json\` to inspect the user's active suggestions and recent consumed/removed identities. Only Okou, the primary Agent, manages this user-owned pool. Retain useful actions, update changed content or priority, withdraw obsolete actions, and create verified new actions. There may be zero to ten active suggestions; do not fill a quota or replace the pool by calendar date. Larger integer priorities appear first, with no requirement for consecutive or unique values.

Re-verify every active suggestion before creating new ones, even when its source had no activity inside this check's review window. Read the current state of the source objects referenced in its draft and rationale, and use \`createdAt\` and \`updatedAt\` to judge time-sensitive wording. A suggestion has expired when verified current evidence shows its action is no longer useful: its meeting, deadline, or time window has passed; its pull request, issue, email thread, or Chat was merged, closed, answered, or resolved; the requested review, reply, or decision was already given; the failure was fixed; the user already handled it; or a newer event superseded it. Withdraw expired suggestions. When the same action remains useful but its facts changed, such as a rescheduled meeting, a new deadline, a changed status, or relative wording like "today" or "in two hours" that is no longer accurate, update its title, rationale, draft, or priority in place. When the remaining next action is materially different, withdraw the old suggestion and create the new action with a new identity. Age alone does not expire a suggestion. If its source cannot be read or verified, retain it unchanged and report the coverage gap.

Use \`okou suggestion create --file suggestion.json --json\`, \`okou suggestion update <id> --file changes.json --json\`, and \`okou suggestion delete <id> --json\`. A creation file contains a stable UUID \`id\`, concise \`title\` and \`rationale\`, integer \`priority\`, nullable \`threadId\`, and \`draft\` in the normal saved composer format: \`{ "draftUserMessage": { "version": 1, "parts": [{ "type": "text", "text": "A self-contained next-step prompt" }] }, "draftAttachments": null }\`. Existing authorized conversations use their exact thread ID; new conversations use null and are handled by Okou. Include verified background and source references in the draft. Do not modify the user's live composer or execute suggested work.

Preserve the same UUID and exact creation file after an uncertain result. A consumed/removed identity is terminal; do not replay it to restore an item. A genuinely new next action needs a new UUID. Match existing active suggestions before creating another. For a new action, use \`okou suggestion identity --key '<provider>:<canonical object or event id>:<specific next action>' --json\` to derive a stable UUID. Use the same key across hourly checks and Morning Brief; never include the current hour, run ID, or wording of the title. A materially new request, review head, or event needs a new action identity, not a permanent blacklist of the subject. If the identity command is unavailable, report the missing capability and retain/update existing suggestions without inventing a new identity convention. If the pool is full, explicitly decide which item to withdraw before creating another. If suggestion curation is disabled or unavailable, report the reason and continue the task's ordinary result without another publication channel. Otherwise, complete this phase even when no new suggestions are warranted, and briefly report whether existing suggestions were retained, updated, removed, or new ones published, with the verified reason for each update or removal.`;

const PROACTIVE_SUGGESTIONS_INSTRUCTION = `# Proactive Suggestions

Check whether the user's homepage suggestions need maintenance. This is an hourly background check, not a request to execute work or deliver a briefing.

Fix the upper time bound at the start of this check. Review the preceding hour with a 15-minute overlap. For the first check, or after a known interruption, review at most the preceding 24 hours. State coverage gaps rather than claiming complete history recovery. Also inspect commitments and meetings approaching in the next 24 hours. The review window bounds discovery of new work only; re-verify every active suggestion against its source's current state as described below.

Use ordinary connected skills and CLI commands for Gmail, GitHub, and Google Calendar. Read recent requests, decisions, review requests, failures, blockers, and approaching commitments. Skip disconnected sources without requesting setup. Use \`okou slack channel list --json\` and \`okou slack message history --channel <id> --oldest <start-ts> --latest <end-ts> --json\` for shared Slack channels. Follow nextCursor with --cursor, including empty pages with a cursor, keeping fixed time bounds. These commands do not expand thread replies or discover other DMs. Use \`okou chat list --unread --all-agents\` and \`okou chat messages --thread-id <id> --output-dir threads\` to read relevant authorized Chats. Do not treat unavailable sources, incomplete pages, or unread thread replies as absent work. Never withdraw an action just because its source could not be read.

${SUGGESTION_CURATION_INSTRUCTION}

Only read context and maintain suggestions. Never send email, notification mail, connector messages, or provider-side updates; never execute the suggested work or change the user's composer. Zero changes is a normal successful outcome. Leave only a concise diagnostic outcome in this background Chat. Do not read application database tables or internal APIs, signed input/output URLs, or callback endpoints.`;

const MORNING_BRIEF_INSTRUCTION =
  MORNING_BRIEF_CONTEXT_INSTRUCTION + MORNING_BRIEF_DELIVERY_INSTRUCTION;

// Temporary AgentSuggestion rollout (#39591): at GA, include the curation phase
// in MORNING_BRIEF_INSTRUCTION, switch installations back to morning-brief,
// retire internal-test-morning-brief, and remove the rollout selection code.
// Retain immutable revisions needed by captured and historical Runs.
const INTERNAL_TEST_MORNING_BRIEF_INSTRUCTION = [
  MORNING_BRIEF_CONTEXT_INSTRUCTION.trimEnd(),
  SUGGESTION_CURATION_INSTRUCTION,
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
      {
        name: PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
        lifecycle: "active",
        workflow: {
          displayName: "Proactive Suggestions",
          description:
            "Check connected sources hourly and maintain useful next steps on your home page.",
          instruction: PROACTIVE_SUGGESTIONS_INSTRUCTION,
          files: [],
        },
        blueprints: [
          {
            key: PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
            parameters: [
              {
                key: "cron",
                type: "string",
                required: true,
                format: "text",
                default: "0 * * * *",
              },
            ],
            desiredState: {
              kind: "schedule",
              schedule: {
                type: "cron",
                cronExpression: { parameter: "cron" },
                timezone: "UTC",
              },
            },
          },
        ],
        presentation: { category: "productivity" },
      },
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
