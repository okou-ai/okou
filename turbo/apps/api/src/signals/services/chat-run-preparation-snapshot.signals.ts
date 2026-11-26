import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";
import {
  memberMemories,
  memoryVersions,
} from "@okouai/db/schema/member-memory";
import { phoneUseDevices, phoneUseGrants } from "@okouai/db/schema/phone-use";
import { projects } from "@okouai/db/schema/project";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import { computed } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { array, object, string, unknown as zUnknown, uuid } from "zod";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { db$, type ReadonlyDb } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import { queuedThreadInputCondition } from "./chat-queued-event.service";
import { runOwnedChatEventCondition } from "./chat-event-type.service";
import { visibleChatEventCondition } from "./chat-event-visibility.service";
import { contextJsonRows } from "./context-rowset";
import {
  pickedThreadColumns,
  type EnqueuedChatInputFacts,
  type ProjectReferenceRow,
} from "./chat-run-preparation-facts";
import { officialWorkflowThreadCondition } from "./official-workflow-policy.service";
import {
  memberMemoryArchiveCondition,
  memberMemoryHeadFields,
  memberMemoryOwnerCondition,
  memberMemoryRevisionCondition,
} from "./member-memory-head.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

function buildPreparationTables(
  claim: { readonly orgId: string; readonly chatThreadId: string },
  capacity: number,
  requestInput: EnqueuedChatInputFacts | undefined,
) {
  const requestInputId = requestInput?.id;
  const builder = new QueryBuilder();
  const occupancy = builder.$with("preparation_occupancy").as(
    builder
      .select({ activeCount: count().as("active_count") })
      .from(activeAgentRuns)
      // An unlimited context needs no active-table scan. The aggregate still
      // supplies the single envelope row when this predicate is constant false.
      .where(
        capacity === 0 ? sql`false` : eq(activeAgentRuns.orgId, claim.orgId),
      ),
  );
  // This request already validated and committed its canonical input facts.
  // Other FIFO heads still read and strictly decode their stored payload.
  const payload =
    requestInputId === undefined
      ? chatEvents.payload
      : sql`CASE WHEN ${eq(chatEvents.id, requestInputId)} THEN NULL
          ELSE ${chatEvents.payload} END`;
  const modelSelection =
    requestInputId === undefined
      ? chatEvents.modelSelection
      : sql`CASE WHEN ${eq(chatEvents.id, requestInputId)} THEN NULL
          ELSE ${chatEvents.modelSelection} END`;
  const requiredOfficialWorkflowIds =
    requestInputId === undefined
      ? chatEvents.requiredOfficialWorkflowIds
      : sql`CASE WHEN ${eq(chatEvents.id, requestInputId)} THEN NULL
          ELSE ${chatEvents.requiredOfficialWorkflowIds} END`;
  const head = builder.$with("preparation_head").as(
    builder
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
        eventType: chatEvents.eventType,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
        userMessage: canonicalChatEventUserMessage(payload).as("user_message"),
        requiredOfficialWorkflowIds: sql`${requiredOfficialWorkflowIds}`
          .mapWith(
            nullableDriverValueDecoder(chatEvents.requiredOfficialWorkflowIds),
          )
          .as("required_official_workflow_ids"),
        modelSelection:
          canonicalChatInputModelSelection(modelSelection).as(
            "model_selection",
          ),
        sourceAutonomyBudget: agentRuns.autonomyBudget,
      })
      .from(chatEvents)
      .leftJoin(
        agentRuns,
        and(
          eq(chatEvents.contextType, "agent_run"),
          eq(agentRuns.id, chatEvents.contextId),
          requestInput?.sourceAutonomyBudget === undefined
            ? undefined
            : ne(chatEvents.id, requestInput.id),
        ),
      )
      .where(queuedThreadInputCondition(claim.chatThreadId))
      .orderBy(asc(chatEvents.seqId))
      .limit(1),
  );
  return { occupancy, head };
}

