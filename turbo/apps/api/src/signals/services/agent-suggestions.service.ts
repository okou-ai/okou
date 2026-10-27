import { createHash } from "node:crypto";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { suggestionFeedbacks } from "@okouai/api-contracts/contracts/suggestion-context";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import { isDeepStrictEqual } from "node:util";
import { array, union } from "zod";
import { command } from "ccstate";
import { and, eq, exists, not, sql } from "drizzle-orm";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  suggestionSchema,
  suggestionReceiptSchema,
  getSuggestionExpiresAt,
  SUGGESTION_RETENTION_MS,
  type Suggestion,
  type SuggestionCreate,
  type SuggestionUpdate,
  type SuggestionConsume,
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
import { settle } from "../utils";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
import { publishAgentSuggestionsChangedSafely } from "../external/realtime";
import { isMorningBriefDefinitionName } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { PROACTIVE_SUGGESTIONS_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { loadProactiveWorkflowsEligibility$ } from "./proactive-workflows-eligibility.service";
import { retainedSuggestionEntry } from "./agent-suggestions-lifecycle";
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
const entriesSchema = array(union([suggestionSchema, suggestionReceiptSchema]));

function scope(owner: Owner) {
  return and(
    eq(agentSuggestions.orgId, owner.orgId),
    eq(agentSuggestions.userId, owner.userId),
  );
}
function contains(id: string, active: boolean, at: Date) {
  const status = active ? sql`AND item->>'status' = 'active'` : sql.empty();
  return exists(
    sql`(SELECT 1 FROM jsonb_array_elements(${agentSuggestions.entries}) AS item WHERE ${eq(sql`item->>'id'`, id)} AND ${retainedSuggestionEntry(at)} ${status})`,
  );
}
function containsOption(id: string, optionId: string) {
  const option =
    optionId === "custom"
      ? { id, customOption: { id: optionId } }
      : { id, options: [{ id: optionId }] };
  return sql`${agentSuggestions.entries} @> ${sql.param(JSON.stringify([option]))}::jsonb`;
}
function containsActive(id: string) {
  return sql`${agentSuggestions.entries} @> ${sql.param(JSON.stringify([{ id, status: "active" }]))}::jsonb`;
}
/** Compact terminal receipts and prune entries outside their lifetime. */
function compactEntries(at: Date) {
  return sql`COALESCE((SELECT jsonb_agg(CASE WHEN item->>'status' = 'active' THEN item ELSE jsonb_build_object('id', item->>'id', 'status', item->>'status', 'selectedOptionId', item->'selectedOptionId', 'createdAt', item->>'createdAt', 'updatedAt', item->>'updatedAt') END) FROM jsonb_array_elements(${agentSuggestions.entries}) AS item WHERE ${retainedSuggestionEntry(at)}), '[]'::jsonb)`;
}
function capacityViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    error.cause.code === "23514" &&
    "constraint" in error.cause &&
    error.cause.constraint === "agent_suggestions_entries_bound"
  );
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

const storedEntries$ = command(
  async ({ get }, owner: Owner, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({ entries: agentSuggestions.entries })
      .from(agentSuggestions)
      .where(scope(owner))
      .limit(1);
    signal.throwIfAborted();
    return entriesSchema.parse(row?.entries ?? []);
  },
);

