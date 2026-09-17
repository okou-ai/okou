import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { SharedMessage } from "@okouai/api-contracts/contracts/shared-threads";
import {
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import type { ChatRecommendedFollowup } from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  not,
  type SQL,
} from "drizzle-orm";
import { logger } from "../../lib/log";
import { stripMarkdown } from "../../lib/strip-markdown";
import { waitUntil } from "../context/wait-until";
import {
  AUXILIARY_TEXT_MAX_TOKENS,
  FAST_PATH_MODEL,
  generateTextWithUsage,
  isLlmConfigured,
  openRouterTokenCounts,
} from "../external/openrouter";
import { publishThreadListChanged } from "../external/realtime";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { safeJsonParse, settle, tapError } from "../utils";
import {
  generateAuxiliary,
  type RecordAuxiliaryGenerationDetail,
} from "./auxiliary-generation.service";
import { chatEventTextCondition } from "./chat-event-type.service";
import { visibleChatEventCondition } from "./chat-event-shared.service";
import {
  RECOMMENDED_FOLLOWUP_LIMIT,
  normalizeRecommendedFollowups,
} from "./chat-recommended-followups.service";
import {
  ChatThreadContentOwnershipChangedError,
  withChatThreadContentAdmission,
  withChatThreadContentWrite,
  type ChatThreadContentIdentity,
} from "./chat-thread-content-erasure-admission.service";
import { appendChatThreadEvent } from "./chat-thread-event.service";
import { queuedUserMessageExists } from "./chat-queued-event.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  canonicalChatEventVisibleContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";

const log = logger("api:chat-title");
/**
 * The eager title runs as `waitUntil` background work whose HTTP response has
 * already been delivered, so the request's own signal is not a lifetime for it:
 * passing that signal would cancel a legitimate late completion the moment the
 * client disconnects. Each fenced transaction instead carries its own real
 * deadline, sized as an outer bound on the admission helper's own budget — at
 * most three attempts, each statement capped at its `5s` statement timeout and
 * each lock wait at its `1s` lock timeout. It is a bound on this background
 * work, not a cancellation channel, and it never fences the provider itself.
 */
