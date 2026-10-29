import { createHash, randomUUID } from "node:crypto";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { suggestionFeedbacks } from "@okouai/api-contracts/contracts/suggestion-context";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import { isDeepStrictEqual } from "node:util";
import { command } from "ccstate";
import { and, arrayContains, eq, not, sql } from "drizzle-orm";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  suggestionSchema,
  getSuggestionExpiresAt,
  type Suggestion,
  type SuggestionCreate,
  type SuggestionUpdate,
  type SuggestionConsume,
  type SuggestionFeedback,
  type SuggestionFeedbackRequest,
} from "@okouai/api-contracts/contracts/suggestions";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$, writeDb$ } from "../external/db";
import {
  badRequestMessage,
  conflict,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
import { publishAgentSuggestionsChangedSafely } from "../external/realtime";
import { isMorningBriefDefinitionName } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { PROACTIVE_SUGGESTIONS_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { loadProactiveWorkflowsEligibility$ } from "./proactive-workflows-eligibility.service";
import {
  liveSuggestion,
  retainedSuggestion,
  suggestionRow,
  suggestionContent,
} from "./agent-suggestions-lifecycle";
import {
  storedSuggestion$,
  suggestionOwner,
} from "./agent-suggestion-read.service";
import {
  hasValidSuggestionConsumeToken,
  withSuggestionConsumeToken,
} from "./agent-suggestion-consumption-token";
import {
  PROACTIVE_LEARNING_DEFINITION_NAME,
  PROACTIVE_PLANNING_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-nightly";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}
function scope(owner: Owner, id: string) {
  return and(suggestionOwner(owner), eq(agentSuggestions.id, id));
}
function containsOption(optionId: string) {
  return optionId === "custom"
    ? sql`${agentSuggestions.content}->'customOption'->>'id' = 'custom'`
    : sql`${agentSuggestions.content}->'options' @> ${sql.param(JSON.stringify([{ id: optionId }]))}::jsonb`;
}
function feedbackIdentity(id: string) {
  return arrayContains(
    agentSuggestions.feedbacks,
    sql`${sql.param(JSON.stringify([{ id }]))}::jsonb`,
  );
}
/** Feedback context is captured from the canonical card in the same write. */
type NewFeedback = Omit<SuggestionFeedback, "context">;
function feedbackInput(
  kind: SuggestionFeedback["kind"],
  id: string = randomUUID(),
  targetId: string | null = null,
  note = "",
): NewFeedback {
  return {
    id,
    kind,
    targetId,
    note,
    learnedAt: null,
    createdAt: nowDate().toISOString(),
  };
}
function storedFeedback(feedback: NewFeedback, optionId?: string | null) {
  const context =
    feedback.targetId === null
      ? sql`jsonb_build_object('title', ${agentSuggestions.content}->'title', 'rationale', ${agentSuggestions.content}->'rationale', 'scope', ${agentSuggestions.content}->'feedbackScope', 'optionLabel', (SELECT choice->'label' FROM jsonb_array_elements(${agentSuggestions.content}->'options') AS choice WHERE choice->>'id' = ${optionId ?? ""} LIMIT 1))`
      : sql`(SELECT previous->'context' FROM jsonb_array_elements(${agentSuggestions.feedbacks}) AS previous WHERE previous->>'id' = ${feedback.targetId} LIMIT 1)`;
  return sql`(${sql.param(JSON.stringify(feedback))}::jsonb || jsonb_build_object('context', ${context}))`;
}
export const suggestionAccess$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(FeatureSwitchKey.AgentSuggestion, {
        userId: auth.userId,
        orgId: auth.orgId,
        overrides,
      })
    ) {
      return resourceUnavailable("Agent Suggestion is not enabled.");
    }
    if (auth.tokenType === "agent") {
      const [run] = await get(db$)
        .select({
          id: agentRuns.id,
          agentId: agentRuns.agentId,
          triggerSource: agentRuns.triggerSource,
          provenance: agentRuns.officialWorkflowProvenance,
        })
        .from(agentRuns)
        .innerJoin(
          orgMetadata,
          and(
            eq(orgMetadata.orgId, auth.orgId),
            eq(orgMetadata.defaultAgentId, agentRuns.agentId),
          ),
        )
        .where(
          and(
            eq(agentRuns.id, auth.runId),
            eq(agentRuns.userId, auth.userId),
            eq(agentRuns.orgId, auth.orgId),
            eq(agentRuns.status, "running"),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!run) {
        return resourceUnavailable(
          "Suggestions are available only to a running Okou primary Agent.",
        );
      }
      if (
        run.provenance?.definitions.some((definition) => {
          return definition.name === PROACTIVE_LEARNING_DEFINITION_NAME;
        })
      ) {
        return resourceUnavailable(
          "Learning maintains memory, not Suggestions.",
        );
      }
      if (
        run.provenance?.definitions.some((definition) => {
          return definition.name === PROACTIVE_PLANNING_DEFINITION_NAME;
        }) ||
        ((run.triggerSource === "automation-schedule" ||
          run.triggerSource === "automation-event") &&
          run.provenance?.definitions.some((definition) => {
            return (
              definition.name === PROACTIVE_SUGGESTIONS_DEFINITION_NAME ||
              isMorningBriefDefinitionName(definition.name)
            );
          }))
      ) {
        const preference = await set(
          loadProactiveWorkflowsEligibility$,
          auth,
          signal,
        );
        if (
          !preference.suggestions.active ||
          preference.agentId !== run.agentId
        ) {
          return resourceUnavailable(
            "Automatic suggestion curation is disabled or no longer available. Continue without changing suggestions.",
          );
        }
      }
    }
    return { userId: auth.userId, orgId: auth.orgId };
  },
);

const validateThread$ = command(
  async (
    { get },
    owner: Owner,
    threadId: string | null,
    signal: AbortSignal,
  ) => {
    if (threadId === null) {
      return null;
    }
    const [thread] = await get(db$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, owner.userId),
          chatThreadOrganizationPredicate(owner.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return thread ? null : notFound("Thread not found");
  },
);

export const createSuggestion$ = command(
  async (
    { set },
    owner: Owner,
    input: SuggestionCreate,
    signal: AbortSignal,
  ) => {
    for (const option of input.options) {
      const invalid = await set(
        validateThread$,
        owner,
        option.threadId,
        signal,
      );
      if (invalid) {
        return invalid;
      }
    }
    const at = nowDate();
    const timestamp = at.toISOString();
    const expiresAt = new Date(
      getSuggestionExpiresAt({
        updatedAt: timestamp,
        expiresAt: input.expiresAt,
      }),
    ).toISOString();
    if (Date.parse(expiresAt) <= at.getTime()) {
      return badRequestMessage("Suggestion expiry must be in the future.");
    }
    const item = suggestionSchema.parse({
      ...input,
      expiresAt,
      status: "active",
      selectedOptionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const [inserted] = await set(writeDb$)
      .insert(agentSuggestions)
      .values({
        ...owner,
        id: item.id,
        status: item.status,
        priority: item.priority,
        content: suggestionContent(item),
        selectedOptionId: null,
        feedbacks: [],
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(expiresAt),
      })
      .onConflictDoUpdate({
        target: [
          agentSuggestions.orgId,
          agentSuggestions.userId,
          agentSuggestions.id,
        ],
        set: {
          status: "active",
          priority: item.priority,
          content: suggestionContent(item),
          selectedOptionId: null,
          feedbacks: [],
          createdAt: at,
          updatedAt: at,
          expiresAt: new Date(expiresAt),
        },
        setWhere: not(retainedSuggestion(at)),
      })
      .returning();
    signal.throwIfAborted();
    if (inserted) {
      await publishAgentSuggestionsChangedSafely(owner);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: withSuggestionConsumeToken(owner, item),
      };
    }
    const existing = await set(storedSuggestion$, owner, input.id, signal);
    if (
      existing?.status === "active" &&
      existing.title === input.title &&
      existing.rationale === input.rationale &&
      existing.priority === input.priority &&
      isDeepStrictEqual(existing.feedbackScope, input.feedbackScope) &&
      isDeepStrictEqual(existing.options, input.options) &&
      isDeepStrictEqual(existing.customOption, input.customOption)
    ) {
      return {
        status: 200 as const,
        body: withSuggestionConsumeToken(owner, existing),
      };
    }
    return conflict(
      "Suggestion identity already exists with different content or has been consumed/removed. Update an active suggestion or use a new ID for a new action.",
    );
  },
);

const changeSuggestion$ = command(
  async (
    { set },
    owner: Owner,
    id: string,
    patch: SuggestionUpdate & {
      readonly status?: "consumed" | "removed";
      readonly selectedOptionId?: string | null;
      readonly feedback?: NewFeedback;
    },
    signal: AbortSignal,
  ) => {
    const at = nowDate();
    const timestamp = at.toISOString();
    const {
      feedback,
      status,
      selectedOptionId,
      priority,
      expiresAt,
      ...content
    } = patch;
    const [row] = await set(writeDb$)
      .update(agentSuggestions)
      .set({
        content: Object.keys(content).length
          ? sql`${agentSuggestions.content} || ${sql.param(JSON.stringify(content))}::jsonb`
          : undefined,
        priority,
        status,
        selectedOptionId,
        updatedAt: at,
        expiresAt:
          status === undefined
            ? new Date(
                getSuggestionExpiresAt({ updatedAt: timestamp, expiresAt }),
              )
            : undefined,
        feedbacks: feedback
          ? sql`${agentSuggestions.feedbacks} || jsonb_build_array(${storedFeedback(feedback, selectedOptionId)})`
          : undefined,
      })
      .where(
        and(
          scope(owner, id),
          patch.feedbackScope
            ? eq(
                sql`${agentSuggestions.content}->'feedbackScope'->>'key'`,
                patch.feedbackScope.key,
              )
            : undefined,
          feedback
            ? and(
                sql`jsonb_array_length(${agentSuggestions.feedbacks}) < 100`,
                not(feedbackIdentity(feedback.id)),
              )
            : undefined,
          status === "consumed"
            ? eq(agentSuggestions.status, "active")
            : liveSuggestion(at),
          typeof selectedOptionId === "string"
            ? containsOption(selectedOptionId)
            : undefined,
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const result = suggestionSchema.parse(suggestionRow(row));
    await publishAgentSuggestionsChangedSafely(owner);
    signal.throwIfAborted();
    return result;
  },
);

export const updateSuggestion$ = command(
  async (
    { set },
    owner: Owner,
    id: string,
    input: SuggestionUpdate,
    signal: AbortSignal,
  ) => {
    if (
      input.expiresAt !== undefined &&
      Date.parse(input.expiresAt) <= nowDate().getTime()
    ) {
      return badRequestMessage("Suggestion expiry must be in the future.");
    }
    if (input.options) {
      for (const option of input.options) {
        const invalid = await set(
          validateThread$,
          owner,
          option.threadId,
          signal,
        );
        if (invalid) {
          return invalid;
        }
      }
    }
    const item = await set(changeSuggestion$, owner, id, input, signal);
    return item
      ? { status: 200 as const, body: withSuggestionConsumeToken(owner, item) }
      : conflict("Suggestion is unavailable or no longer active.");
  },
);
export const removeSuggestion$ = command(
  async ({ set }, owner: Owner, id: string, signal: AbortSignal) => {
    await set(changeSuggestion$, owner, id, { status: "removed" }, signal);
    return { status: 204 as const, body: undefined };
  },
);

const consumeCachedSuggestion$ = command(
  async (
    { set },
    owner: Owner,
    snapshot: Suggestion,
    action: {
      readonly optionId: string | null;
      readonly feedback: NewFeedback;
    },
    signal: AbortSignal,
  ) => {
    const { optionId, feedback } = action;
    const at = nowDate();
    const item = suggestionSchema.parse({
      ...snapshot,
      consumeToken: undefined,
      status: "consumed",
      selectedOptionId: optionId,
      feedbacks: [
        ...snapshot.feedbacks,
        {
          ...feedback,
          context: {
            title: snapshot.title,
            rationale: snapshot.rationale,
            scope: snapshot.feedbackScope,
            optionLabel:
              snapshot.options.find((option) => {
                return option.id === optionId;
              })?.label ?? null,
          },
        },
      ],
      updatedAt: at.toISOString(),
    });
    const [inserted] = await set(writeDb$)
      .insert(agentSuggestions)
      .values({
        ...owner,
        id: item.id,
        status: "consumed",
        priority: item.priority,
        content: suggestionContent(item),
        selectedOptionId: optionId,
        feedbacks: item.feedbacks,
        createdAt: new Date(item.createdAt),
        updatedAt: at,
        expiresAt: new Date(getSuggestionExpiresAt(snapshot)),
      })
      .onConflictDoUpdate({
        target: [
          agentSuggestions.orgId,
          agentSuggestions.userId,
          agentSuggestions.id,
        ],
        set: {
          status: "consumed",
          priority: item.priority,
          content: suggestionContent(item),
          selectedOptionId: optionId,
          feedbacks: item.feedbacks,
          createdAt: new Date(item.createdAt),
          updatedAt: at,
          expiresAt: new Date(getSuggestionExpiresAt(snapshot)),
        },
        setWhere: not(retainedSuggestion(at)),
      })
      .returning({ id: agentSuggestions.id });
    signal.throwIfAborted();
    if (!inserted) {
      // Publication may have won after the first consume found no active card.
      // Consume its canonical value rather than replacing it with cached data.
      return await set(
        changeSuggestion$,
        owner,
        snapshot.id,
        { status: "consumed", selectedOptionId: optionId, feedback },
        signal,
      );
    }
    await publishAgentSuggestionsChangedSafely(owner);
    signal.throwIfAborted();
    return item;
  },
);

export const consumeSuggestion$ = command(
  async (
    { set },
    owner: Owner,
    id: string,
    input: SuggestionConsume,
    signal: AbortSignal,
  ) => {
    const { optionId, snapshot } = input;
    const feedback = feedbackInput(
      optionId === null ? "dismissed" : "option_selected",
    );
    if (optionId === "custom") {
      return conflict(
        "Send your question or direction to choose the custom option.",
      );
    }
    let item = await set(
      changeSuggestion$,
      owner,
      id,
      { status: "consumed", selectedOptionId: optionId, feedback },
      signal,
    );
    if (
      item === null &&
      snapshot?.id === id &&
      hasValidSuggestionConsumeToken(owner, snapshot) &&
      (optionId === null ||
        snapshot.options.some((option) => {
          return option.id === optionId;
        }))
    ) {
      item = await set(
        consumeCachedSuggestion$,
        owner,
        snapshot,
        { optionId, feedback },
        signal,
      );
    }
    return item
      ? { status: 200 as const, body: item }
      : conflict("Suggestion or selected option is no longer available.");
  },
);

type FeedbackRequest = SuggestionFeedbackRequest & {
  readonly snapshot?: Suggestion;
};

const recordInitialSuggestionFeedback$ = command(
  async (
    { set },
    owner: Owner,
    id: string,
    input: FeedbackRequest,
    signal: AbortSignal,
  ) => {
    const feedback = feedbackInput(
      input.kind,
      input.id,
      input.targetId,
      input.note,
    );
    if (input.targetId !== null) {
      return badRequestMessage(
        "This feedback does not target an earlier response.",
      );
    }
    const [saved] = await set(writeDb$)
      .update(agentSuggestions)
      .set({
        status: "consumed",
        selectedOptionId: null,
        updatedAt: nowDate(),
        feedbacks: sql`${agentSuggestions.feedbacks} || jsonb_build_array(${storedFeedback(feedback)})`,
      })
      .where(
        and(
          scope(owner, id),
          eq(agentSuggestions.status, "active"),
          sql`jsonb_array_length(${agentSuggestions.feedbacks}) < 100`,
          not(feedbackIdentity(input.id)),
        ),
      )
      .returning({ id: agentSuggestions.id });
    signal.throwIfAborted();
    if (saved) {
      await publishAgentSuggestionsChangedSafely(owner);
      signal.throwIfAborted();
      return { status: 200 as const, body: { restored: false } };
    }
    let changed: Suggestion | null = null;
    if (
      input.snapshot?.id === id &&
      hasValidSuggestionConsumeToken(owner, input.snapshot)
    ) {
      changed = await set(
        consumeCachedSuggestion$,
        owner,
        input.snapshot,
        { optionId: null, feedback },
        signal,
      );
    }
    if (changed) {
      return { status: 200 as const, body: { restored: false } };
    }
    const current = await set(storedSuggestion$, owner, id, signal);
    return current?.feedbacks.some((item) => {
      return (
        item.id === input.id &&
        item.kind === input.kind &&
        item.targetId === input.targetId &&
        item.note === input.note
      );
    })
      ? { status: 200 as const, body: { restored: false } }
      : conflict(
          "Suggestion is no longer available. Refresh your suggestions.",
        );
  },
);

const reviseSuggestionFeedback$ = command(
  async (
    { set },
    owner: Owner,
    id: string,
    revision: {
      readonly input: FeedbackRequest;
      readonly feedbacks: readonly SuggestionFeedback[];
    },
    signal: AbortSignal,
  ) => {
    const { input, feedbacks } = revision;
    const feedback = feedbackInput(
      input.kind,
      input.id,
      input.targetId,
      input.note,
    );
    const target = feedbacks.find((item) => {
      return item.id === input.targetId;
    });
    if (
      !target ||
      target.kind === "undo" ||
      target.kind === "reason" ||
      feedbacks.some((item) => {
        return item.kind === "undo" && item.targetId === input.targetId;
      })
    ) {
      return conflict("This feedback is no longer available to change.");
    }
    if (input.kind === "reason" && input.note.length === 0) {
      return badRequestMessage("Provide a reason to save.");
    }
    const snapshot = input.snapshot;
    const canRestore =
      input.kind === "undo" &&
      snapshot?.id === id &&
      hasValidSuggestionConsumeToken(owner, snapshot) &&
      getSuggestionExpiresAt(snapshot) > nowDate().getTime();
    const restore = canRestore
      ? eq(agentSuggestions.status, "consumed")
      : sql`false`;
    const at = nowDate();
    const [row] = await set(writeDb$)
      .update(agentSuggestions)
      .set({
        status: sql`CASE WHEN ${restore} THEN 'active' ELSE ${agentSuggestions.status} END`,
        content: canRestore
          ? sql`CASE WHEN ${restore} THEN ${sql.param(JSON.stringify(suggestionContent(snapshot)))}::jsonb ELSE ${agentSuggestions.content} END`
          : undefined,
        selectedOptionId: sql`CASE WHEN ${restore} THEN NULL ELSE ${agentSuggestions.selectedOptionId} END`,
        expiresAt: canRestore
          ? sql`CASE WHEN ${restore} THEN ${new Date(getSuggestionExpiresAt(snapshot)).toISOString()}::timestamptz ELSE ${agentSuggestions.expiresAt} END`
          : undefined,
        updatedAt: at,
        feedbacks: sql`${agentSuggestions.feedbacks} || jsonb_build_array(${storedFeedback(feedback)})`,
      })
      .where(
        and(
          scope(owner, id),
          sql`jsonb_array_length(${agentSuggestions.feedbacks}) < 100`,
          feedbackIdentity(input.targetId ?? ""),
          not(feedbackIdentity(input.id)),
          sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${agentSuggestions.feedbacks}) AS response WHERE response->>'kind' = 'undo' AND response->>'targetId' = ${input.targetId})`,
        ),
      )
      .returning({ status: agentSuggestions.status });
    signal.throwIfAborted();
    if (!row) {
      return conflict("The feedback changed. Refresh your suggestions.");
    }
    await publishAgentSuggestionsChangedSafely(owner);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { restored: row.status === "active" },
    };
  },
);

export const recordSuggestionFeedback$ = command(
  async (
    { set },
    owner: Owner,
    id: string,
    input: FeedbackRequest,
    signal: AbortSignal,
  ) => {
    if (input.kind !== "undo" && input.kind !== "reason") {
      return await set(
        recordInitialSuggestionFeedback$,
        owner,
        id,
        input,
        signal,
      );
    }
    const existing = await set(storedSuggestion$, owner, id, signal);
    const duplicate = existing?.feedbacks.find((feedback) => {
      return feedback.id === input.id;
    });
    if (duplicate && existing) {
      if (
        duplicate.kind !== input.kind ||
        duplicate.targetId !== input.targetId ||
        duplicate.note !== input.note
      ) {
        return conflict(
          "Feedback identity already exists with a different response.",
        );
      }
      return {
        status: 200 as const,
        body: { restored: existing.status === "active" },
      };
    }
    return await set(
      reviseSuggestionFeedback$,
      owner,
      id,
      { input, feedbacks: existing?.feedbacks ?? [] },
      signal,
    );
  },
);

const acceptedSuggestionMessage$ = command(
  async (
    { set },
    owner: Owner,
    threadId: string,
    eventId: string,
    signal: AbortSignal,
  ) => {
    const [event] = await set(writeDb$)
      .select({ document: canonicalChatEventUserMessage() })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .where(
        and(
          eq(chatEvents.id, eventId),
          eq(chatEvents.chatThreadId, threadId),
          eq(chatThreads.userId, owner.userId),
          chatThreadOrganizationPredicate(owner.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return event?.document ?? null;
  },
);

export const validateSuggestionFollowup$ = command(
  async (
    { set },
    owner: Owner,
    input: {
      readonly threadId: string;
      readonly eventId: string;
      readonly document: UserMessageDocument;
    },
    signal: AbortSignal,
  ) => {
    const { threadId, eventId, document } = input;
    // An accepted replay must repair its receipt even if curation has since changed.
    if (
      await set(acceptedSuggestionMessage$, owner, threadId, eventId, signal)
    ) {
      return null;
    }
    for (const { context, part } of suggestionFeedbacks(document)) {
      const entry = await set(
        storedSuggestion$,
        owner,
        context.suggestionId,
        signal,
      );
      const item = entry?.status === "active" ? entry : null;
      // A saved quote is self-contained and can outlive its disposable card.
      // Retired or absent cards grant no new authority and keep their receipt.
      if (!item) {
        continue;
      }
      const submittedFiles = new Set(
        document.parts
          .filter((entry) => {
            return entry.type === "file";
          })
          .map((entry) => {
            return entry.fileId;
          }),
      );
      const savedQuote = item?.customOption.draft.draftUserMessage?.parts.find(
        (entry) => {
          return entry.type === "feedback";
        },
      );
      if (
        savedQuote?.type !== "feedback" ||
        savedQuote.quote !== part.quote ||
        (item.customOption.draft.draftAttachments ?? []).some((file) => {
          return !submittedFiles.has(file.id);
        }) ||
        createHash("sha256")
          .update(JSON.stringify(item.customOption.draft))
          .digest("hex") !== context.contextVersion
      ) {
        return conflict(
          "This suggestion background has changed. Select its custom direction again to refresh the context, or remove the quote to continue with your own message. Your draft has been kept.",
        );
      }
    }
    return null;
  },
);

/** Recoverable on an explicit replay of the accepted input; never consumes on prepare. */
export const recordAcceptedSuggestionFollowup$ = command(
  async (
    { set },
    owner: Owner,
    threadId: string,
    eventId: string,
    signal: AbortSignal,
  ) => {
    const document = await set(
      acceptedSuggestionMessage$,
      owner,
      threadId,
      eventId,
      signal,
    );
    if (!document) {
      throw new Error("Accepted suggestion input is unavailable");
    }
    for (const { context } of suggestionFeedbacks(document)) {
      await set(
        changeSuggestion$,
        owner,
        context.suggestionId,
        {
          status: "consumed",
          selectedOptionId: "custom",
          feedback: feedbackInput("custom_sent", eventId),
        },
        signal,
      );
    }
  },
);