export const readSuggestions$ = command(
  async ({ set }, owner: Owner, signal: AbortSignal) => {
    const entries = await set(storedEntries$, owner, signal);
    const at = nowDate().getTime();
    const suggestions = entries
      .filter((item): item is Suggestion => {
        return item.status === "active" && getSuggestionExpiresAt(item) > at;
      })
      .map((item) => {
        return withSuggestionConsumeToken(owner, {
          ...item,
          expiresAt: new Date(getSuggestionExpiresAt(item)).toISOString(),
        });
      })
      .sort((a, b) => {
        return (
          b.priority - a.priority ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id)
        );
      });
    const receipts = entries
      .filter((item) => {
        return (
          item.status !== "active" &&
          Date.parse(item.updatedAt) + SUGGESTION_RETENTION_MS > at
        );
      })
      .sort((a, b) => {
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, 100)
      .map((item) => {
        return suggestionReceiptSchema.parse(item);
      });
    return { status: 200 as const, body: { suggestions, receipts } };
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
    const inserted = await settle(
      set(writeDb$)
        .insert(agentSuggestions)
        .values({ ...owner, entries: [item] })
        .onConflictDoUpdate({
          target: [agentSuggestions.orgId, agentSuggestions.userId],
          set: {
            entries: sql`${compactEntries(at)} || ${sql.param(JSON.stringify([item]))}::jsonb`,
          },
          setWhere: not(contains(input.id, false, at)),
        })
        .returning({ entries: agentSuggestions.entries }),
      signal,
    );
    signal.throwIfAborted();
    if (!inserted.ok) {
      if (capacityViolation(inserted.error)) {
        return conflict(
          "The pool already contains ten active suggestions. List the pool and explicitly delete an item before creating another.",
        );
      }
      throw inserted.error;
    }
    const rows = inserted.value;
    if (rows.length > 0) {
      await publishAgentSuggestionsChangedSafely(owner);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: withSuggestionConsumeToken(owner, item),
      };
    }
    const entries = await set(storedEntries$, owner, signal);
    const existing = entries.find((entry) => {
      return entry.id === input.id;
    });
    if (
      existing?.status === "active" &&
      existing.title === input.title &&
      existing.rationale === input.rationale &&
      existing.priority === input.priority &&
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
    },
    signal: AbortSignal,
  ) => {
    const at = nowDate();
    const timestamp = at.toISOString();
    const data = {
      ...patch,
      updatedAt: timestamp,
      ...(patch.status === undefined
        ? {
            expiresAt: new Date(
              getSuggestionExpiresAt({
                updatedAt: timestamp,
                expiresAt: patch.expiresAt,
              }),
            ).toISOString(),
          }
        : {}),
    };
    const [row] = await set(writeDb$)
      .update(agentSuggestions)
      .set({
        entries: sql`(SELECT jsonb_agg(CASE WHEN item->>'id' = ${id} THEN item || ${sql.param(JSON.stringify(data))}::jsonb WHEN item->>'status' = 'active' THEN item ELSE jsonb_build_object('id', item->>'id', 'status', item->>'status', 'selectedOptionId', item->'selectedOptionId', 'createdAt', item->>'createdAt', 'updatedAt', item->>'updatedAt') END) FROM jsonb_array_elements(${agentSuggestions.entries}) AS item WHERE ${eq(sql`item->>'id'`, id)} OR ${retainedSuggestionEntry(at)})`,
      })
      .where(
        and(
          scope(owner),
          patch.status === "consumed"
            ? containsActive(id)
            : contains(id, true, at),
          typeof patch.selectedOptionId === "string"
            ? containsOption(id, patch.selectedOptionId)
            : undefined,
        ),
      )
      .returning({ entries: agentSuggestions.entries });
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const item = entriesSchema.parse(row.entries).find((entry) => {
      return entry.id === id;
    });
    const result = suggestionSchema.parse(item);
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
    optionId: string | null,
    signal: AbortSignal,
  ) => {
    const at = nowDate();
    const item = suggestionSchema.parse({
      ...snapshot,
      consumeToken: undefined,
      status: "consumed",
      selectedOptionId: optionId,
      updatedAt: at.toISOString(),
    });
    const rows = await set(writeDb$)
      .insert(agentSuggestions)
      .values({ ...owner, entries: [item] })
      .onConflictDoUpdate({
        target: [agentSuggestions.orgId, agentSuggestions.userId],
        set: {
          entries: sql`${compactEntries(at)} || ${sql.param(JSON.stringify([item]))}::jsonb`,
        },
        setWhere: and(
          not(contains(snapshot.id, false, at)),
          not(containsActive(snapshot.id)),
        ),
      })
      .returning({ entries: agentSuggestions.entries });
    signal.throwIfAborted();
    if (rows.length === 0) {
      // Publication may have won after the first consume found no active card.
      // Consume its canonical value rather than replacing it with cached data.
      return await set(
        changeSuggestion$,
        owner,
        snapshot.id,
        { status: "consumed", selectedOptionId: optionId },
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
    if (optionId === "custom") {
      return conflict(
        "Send your question or direction to choose the custom option.",
      );
    }
    let item = await set(
      changeSuggestion$,
      owner,
      id,
      { status: "consumed", selectedOptionId: optionId },
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
        optionId,
        signal,
      );
    }
    return item
      ? { status: 200 as const, body: item }
      : conflict("Suggestion or selected option is no longer available.");
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
    const entries = await set(storedEntries$, owner, signal);
    for (const { context, part } of suggestionFeedbacks(document)) {
      const item = entries.find((entry): entry is Suggestion => {
        return entry.id === context.suggestionId && entry.status === "active";
      });
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
        { status: "consumed", selectedOptionId: "custom" },
        signal,
      );
    }
  },
);