const TITLE_FENCE_DEADLINE_MS = 30_000;
const TITLE_MODEL = "google/gemini-3.1-flash-lite";
const TITLE_CONTEXT_CHAR_CAP = 150;
const TITLE_PRIOR_MESSAGE_CAP = 10;
const FOLLOWUP_CONTEXT_CHAR_CAP = 700;
const FOLLOWUP_CONTEXT_MESSAGE_CAP = 8;
const RECOMMENDED_FOLLOWUP_SYSTEM_PROMPT = [
  "You generate recommended follow-up messages for a chat.",
  "",
  `Generate exactly ${RECOMMENDED_FOLLOWUP_LIMIT.toString()} distinct follow-up messages that meaningfully advance the task. These are quick replies, not task briefs.`,
  "Usefulness is a hard requirement and takes priority over naturalness, brevity, and conversational tone.",
  "",
  "Conversation rules:",
  "- Treat the latest assistant reply as authoritative.",
  "- Focus on the latest unresolved decision or action.",
  "- A suggestion passes the utility gate only if it does at least one of the following:",
  "  - asks the assistant to take a concrete next action;",
  "  - makes or requests a decision, selection, constraint, or adjustment;",
  "  - asks a substantive question whose answer reduces uncertainty or changes the next step.",
  "- Never output a pure acknowledgement, thanks, praise, sympathy, status reaction, or conversation closer.",
  '- Invalid examples include: "Got it", "Thanks", "Sounds good", "知道了", "辛苦了", "好的", and "明白了".',
  "- If removing polite or social words leaves no action, decision, constraint, or substantive question, the suggestion is invalid.",
  "- Do not ask for information, links, status, summaries, lists, drafts, or artifacts already provided.",
  "- If the assistant is waiting for the user to take an action, suggest a conditional message for continuing after that action. Never claim the action has already been completed.",
  "- If the task is complete, suggest only genuinely useful next steps or refinements.",
  "- If the task is blocked, suggest the smallest safe unblock, a useful alternative, or a root-cause question.",
  "- If the latest assistant reply asks the user a direct question or offers to take an action, responding to it takes priority over all other follow-up ideas.",
  "- For a yes-or-no question, confirmation request, permission request, or action offer, return exactly these three directions in order: accept or proceed; decline, stop, or defer; adjust the proposal, add a condition, or choose a closely related alternative.",
  "- Each suggestion must directly answer or meaningfully respond to that question or offer. Do not revive an older topic merely for variety.",
  "- Never invent facts, actions, or user intent that are not supported by the conversation.",
  "",
  "Writing rules:",
  "- Match the user's language and conversational tone.",
  "- Write each suggestion as a very short, natural quick reply.",
  "- Express exactly one intent in one simple clause or question.",
  "- Make every suggestion effortless to read at a glance.",
  "- Remove every word that is not necessary.",
  "- Rely on the existing conversation context. Do not repeat names, IDs, links, dates, or other details unless essential for clarity.",
  "- Use natural contextual references when their meaning is unambiguous.",
  "- Avoid formal, bureaucratic, report-like, or assistant-style wording.",
  "- Do not label suggestions as positive, negative, or other.",
  "- Do not combine multiple requests into one suggestion.",
  "- Make the suggestions meaningfully distinct. Do not return paraphrases of the same intent.",
  "- Do not default to summaries, reports, release notes, or presentations.",
  "- Before returning the JSON, silently validate every suggestion: if the user sent it, the assistant must have a concrete action, decision, analysis, or meaningful question to handle. Replace any suggestion that fails this test.",
  "- When three obvious options are unavailable, derive distinct useful directions by executing, diagnosing, verifying, comparing alternatives, refining constraints, or deferring with an explicit continuation condition. Never pad with social filler.",
  `- Always return exactly ${RECOMMENDED_FOLLOWUP_LIMIT.toString()} suggestions.`,
  "",
  "Classification rules:",
  '- Use kind "talk" for discussion, questions, planning, analysis, refinement, or ordinary actions.',
  '- Use kind "generate" only when the suggestion naturally asks for one of the supported built-in generation outputs.',
  "- Supported generation types are:",
  "  - image: create or edit images and visual assets.",
  "  - video: create short generated videos.",
  "  - presentation: create slide decks or presentation documents.",
  "  - website: create hosted websites or web pages.",
  '- For kind "generate", include generationType as one of: image, video, presentation, website.',
  "- Never add a generation suggestion merely for variety.",
  "",
  "Output rules:",
  "- The prompt values are displayed as plain text, not rendered as Markdown.",
  "- Do not use Markdown, links, bullet markers, backticks, bold markers, italic markers, or presentation-only syntax inside prompt values.",
  "- Return only a JSON array.",
  "- Each item must be either:",
  '  {"prompt":"...","kind":"talk"}',
  "  or:",
  '  {"prompt":"...","kind":"generate","generationType":"website"}',
  "- Do not return explanations, Markdown fences, or any text outside the JSON array.",
].join("\n");

export interface ChatCompletionContextMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface ChatTitleInput {
  readonly currentUserMessage: string;
  readonly priorRounds?: readonly ChatCompletionContextMessage[];
}

interface ChatMessageForGeneration {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface ChatCompletionContextRow {
  readonly eventType: ChatEventType;
  readonly content: string | null;
  readonly userMessage: ChatEventUserMessage | null;
}

type SelectDb = Pick<Db, "select">;

function completedConversationContextMessageCondition(db: SelectDb) {
  return and(
    not(queuedUserMessageExists(db)),
    not(
      and(
        isNotNull(chatEvents.runId),
        exists(
          db
            .select({ one: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.id, chatEvents.runId),
                inArray(agentRuns.status, ["queued", "pending", "running"]),
              ),
            ),
        ),
      ) as SQL,
    ),
  ) as SQL;
}

