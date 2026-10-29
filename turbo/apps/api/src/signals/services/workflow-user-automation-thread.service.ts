import { OfficialWorkflowRunAdmissionError } from "./official-workflow-run.service";
import {
  isMorningBriefDefinitionName,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  userLocaleSchema,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import {
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { object, uuid } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";

import {
  modelSettingsSchema,
  type ModelSettings,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { explicitModelSettings } from "@okouai/core/auto-run-model";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { db$, writeDb$ } from "../external/db";
import {
  chatThreadEventInsertSql,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import {
  autoSelectionPin,
  resolveDefaultModelFirstPin$,
  type DefaultModelFirstPin,
} from "./model-selection.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";

const OFFICIAL_WORKFLOW_THREAD_TITLES: Readonly<
  Partial<Record<string, Readonly<Record<UserLocale, string>>>>
> = {
  "morning-brief": {
    "en-US": "Okou Morning Brief",
    "pt-BR": "Okou Resumo da manhã",
    "ja-JP": "Okou モーニングブリーフ",
    "ko-KR": "Okou 모닝 브리핑",
    "id-ID": "Okou Ringkasan pagi",
    "de-DE": "Okou Morgenbriefing",
    "es-ES": "Okou Resumen matinal",
    "it-IT": "Okou Brief del mattino",
    "fr-FR": "Okou Brief du matin",
    "hi-IN": "Okou सुबह की ब्रीफ़",
    "zh-Hans": "Okou 晨间简报",
    "zh-Hant": "Okou 晨間簡報",
  },
};

export interface WorkflowThreadPreparation {
  readonly hidden: boolean;
  readonly initialModel: DefaultModelFirstPin;
  readonly title: string;
  readonly modelSettings: ModelSettings;
  readonly cloudBrowserEnabled: boolean;
}

const officialWorkflowThreadPresentation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly definitionName: string;
      readonly workflowTitle: string;
      readonly locale?: string | null;
    },
    signal: AbortSignal,
  ) => {
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    const definition = catalog?.payload.definitions.find((candidate) => {
      return candidate.name === args.definitionName;
    });
    if (!catalog || !definition) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    const locale = userLocaleSchema.parse(args.locale ?? "en-US");
    const localized =
      OFFICIAL_WORKFLOW_THREAD_TITLES[
        isMorningBriefDefinitionName(args.definitionName)
          ? MORNING_BRIEF_OFFICIAL_DEFINITION_NAME
          : args.definitionName
      ]?.[locale];
    let title = args.workflowTitle;
    if (localized) {
      title = localized;
    } else {
      const revision = await set(
        readAcceptedOfficialWorkflowRevision$,
        { name: definition.name, revision: definition.revision },
        signal,
      );
      title = revision?.definition.workflow.displayName ?? title;
    }
    return {
      title,
      hidden: true,
    };
  },
);

export const prepareWorkflowUserAutomationThread$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowId: string;
      readonly workflowTitle: string;
    },
    signal: AbortSignal,
  ): Promise<WorkflowThreadPreparation> => {
    const db = set(writeDb$);
    const [[context], [member]] = await Promise.all([
      db
        .select({ officialDefinitionName: workflows.officialDefinitionName })
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, args.orgId),
            eq(workflows.id, args.workflowId),
          ),
        )
        .limit(1),
      db
        .select({
          locale: orgMembersMetadata.locale,
          modelSettings: orgMembersMetadata.modelSettings,
          cloudBrowserEnabled: orgMembersMetadata.cloudBrowserEnabledByDefault,
        })
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, args.orgId),
            eq(orgMembersMetadata.userId, args.userId),
          ),
        )
        .limit(1),
    ]);
    signal.throwIfAborted();
    const definitionName = context?.officialDefinitionName;
    const presentation = definitionName
      ? await set(
          officialWorkflowThreadPresentation$,
          {
            orgId: args.orgId,
            userId: args.userId,
            definitionName,
            workflowTitle: args.workflowTitle,
            locale: member?.locale,
          },
          signal,
        )
      : { title: args.workflowTitle, hidden: false };
    const initialModel = definitionName
      ? { ...autoSelectionPin(), serviceTier: null }
      : await set(
          resolveDefaultModelFirstPin$,
          {
            orgId: args.orgId,
            userId: args.userId,
            orgPlanCapabilities: undefined,
          },
          signal,
        );
    signal.throwIfAborted();
    return {
      ...presentation,
      initialModel,
      modelSettings: modelSettingsSchema.parse(member?.modelSettings ?? {}),
      cloudBrowserEnabled: member?.cloudBrowserEnabled ?? true,
    };
  },
);

interface WorkflowUserAutomationThreadOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}

/** The one binding row a workflow's automations share for this owner. */
export function workflowUserAutomationThreadOwnerCondition(
  owner: WorkflowUserAutomationThreadOwner,
) {
  return and(
    eq(workflowUserAutomationThreads.orgId, owner.orgId),
    eq(workflowUserAutomationThreads.userId, owner.userId),
    eq(workflowUserAutomationThreads.workflowId, owner.workflowId),
  );
}