function pickedPromptColumns(
  head: ReturnType<typeof buildPreparationTables>["head"],
  hasCapacity: SQL,
  owner: Parameters<typeof officialWorkflowThreadCondition>[0],
  requestInput?: EnqueuedChatInputFacts,
) {
  // These policies apply only to prompts with capacity to launch.
  const hasPromptCapacity = and(
    hasCapacity,
    eq(head.eventType, "input.prompt"),
  );
  const storedCapture = exists(
    new QueryBuilder()
      .select({ id: chatNetworkBodyCaptures.chatEventId })
      .from(chatNetworkBodyCaptures)
      .where(eq(chatNetworkBodyCaptures.chatEventId, head.id)),
  );
  const capture = requestInput
    ? sql`CASE WHEN ${eq(head.id, requestInput.id)}
        THEN ${requestInput.captureNetworkBodies} ELSE ${storedCapture} END`
    : storedCapture;
  return {
    hasCompletedPredecessorHistory: completedPredecessorHistory(
      head,
      hasCapacity,
    ),
    isOfficialWorkflowThread:
      sql`CASE WHEN ${hasPromptCapacity} THEN ${officialWorkflowThreadCondition(owner)}
        ELSE false END`.mapWith(pgBooleanDecoder),
    captureNetworkBodies:
      sql`CASE WHEN ${hasPromptCapacity} THEN ${capture} ELSE false END`.mapWith(
        pgBooleanDecoder,
      ),
  };
}

function completedPredecessorHistory(
  head: ReturnType<typeof buildPreparationTables>["head"],
  hasCapacity: SQL,
) {
  const query = new QueryBuilder();
  const predecessor = exists(
    query
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, chatThreads.frameworkSessionRunId),
          eq(agentRuns.chatThreadId, chatThreads.id),
          eq(agentRuns.userId, chatThreads.userId),
          eq(agentRuns.status, "completed"),
          exists(
            query
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(
                and(
                  eq(chatEvents.chatThreadId, agentRuns.chatThreadId),
                  eq(chatEvents.runId, agentRuns.id),
                  runOwnedChatEventCondition(),
                  visibleChatEventCondition(),
                ),
              ),
          ),
        ),
      ),
  );
  return sql`CASE WHEN ${hasCapacity}
    AND ${inArray(head.contextType, ["web", "agent_run"])}
    AND ${isNotNull(chatThreads.frameworkSessionRunId)}
    THEN ${predecessor} ELSE false END`.mapWith(pgBooleanDecoder);
}

function pickedPhoneUseGrant(hasCapacity: SQL) {
  return new QueryBuilder()
    .select({ deviceId: phoneUseGrants.deviceId, grantId: phoneUseGrants.id })
    .from(phoneUseGrants)
    .innerJoin(
      phoneUseDevices,
      and(
        eq(phoneUseDevices.id, phoneUseGrants.deviceId),
        eq(phoneUseDevices.orgId, phoneUseGrants.orgId),
        eq(phoneUseDevices.userId, phoneUseGrants.userId),
        eq(phoneUseDevices.generation, phoneUseGrants.deviceGeneration),
      ),
    )
    .where(
      and(
        hasCapacity,
        eq(phoneUseGrants.orgId, chatThreads.orgId),
        eq(phoneUseGrants.userId, chatThreads.userId),
        eq(phoneUseGrants.threadId, chatThreads.id),
      ),
    )
    .as("preparation_phone_use_grant");
}

function pickedProjectJoin(
  head: ReturnType<typeof buildPreparationTables>["head"],
  hasCapacity: SQL,
  requestInput: EnqueuedChatInputFacts | undefined,
) {
  const needsCurrentProject = requestInput?.projectReferences?.length
    ? or(
        ne(head.id, requestInput.id),
        notInArray(
          chatThreads.projectId,
          requestInput.projectReferences.map(({ id }) => {
            return id;
          }),
        ),
      )
    : undefined;
  return and(
    hasCapacity,
    inArray(head.contextType, ["web", "agent_run"]),
    eq(projects.id, chatThreads.projectId),
    eq(projects.userId, chatThreads.userId),
    eq(projects.orgId, chatThreads.orgId),
    needsCurrentProject,
  );
}