function chatCompletionContextMessage(
  row: ChatCompletionContextRow,
): ChatCompletionContextMessage[] {
  const role = chatEventCompatibilityRole(row.eventType);
  const userMessage = requiredUserMessageForEvent(
    row.eventType,
    row.userMessage,
  );
  if (userMessage) {
    return [
      {
        role,
        content: projectUserMessage(userMessage).agentPrompt,
      },
    ];
  }
  return row.content === null ? [] : [{ role, content: row.content }];
}

async function generateFastPathText(
  model: typeof TITLE_MODEL | typeof FAST_PATH_MODEL,
  messages: readonly ChatMessageForGeneration[],
  maxTokens = AUXILIARY_TEXT_MAX_TOKENS,
  options?: {
    readonly stripMarkdown?: boolean;
    readonly acceptTruncatedText?: boolean;
    readonly record?: RecordAuxiliaryGenerationDetail;
  },
  signal?: AbortSignal,
): Promise<string | null> {
  const generation = await generateTextWithUsage(
    model,
    messages,
    maxTokens,
    {
      reasoning: { effort: model === TITLE_MODEL ? "minimal" : "low" },
      temperature: 0.3,
      ...(options?.acceptTruncatedText === true
        ? { acceptTruncatedText: true }
        : {}),
    },
    signal,
  );
  if (generation === null) {
    return null;
  }
  options?.record?.({
    truncated: generation.truncated === true,
    tokens: openRouterTokenCounts(generation.usage),
  });
  return options?.stripMarkdown === false
    ? generation.text
    : stripMarkdown(generation.text);
}

function generateChatTitle(
  input: ChatTitleInput,
  record: RecordAuxiliaryGenerationDetail,
): Promise<string | null> {
  const sections: string[] = [];

  if (input.priorRounds && input.priorRounds.length > 0) {
    const recent = input.priorRounds.slice(-TITLE_PRIOR_MESSAGE_CAP);
    const history = recent
      .map((message) => {
        return `${message.role}: ${message.content.slice(0, TITLE_CONTEXT_CHAR_CAP)}`;
      })
      .join("\n");
    sections.push(
      `Previous conversation (last ${recent.length} messages, for continuity):\n${history}`,
    );
  }

  sections.push(
    `Most recent user message:\n${input.currentUserMessage.slice(0, TITLE_CONTEXT_CHAR_CAP)}`,
  );

  // A title is persisted immutably onto the thread, so a mid-word fragment is
  // worse than leaving the thread untitled: truncation stays rejected here.
  return generateFastPathText(
    TITLE_MODEL,
    [
      {
        role: "system",
        content:
          "Generate a short, descriptive title (max 60 chars) for a chat conversation. Weight the most recent exchange highest, but use the earlier rounds to keep the title consistent as the thread evolves. Return only the title as plain text. Do not use any markdown syntax such as #, *, **, _, ---, ``` or quotes. Just plain text.",
      },
      {
        role: "user",
        content: sections.join("\n\n"),
      },
    ],
    AUXILIARY_TEXT_MAX_TOKENS,
    { record },
  );
}