export const loadWorkflowUserAutomationThreadId$ = command(
  async (
    { get },
    args: WorkflowUserAutomationThreadOwner,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const [binding] = await get(db$)
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(workflowUserAutomationThreadOwnerCondition(args))
      .limit(1);
    signal.throwIfAborted();
    return binding?.chatThreadId ?? null;
  },
);

/**
 * Pause every enabled automation that shares a workflow-user chat thread.
 * The caller deletes the thread in the same transaction, so the binding still
 * identifies the affected workflows while this update runs.
 */
/** Pure predicate for the deletion owner's conditional automation UPDATE. */
interface WorkflowThreadOwner extends WorkflowUserAutomationThreadOwner {
  readonly agentId: string;
  readonly workflowTitle: string;
  readonly currentTime: Date;
}

export function preparedWorkflowThreadValues(
  args: WorkflowThreadOwner,
  preparation: WorkflowThreadPreparation,
  threadId: string,
) {
  const pin = preparation.initialModel;
  return {
    id: threadId,
    hidden: preparation.hidden,
    userId: args.userId,
    agentId: args.agentId,
    title: preparation.title,
    selectedModel: pin.selectedModel,
    codexServiceTier: pin.serviceTier === "priority" ? ("fast" as const) : null,
    modelSettings: explicitModelSettings(preparation.modelSettings),
    cloudBrowserEnabled: preparation.cloudBrowserEnabled,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

/** Preserve column encoders and omitted defaults in the gated INSERT SELECT. */
export function workflowThreadInsertFromBindingSql(
  thread: ReturnType<typeof preparedWorkflowThreadValues>,
  onlyThreadId?: string,
) {
  const columns = getTableColumns(chatThreads);
  const entries = (Object.keys(thread) as (keyof typeof thread)[]).map(
    (key) => {
      return { key, column: columns[key], value: thread[key] };
    },
  );
  const names = entries.map(({ column }) => {
    return sql.identifier(column.name);
  });
  const values = entries.map(({ key, column, value }) => {
    return key === "id"
      ? sql`accepted_binding.chat_thread_id`
      : sql.param(value, column);
  });
  const gate =
    onlyThreadId === undefined
      ? sql.empty()
      : sql`WHERE accepted_binding.chat_thread_id = ${sql.param(onlyThreadId, chatThreads.id)}`;
  return sql`INSERT INTO ${chatThreads} (${sql.join(names, sql`, `)})
    SELECT ${sql.join(values, sql`, `)} FROM accepted_binding ${gate}
    RETURNING id, agent_id`;
}

const createdWorkflowThreadRowSchema = object({ id: uuid() });

/** Lazy trigger repair owns its complete binding, thread and event publication. */
export const ensureWorkflowUserAutomationThread$ = command(
  async (
    { set },
    args: WorkflowThreadOwner,
    signal: AbortSignal,
  ): Promise<string> => {
    const preparation = await set(
      prepareWorkflowUserAutomationThread$,
      args,
      signal,
    );
    const db = set(writeDb$);
    const values = preparedWorkflowThreadValues(
      args,
      preparation,
      randomUUID(),
    );
    const binding = db
      .insert(workflowUserAutomationThreads)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        workflowId: args.workflowId,
        chatThreadId: values.id,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoUpdate({
        target: [
          workflowUserAutomationThreads.orgId,
          workflowUserAutomationThreads.userId,
          workflowUserAutomationThreads.workflowId,
        ],
        set: { chatThreadId: values.id, updatedAt: args.currentTime },
        setWhere: isNull(workflowUserAutomationThreads.chatThreadId),
      })
      .returning({ chatThreadId: workflowUserAutomationThreads.chatThreadId });
    // One binding mutation owns the publication. Its forward thread FK is
    // satisfied at statement end; RETURNING gates every dependent write.
    const publication = chatThreadEventInsertSql(
      {
        kind: "created",
        hidden: preparation.hidden,
        orgId: args.orgId,
        userId: args.userId,
        chatThreadId: values.id,
        title: values.title,
        selectedModel: values.selectedModel,
        modelSettings: values.modelSettings,
        cloudBrowserEnabled: values.cloudBrowserEnabled,
        serviceTier: chatThreadServiceTierFromCodex(values.codexServiceTier),
        createdAt: values.createdAt,
      },
      {
        cte: sql`accepted_binding AS (${binding.getSQL()}),
            inserted_thread AS (${workflowThreadInsertFromBindingSql(values)})`,
        gate: sql`EXISTS (SELECT 1 FROM inserted_thread)`,
        agentId: sql`(SELECT agent_id FROM inserted_thread)`,
        result: sql`SELECT id FROM inserted_thread`,
      },
    );
    signal.throwIfAborted();
    const rows = parseRawRows(
      createdWorkflowThreadRowSchema,
      await db.execute(publication),
    );
    signal.throwIfAborted();
    if (rows.length > 1) {
      throw new Error("Workflow thread publication returned multiple threads");
    }
    const created = rows[0];
    if (created) {
      return created.id;
    }
    // A conflict can wait for a winner absent from the statement's initial
    // snapshot. Read that committed binding once, after the statement ends.
    const [winner] = await db
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(workflowUserAutomationThreadOwnerCondition(args))
      .limit(1);
    signal.throwIfAborted();
    if (!winner?.chatThreadId) {
      throw new Error("Workflow thread publication has no bound winner");
    }
    return winner.chatThreadId;
  },
);