function pickedProjectFacts(
  projectId: string | null,
  current: ProjectReferenceRow | null,
  capturedReferences: readonly ProjectReferenceRow[],
  owned: EnqueuedChatInputFacts | undefined,
) {
  const references = owned?.projectReferences;
  return {
    currentProject:
      references?.find(({ id }) => {
        return id === projectId;
      }) ?? current,
    projectReferences: references ?? capturedReferences,
  };
}

const projectReferenceRowsDecoder = zodDriverValueDecoder(
  array(object({ id: uuid(), name: string() })),
);

function pickedProjectReferences(
  head: ReturnType<typeof buildPreparationTables>["head"],
  hasCapacity: SQL,
) {
  const referenced = alias(projects, "referenced_project");
  // Stored documents also carry Project links inside feedback notes.
  const referenceIds = sql`jsonb_path_query_array(${head.userMessage},
    '$.parts[*] ? (@.type == "project").projectId')
    || jsonb_path_query_array(${head.userMessage},
    '$.parts[*] ? (@.type == "feedback").note[*] ? (@.type == "project").projectId')`;
  const rows = new QueryBuilder()
    .select({
      payload:
        sql`jsonb_build_object('id', ${referenced.id}, 'name', ${referenced.name})`
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
    })
    .from(referenced)
    .where(
      and(
        eq(referenced.orgId, chatThreads.orgId),
        eq(referenced.userId, chatThreads.userId),
        sql`${referenced.id} IS DISTINCT FROM ${chatThreads.projectId}`,
        inArray(
          referenced.id,
          sql`(SELECT CASE WHEN pg_input_is_valid(project_id, 'uuid')
            THEN project_id::uuid END
            FROM jsonb_array_elements_text(${referenceIds}) AS ids(project_id))`,
        ),
      ),
    );
  // The head's payload is NULL when this request already owns its references.
  return sql`CASE WHEN ${hasCapacity}
    AND ${inArray(head.contextType, ["web", "agent_run"])}
    AND ${isNotNull(head.userMessage)}
    THEN ${contextJsonRows(rows)} ELSE '[]'::jsonb END`.mapWith(
    projectReferenceRowsDecoder,
  );
}