/** Generate the immutable title stored with a public shared-thread snapshot. */
export async function generateSharedThreadTitle(
  messages: readonly SharedMessage[],
  signal: AbortSignal,
): Promise<string> {
  const recent = messages.slice(-TITLE_PRIOR_MESSAGE_CAP);
  const conversation = recent
    .map((message) => {
      return `${message.role}: ${message.content.slice(0, TITLE_CONTEXT_CHAR_CAP)}`;
    })
    .join("\n");
  const title = await generateAuxiliary(
    {
      feature: "shared_thread_title",
      generate: (record) => {
        // Public snapshots keep this title forever; a partial one is worse
        // than the fixed fallback, so truncation stays rejected.
        return generateFastPathText(
          TITLE_MODEL,
          [
            {
              role: "system",
              content:
                "Generate a short, descriptive title (max 60 chars) for this shared conversation. Return only the title as plain text. Do not use any markdown syntax such as #, *, **, _, ---, ``` or quotes. Just plain text.",
            },
            {
              role: "user",
              content: conversation,
            },
          ],
          AUXILIARY_TEXT_MAX_TOKENS,
          { record },
          signal,
        );
      },
      usable: (value) => {
        return Boolean(value);
      },
    },
    signal,
  );
  // Optional presentation only: never disclose the unshared source title.
  return title || "Shared conversation";
}

async function getLatestTitleContextMessages(
  db: SelectDb,
  threadId: string,
): Promise<ChatCompletionContextMessage[]> {
  const rows = await db
    .select({
      eventType: chatEvents.eventType,
      content: canonicalChatEventVisibleContent(),
      userMessage: canonicalChatEventUserMessage(),
      createdAt: chatEvents.createdAt,
      sequenceNumber: chatEvents.runEventSequenceNumber,
    })
    .from(chatEvents)
    .leftJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTextCondition(),
        visibleChatEventCondition(db),
        completedConversationContextMessageCondition(db),
      ),
    )
    .orderBy(desc(chatEvents.seqId))
    .limit(TITLE_PRIOR_MESSAGE_CAP);

  return rows.reverse().flatMap((row) => {
    return chatCompletionContextMessage(row);
  });
}

/**
 * The content-free canonical identity this one title operation is bound to,
 * frozen before any prior-round content is read and before the provider request
 * is sent. It exists because the generated title is prepared for the account
 * that owned the thread at initiation: reading ownership again only after the
 * provider answers would re-attribute that prepared content to whoever survives
 * the change. The pin is transient and never reaches a provider prompt, a
 * public contract, telemetry or a persisted copy.
 */
interface ChatTitleOwnershipPin {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly agentOwner: string;
  readonly orgId: string;
}

/**
 * The generated-title writer requires a resolved Agent, unlike the legal
 * null-Agent draft thread. `agents.org_id` and `agents.owner` are `NOT NULL`,
 * so a resolved Agent always carries both; they are nullable here only because
 * the identity resolution left-joins a nullable parent reference. A thread
 * whose Agent does not resolve therefore has no complete pin and no generated
 * title, which is the existing `agent_id IS NOT NULL` omission.
 */
function chatTitleOwnershipPin(
  identity: ChatThreadContentIdentity,
): ChatTitleOwnershipPin | null {
  if (
    identity.agentId === null ||
    identity.agentOwner === null ||
    identity.orgId === null
  ) {
    return null;
  }
  return {
    chatThreadId: identity.chatThreadId,
    userId: identity.userId,
    agentId: identity.agentId,
    agentOwner: identity.agentOwner,
    orgId: identity.orgId,
  };
}

/**
 * Compares the whole frozen pin, not just user and organization. An Agent owner
 * transfer inside the same organization moves `agentOwner` alone, so a check
 * that stopped at user and organization would hand a title generated for the
 * previous owner to the survivor.
 */
function matchesChatTitleOwnershipPin(
  identity: ChatThreadContentIdentity,
  pin: ChatTitleOwnershipPin,
): boolean {
  return (
    identity.chatThreadId === pin.chatThreadId &&
    identity.userId === pin.userId &&
    identity.agentId === pin.agentId &&
    identity.agentOwner === pin.agentOwner &&
    identity.orgId === pin.orgId
  );
}

/**
 * An optional generation whose canonical parents kept moving is a discarded
 * result for this workflow, exactly like a closed subject or a deleted thread:
 * the send that started it already succeeded and no title is owed. Every other
 * failure — a lock wait, a statement timeout, a rolled back transaction — stays
 * a failure and reaches the workflow's existing handler.
 */
