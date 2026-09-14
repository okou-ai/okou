import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  type OfficialWorkflowSourceCatalog,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";

const MORNING_BRIEF_INSTRUCTION = `# Morning Brief

Prepare a concise Markdown briefing that helps the user start the day with the most important current work.

## Collect current context

Attempt every connected, applicable source during each scheduled or manual run. Use only the ordinary connector skills, CLI commands, credentials, firewall rules, and capabilities available inside this sandbox. Check connected accounts before collecting context. Silently skip sources that are not connected or installed; do not request setup or suggest connecting them.

- Gmail: follow the Gmail connector skill to review recent or unread messages that may need attention. Prefer decisions, requests, deadlines, and blocked work over routine mail.
- GitHub: follow the GitHub connector skill to review relevant notifications, review requests, assigned issues and pull requests, failing checks, and other recent work that may need action.
- Google Calendar: follow the Google Calendar connector skill to review today's schedule and near-term meetings, deadlines, or conflicts.
- Slack (when connected): use \`okou slack channel list --json\` to discover channels shared by the user and Okou. If Slack is not installed or the user is not connected, skip this source without requesting setup. For each returned channel, use \`okou slack message history --channel <id> --oldest <start-ts> --latest <end-ts> --json\` to review the past 24 hours, with fixed Unix timestamps ending at the start of this run. Follow \`nextCursor\` with \`--cursor\` for both channel and history pages, including empty pages with a cursor, and retain the same time bounds. Summarize important discussions, decisions, requests, blockers, deadlines, and follow-ups, prioritizing mentions of the user and their commitments. Group related messages and include channel or message links when available. These commands do not expand thread replies or discover other DMs; state any coverage gaps, including incomplete reads due to access or rate limits, without treating unread messages as absent.
- Unread Chats: run \`okou chat list --unread --all-agents\`. For relevant unread threads, use \`okou chat messages --thread-id <thread-id> --output-dir threads\` to read the authorized history before summarizing it.

If a connected source cannot be read because of an access error, rate limit, or other failure, briefly state the resulting coverage gap and continue with the other connected sources. Never invent, infer, or claim source data that was not read.

## Produce the briefing

Return only the briefing as concise Markdown. Choose short headings and bullets based on the information actually found instead of following a fixed schema. Prioritize time-sensitive commitments, decisions, blockers, conflicts, and clear next actions; include source names and dates or times when useful.

Omit empty sections and disconnected-source inventories. Do not mention missing connections or include connector setup prompts in the briefing.

Do not read application database tables or use internal application APIs, signed input or output URLs, or callback endpoints. Do not send email, drafts, chat messages, or provider-side updates. The platform owns any result-email delivery after the run succeeds.`;

/**
 * The sole deployed source candidate. Every Definition uses the same validated
 * release boundary and immutable shared-artifact publication path.
 */
export const OFFICIAL_WORKFLOW_SOURCE_CATALOG: OfficialWorkflowSourceCatalog =
  Object.freeze<OfficialWorkflowSourceCatalog>({
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
    definitions: [
      {
        name: "morning-brief",
        lifecycle: "active",
        workflow: {
          displayName: "Morning Brief",
          description:
            "Summarize today's email, GitHub, calendar, connected Slack activity from the past 24 hours, and unread Chat priorities.",
          instruction: MORNING_BRIEF_INSTRUCTION,
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
            runtime: { resultEmail: true },
          },
        ],
        presentation: { category: "productivity" },
      },
      {
        name: "connector-doctor",
        lifecycle: "retired",
        presentation: { category: "productivity" },
      },
    ],
  });