function preparationSnapshotQuery(
  db: ReadonlyDb,
  claim: { readonly orgId: string; readonly chatThreadId: string },
  owner: Pick<AgentRunContextSignals, "orgId" | "userId">,
  capacity: number,
  requestInput?: EnqueuedChatInputFacts,
) {
  const { occupancy, head } = buildPreparationTables(
    claim,
    capacity,
    requestInput,
  );
  const hasCapacity =
    capacity === 0 ? sql`true` : lt(occupancy.activeCount, capacity);
  const phoneGrant = pickedPhoneUseGrant(hasCapacity);
  const { chatThreadId, ...headFields } = head._.selectedFields;
  return db
    .with(occupancy, head)
    .select({
      hasCapacity: sql`${hasCapacity}`.mapWith(pgBooleanDecoder),
      threadHasActiveRun: exists(
        new QueryBuilder()
          .select({ runId: activeAgentRuns.runId })
          .from(activeAgentRuns)
          .where(eq(activeAgentRuns.chatThreadId, claim.chatThreadId)),
      ).mapWith(pgBooleanDecoder),
      memory: memberMemoryHeadFields.memory,
      revision: memberMemoryHeadFields.revision,
      archiveCache: memberMemoryHeadFields.archiveCache,
      thread: pickedThreadColumns,
      titled:
        sql`CASE WHEN ${isNotNull(chatThreads.title)} THEN true ELSE ${isNotNull(chatThreads.renamedAt)} END`.mapWith(
          pgBooleanDecoder,
        ),
      computerUseHostGrant: {
        hostId: computerUseHosts.id,
        displayName: computerUseHosts.displayName,
      },
      phoneUseGrant: {
        deviceId: phoneGrant.deviceId,
        grantId: phoneGrant.grantId,
      },
      currentProject: { id: projects.id, name: projects.name },
      projectReferences: pickedProjectReferences(head, hasCapacity),
      head: headFields,
      ...pickedPromptColumns(
        head,
        hasCapacity,
        {
          threadId: claim.chatThreadId,
          orgId: claim.orgId,
          userId: owner.userId,
        },
        requestInput,
      ),
    })
    .from(occupancy)
    .leftJoin(head, sql`true`)
    .leftJoin(
      chatThreads,
      and(
        eq(chatThreads.id, chatThreadId),
        eq(chatThreads.userId, owner.userId),
        eq(chatThreads.orgId, owner.orgId),
      ),
    )
    .leftJoin(
      computerUseHosts,
      and(
        hasCapacity,
        eq(computerUseHosts.id, chatThreads.computerUseHostId),
        eq(computerUseHosts.orgId, chatThreads.orgId),
        eq(computerUseHosts.userId, chatThreads.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .leftJoinLateral(phoneGrant, sql`true`)
    .leftJoin(projects, pickedProjectJoin(head, hasCapacity, requestInput))
    .leftJoin(
      memberMemories,
      and(
        isNotNull(chatThreads.id),
        hasCapacity,
        memberMemoryOwnerCondition(owner),
      ),
    )
    .leftJoin(memoryVersions, memberMemoryRevisionCondition)
    .leftJoin(systemStoragePresignedUrlCache, memberMemoryArchiveCondition());
}

/** Capture availability and launch facts for the actual FIFO head together. */
export function createChatRunPreparationSnapshot(
  claim: { readonly orgId: string; readonly chatThreadId: string },
  bootstrap: AgentRunContextSignals,
  requestInput?: EnqueuedChatInputFacts,
) {
  return computed(async (get) => {
    // The limit belongs to the identity context; occupancy is sampled here.
    const capacity = await get(bootstrap.concurrencyCapacity$);
    const [row] = await preparationSnapshotQuery(
      get(db$),
      claim,
      bootstrap,
      capacity,
      requestInput,
    );
    if (!row) {
      throw new Error("Chat preparation occupancy returned no row");
    }
    const snapshot = {
      hasCapacity: row.hasCapacity,
      threadHasActiveRun: row.threadHasActiveRun,
      memoryHead: {
        memory: row.memory,
        revision: row.revision,
        archiveCache: row.archiveCache,
      },
    };
    const {
      thread: joinedThread,
      head: picked,
      hasCompletedPredecessorHistory,
    } = row;
    if (!joinedThread || !picked) {
      return { ...snapshot, pickedEvent: null };
    }
    const thread = {
      ...joinedThread,
      // A published lease can retain the casing of the client-supplied UUID.
      id: claim.chatThreadId.toLowerCase(),
      userId: bootstrap.userId,
      titled: row.titled,
    };
    // Only this request's actual FIFO head may use its canonical input facts.
    const owned = requestInput?.id === picked.id ? requestInput : undefined;
    const pickedEvent: PickedThreadInputEvent = {
      ...picked,
      chatThreadId: thread.id,
      sourceAutonomyBudget:
        owned?.sourceAutonomyBudget ?? picked.sourceAutonomyBudget,
      userMessage: owned ? owned.userMessage : picked.userMessage,
      modelSelection: owned ? owned.modelSelection : picked.modelSelection,
      requiredOfficialWorkflowIds: owned
        ? (owned.requiredOfficialWorkflowIds ?? null)
        : picked.requiredOfficialWorkflowIds,
      userId: thread.userId,
      thread,
      preparation: {
        hasCompletedPredecessorHistory,
        isOfficialWorkflowThread: row.isOfficialWorkflowThread,
        captureNetworkBodies: row.captureNetworkBodies,
        computerUseHostGrant: row.computerUseHostGrant,
        phoneUseGrant: row.phoneUseGrant,
        ...pickedProjectFacts(
          thread.projectId,
          row.currentProject,
          row.projectReferences,
          owned,
        ),
      },
    };
    return { ...snapshot, pickedEvent };
  });
}