async function discardOnOwnershipChange<T>(
  work: Promise<T>,
): Promise<T | null> {
  const result = await settle(work);
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof ChatThreadContentOwnershipChangedError) {
    return null;
  }
  throw result.error;
}

interface ChatTitleGenerationCapture {
  readonly pin: ChatTitleOwnershipPin;
  readonly priorRounds: readonly ChatCompletionContextMessage[];
}

/**
 * The local initiation boundary. One bounded admitted transaction resolves the
 * real persisted parents, compares the scheduling caller's user and
 * organization against them, admits the subjects they represent through B1 and
 * only then reads this thread's title eligibility and its bounded prior-round
 * context. A subject already known closed therefore never starts another title
 * generation, and the content-free identity is fixed before any account content
 * is read. The transaction commits before the provider await below: no database
 * transaction is ever held across that request.
 *
 * It takes no business lock, because this workflow is scheduled from inside the
 * request that holds the chat queue's own `FOR UPDATE` on this thread. A gate
 * that took `chat_threads` KEY SHARE would contend with that request and delay
 * every eager title behind a bounded lock wait, which is long enough for the
 * next scheduler to observe the thread still untitled and start a second,
 * wasted generation.
 *
 * So this gate carries no authority and the pin it returns is a candidate, not
 * a permission: ownership can move the moment it commits. Every guarantee is
 * re-established at completion, where the whole pin is compared again under
 * retained locks. This is a local initiation boundary only — not
 * external-provider fencing, and no proof of provider-side deletion.
 */
async function captureChatThreadTitleGeneration(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly includePriorRounds: boolean;
}): Promise<ChatTitleGenerationCapture | null> {
  const captured = await discardOnOwnershipChange(
    withChatThreadContentAdmission(
      args.db,
      {
        chatThreadId: args.threadId,
        authorize: (identity) => {
          return (
            identity.userId === args.userId &&
            identity.orgId === args.orgId &&
            identity.agentId !== null
          );
        },
      },
      async (tx, identity) => {
        const pin = chatTitleOwnershipPin(identity);
        if (pin === null || !(await shouldGenerateChatThreadTitle(tx, pin))) {
          return null;
        }
        return {
          pin,
          priorRounds: args.includePriorRounds
            ? await getLatestTitleContextMessages(tx, pin.chatThreadId)
            : [],
        };
      },
      AbortSignal.timeout(TITLE_FENCE_DEADLINE_MS),
    ),
  );
  return captured?.outcome === "written" ? captured.value : null;
}

/**
 * The late persistence transaction. It starts fresh: a new bounded
 * `READ COMMITTED` transaction resolves the current canonical identity,
 * rejects anything that no longer equals the original pin, admits the subjects
 * that matching identity represents, takes the Agent and thread identity locks
 * and revalidates under them — all before the title `UPDATE`, the durable
 * sidebar sequence and the `renamed` event, which stay in that one transaction.
 *
 * `authorize` compares the entire frozen pin, so a retry can only ever re-admit
 * the identity this title was generated for. A canonical parent that moved is
 * simply no longer authorized on the next attempt and the title is discarded;
 * the pin itself never rebinds to the survivor.
 */
