import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { command } from "ccstate";
import { and, eq, not, sql } from "drizzle-orm";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  suggestionSchema,
  suggestionReceiptSchema,
  type Suggestion,
  type SuggestionCreate,
  type SuggestionUpdate,
} from "@okouai/api-contracts/contracts/suggestions";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$, writeDb$ } from "../external/db";
import { conflict, notFound, resourceUnavailable } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
import { publishAgentSuggestionsChangedSafely } from "../external/realtime";
import { isMorningBriefDefinitionName } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { PROACTIVE_SUGGESTIONS_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { loadProactiveWorkflowsEligibility$ } from "./proactive-workflows-eligibility.service";
import {
  PROACTIVE_LEARNING_DEFINITION_NAME,
  PROACTIVE_PLANNING_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-nightly";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}
const entriesSchema = z.array(
  z.union([suggestionSchema, suggestionReceiptSchema]),
);

function scope(owner: Owner) {
  return and(
    eq(agentSuggestions.orgId, owner.orgId),
    eq(agentSuggestions.userId, owner.userId),
  );
}
function contains(id: string, active: boolean) {
  const identity = active ? { id, status: "active" } : { id };
  return sql`${agentSuggestions.entries} @> ${sql.param(JSON.stringify([identity]))}::jsonb`;
}
/** Compact terminal business receipts without changing the active suggestions. */
function compactEntries() {
  return sql`COALESCE((SELECT jsonb_agg(CASE WHEN item->>'status' = 'active' THEN item ELSE jsonb_build_object('id', item->>'id', 'status', item->>'status', 'createdAt', item->>'createdAt', 'updatedAt', item->>'updatedAt') END) FROM jsonb_array_elements(${agentSuggestions.entries}) AS item), '[]'::jsonb)`;
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
      !isFeatureEnabled(FeatureSwitchKey.ProactiveAgent, {
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
    const suggestions = entries
      .filter((item): item is Suggestion => {
        return item.status === "active";
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
        return item.status !== "active";
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
    const invalid = await set(validateThread$, owner, input.threadId, signal);
    if (invalid) {
      return invalid;
    }
    const timestamp = nowDate().toISOString();
    const item = suggestionSchema.parse({
      ...input,
      status: "active",
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
            entries: sql`${compactEntries()} || ${sql.param(JSON.stringify([item]))}::jsonb`,
          },
          setWhere: not(contains(input.id, false)),
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
      return { status: 200 as const, body: item };
    }
    const entries = await set(storedEntries$, owner, signal);
    const existing = entries.find((entry) => {
      return entry.id === input.id;
    });
    if (
      existing?.status === "active" &&
      existing.title === input.title &&
      existing.rationale === input.rationale &&
      existing.threadId === input.threadId &&
      existing.priority === input.priority &&
      isDeepStrictEqual(existing.draft, input.draft)
    ) {
      return { status: 200 as const, body: existing };
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
    patch: SuggestionUpdate & { readonly status?: "consumed" | "removed" },
    signal: AbortSignal,
  ) => {
    const data = { ...patch, updatedAt: nowDate().toISOString() };
    const [row] = await set(writeDb$)
      .update(agentSuggestions)
      .set({
        entries: sql`(SELECT jsonb_agg(CASE WHEN item->>'id' = ${id} THEN item || ${sql.param(JSON.stringify(data))}::jsonb WHEN item->>'status' = 'active' THEN item ELSE jsonb_build_object('id', item->>'id', 'status', item->>'status', 'createdAt', item->>'createdAt', 'updatedAt', item->>'updatedAt') END) FROM jsonb_array_elements(${agentSuggestions.entries}) AS item)`,
      })
      .where(and(scope(owner), contains(id, true)))
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
    if (input.threadId !== undefined) {
      const invalid = await set(validateThread$, owner, input.threadId, signal);
      if (invalid) {
        return invalid;
      }
    }
    const item = await set(changeSuggestion$, owner, id, input, signal);
    return item
      ? { status: 200 as const, body: item }
      : conflict("Suggestion is unavailable or no longer active.");
  },
);
export const removeSuggestion$ = command(
  async ({ set }, owner: Owner, id: string, signal: AbortSignal) => {
    await set(changeSuggestion$, owner, id, { status: "removed" }, signal);
    return { status: 204 as const, body: undefined };
  },
);
export const consumeSuggestion$ = command(
  async ({ set }, owner: Owner, id: string, signal: AbortSignal) => {
    const item = await set(
      changeSuggestion$,
      owner,
      id,
      { status: "consumed" },
      signal,
    );
    return item
      ? { status: 200 as const, body: item }
      : conflict("Suggestion has already been consumed or is unavailable.");
  },
);