async function persistGeneratedChatThreadTitle(
  db: Db,
  pin: ChatTitleOwnershipPin,
  title: string,
): Promise<void> {
  const persisted = await discardOnOwnershipChange(
    withChatThreadContentWrite(
      db,
      {
        chatThreadId: pin.chatThreadId,
        authorize: (identity) => {
          return matchesChatTitleOwnershipPin(identity, pin);
        },
      },
      async (tx) => {
        const [thread] = await tx
          .update(chatThreads)
          .set({ title, updatedAt: nowDate() })
          .where(
            and(
              eq(chatThreads.id, pin.chatThreadId),
              isNull(chatThreads.title),
              isNull(chatThreads.renamedAt),
              isNotNull(chatThreads.agentId),
            ),
          )
          .returning({
            id: chatThreads.id,
            agentId: chatThreads.agentId,
          });
        if (!thread?.agentId) {
          return false;
        }
        // The sidebar labels come from the admitted identity: `authorize`
        // proved the resolved parents equal this pin field by field and the
        // helper revalidated that same identity under the retained locks, so
        // the pin is the admitted identity rather than a stale caller label.
        await appendChatThreadEvent(tx, {
          kind: "renamed",
          userId: pin.userId,
          orgId: pin.orgId,
          chatThreadId: thread.id,
          agentId: thread.agentId,
          title,
        });
        return true;
      },
      AbortSignal.timeout(TITLE_FENCE_DEADLINE_MS),
    ),
  );

  // Only a committed title invalidates a sidebar, and only for the identity
  // that was admitted for it. A closed, missing, moved or no-longer-eligible
  // thread publishes nothing.
  if (persisted?.outcome === "written" && persisted.value) {
    await publishThreadListChanged({ userId: pin.userId, orgId: pin.orgId });
  }
}

async function shouldGenerateChatThreadTitle(
  db: SelectDb,
  pin: ChatTitleOwnershipPin,
): Promise<boolean> {
  const [thread] = await db
    .select({ title: chatThreads.title, renamedAt: chatThreads.renamedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, pin.chatThreadId))
    .limit(1);

  return Boolean(thread && thread.title === null && thread.renamedAt === null);
}

async function generateAndPersistChatThreadTitle(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly includePriorRounds: boolean;
}): Promise<void> {
  await tapError(
    (async () => {
      const captured = await captureChatThreadTitleGeneration(args);
      if (!captured) {
        return;
      }

      const { pin, priorRounds } = captured;
      const title = await generateAuxiliary({
        feature: "chat_title",
        generate: (record) => {
          return generateChatTitle(
            {
              currentUserMessage: args.prompt,
              priorRounds: priorRounds.length > 0 ? priorRounds : undefined,
            },
            record,
          );
        },
        usable: (value) => {
          return Boolean(value);
        },
        diagnosticContext: { threadId: args.threadId },
      });
      if (title) {
        await persistGeneratedChatThreadTitle(args.db, pin, title);
      }
    })(),
    (err) => {
      log.warn("Chat title persistence failed", {
        threadId: args.threadId,
        err,
      });
    },
  );
}

/**
 * Fire-and-forget eager title generation, shared by the inline web send route
 * and the queue drain. Every chat-thread-bound run passes through one of the
 * two, so the trigger source no longer decides whether a thread is titled
 * before its run finishes.
 */
export function scheduleChatThreadTitleGeneration(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly includePriorRounds: boolean;
}): void {
  if (!isLlmConfigured() || args.prompt.trim().length === 0) {
    return;
  }
  waitUntil(generateAndPersistChatThreadTitle(args));
}

export async function generateChatNotificationSummary(
  args: {
    readonly prompt: string;
    readonly resultText: string;
    readonly runId: string;
  },
  signal?: AbortSignal,
): Promise<string | null> {
  // Accepting truncated text makes an empty result reachable here: a partial
  // completion can be non-empty for the provider and still strip to nothing.
  // The caller reads `null` as "no summary" and shows its own copy, so the
  // empty string must never reach it as a notification body.
  return (
    (await generateAuxiliary(
      {
        feature: "notification_summary",
        diagnosticContext: { runId: args.runId },
        usable: (value) => {
          return Boolean(value);
        },
        generate: (record) => {
          // A shortened notification sentence still tells the user their task
          // finished; the alternative is a notification with no summary at all.
          return generateFastPathText(
            FAST_PATH_MODEL,
            [
              {
                role: "system",
                content:
                  "Summarize this completed task in one short notification sentence, max 90 chars. Plain text only.",
              },
              {
                role: "user",
                content: `User request:\n${args.prompt.slice(0, TITLE_CONTEXT_CHAR_CAP)}\n\nAssistant reply:\n${args.resultText.slice(0, TITLE_CONTEXT_CHAR_CAP)}`,
              },
            ],
            AUXILIARY_TEXT_MAX_TOKENS,
            { acceptTruncatedText: true, record },
            signal,
          );
        },
      },
      signal,
    )) || null
  );
}

function parseRecommendedFollowups(text: string): ChatRecommendedFollowup[] {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return normalizeRecommendedFollowups(safeJsonParse(unfenced));
}

async function getLatestFollowupContextMessages(
  db: SelectDb,
  threadId: string,
): Promise<ChatCompletionContextMessage[]> {
  const rows = await db
    .select({
      eventType: chatEvents.eventType,
      content: canonicalChatEventVisibleContent(),
      userMessage: canonicalChatEventUserMessage(),
      createdAt: chatEvents.createdAt,
      sequenceNumber: chatEvents.runEventSequenceNumber,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTextCondition(),
        visibleChatEventCondition(db),
        completedConversationContextMessageCondition(db),
      ),
    )
    .orderBy(desc(chatEvents.seqId))
    .limit(FOLLOWUP_CONTEXT_MESSAGE_CAP);

  return rows.reverse().flatMap((row) => {
    return chatCompletionContextMessage(row);
  });
}

async function generateRecommendedFollowups(
  messages: readonly ChatCompletionContextMessage[],
  record: RecordAuxiliaryGenerationDetail,
  signal?: AbortSignal,
): Promise<ChatRecommendedFollowup[]> {
  const context = messages
    .map((message) => {
      return `${message.role}: ${message.content.slice(0, FOLLOWUP_CONTEXT_CHAR_CAP)}`;
    })
    .join("\n\n");

  // The output must parse as JSON, so a truncated array is unusable by
  // construction and stays rejected.
  const text = await generateFastPathText(
    FAST_PATH_MODEL,
    [
      {
        role: "system",
        content: RECOMMENDED_FOLLOWUP_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `Recent conversation:\n${context}`,
      },
    ],
    AUXILIARY_TEXT_MAX_TOKENS,
    { stripMarkdown: false, record },
    signal,
  );

  return text === null ? [] : parseRecommendedFollowups(text);
}

export async function loadChatThreadRecommendedFollowupContext(args: {
  readonly db: SelectDb;
  readonly threadId: string;
}): Promise<ChatCompletionContextMessage[]> {
  return await getLatestFollowupContextMessages(args.db, args.threadId);
}

export async function generateChatThreadRecommendedFollowupsFromContext(
  args: {
    readonly messages: readonly ChatCompletionContextMessage[];
    readonly threadId?: string;
  },
  signal?: AbortSignal,
): Promise<ChatRecommendedFollowup[]> {
  const last = args.messages[args.messages.length - 1];
  if (last?.role !== "assistant" || last.content.trim().length === 0) {
    return [];
  }
  return (
    (await generateAuxiliary(
      {
        feature: "recommended_followups",
        generate: (record) => {
          return generateRecommendedFollowups(args.messages, record, signal);
        },
        usable: (value) => {
          return value.length > 0;
        },
        // Zero normalized suggestions is an omission this caller already
        // handles: the completed-run callback inserts no follow-up event and
        // the thread simply shows no quick replies, leaving the run's own
        // result untouched. Count it and say nothing. The generated text is
        // never inspected here, so the empty result cannot name a defect.
        unusableOutput: "expected",
        // Whatever still reaches the diagnostic after that is a failure rather
        // than an omission: rejected credentials, a rejected request, a
        // response that broke its contract, or an exception nothing
        // classified. The reason stays whatever the provider classification
        // decided, including `unknown`, which is left unknown rather than
        // presented as a specific cause.
        diagnosticContext: args.threadId
          ? { threadId: args.threadId }
          : undefined,
      },
      signal,
    )) ?? []
  );
}
