import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { object, record, string } from "zod";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import { workflowAttachmentsSchema } from "@okouai/api-contracts/contracts/workflow-attachments";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import {
  executionImageSchema,
  databaseIdentity,
  readPrivate,
  sha256,
  writePrivate,
  syncDirectory,
  type TableImage,
  type RowImage,
} from "./execution-model";
import {
  normalizeExecutionTables,
  readExecutionState,
  requireQuiescent,
  type DraftTable,
} from "./execution-state";
import {
  bundleConfiguration,
  downloadBundle,
  savePreparedBundle,
  saveVerifiedArchive,
} from "./execution-content";
import { plan } from "./plan";
import { parseAgentPrefixes } from "./plan-names";
import { parseSnapshot, PlanningError, type Snapshot } from "./snapshot";
import { validateExecutionImage } from "./execution-validation";
import type { ProductionBinding } from "./production-model";

const agentContent = object({
  instructions: string(),
  instructions_bundle: contentBundleSchema,
});
const workflowContent = object({
  name: string(),
  instruction: string().nullable(),
  description: string().nullable(),
  content_bundle: contentBundleSchema,
  attachments: workflowAttachmentsSchema,
});
const rowKey = record(string(), string());

export async function prepareExecution(args: {
  connection: string;
  orgId: string;
  target: string;
  directory: string;
  inventoryFile: string;
  planFile: string;
  expectedPlanSha256: string;
  production?: ProductionBinding;
}) {
  const inventoryBytes = await readPrivate(args.inventoryFile);
  const planBytes = await readPrivate(args.planFile);
  if (sha256(planBytes) !== args.expectedPlanSha256)
    throw new PlanningError("ReviewedPlanHashMismatch");
  const snapshot = parseSnapshot(JSON.parse(inventoryBytes.toString("utf8")));
  if (snapshot.target !== args.target)
    throw new PlanningError("ExecutionTargetMismatch");
  const prefixInput = object({ agentPrefixes: object({}).passthrough() }).parse(
    JSON.parse(planBytes.toString("utf8")),
  );
  const approved = plan(
    snapshot,
    args.orgId,
    sha256(inventoryBytes),
    parseAgentPrefixes(prefixInput.agentPrefixes),
  );
  if (JSON.stringify(approved, null, 2) + "\n" !== planBytes.toString("utf8"))
    throw new PlanningError("PlanDoesNotMatchCurrentPlanner");
  if (approved.blockers.length)
    throw new PlanningError("ResolvePlanBlockersBeforeExecutionPreparation");
  const deletedAutomationIds = approved.automationDeletions.map((row) => {
    return row.source.id;
  });
  const state = await readExecutionState(
    args.connection,
    args.orgId,
    deletedAutomationIds,
  );
  requireQuiescent(state);
  if (state.database !== snapshot.database)
    throw new PlanningError("ExecutionDatabaseMismatch");
  const getTable = (name: TableImage["name"]) => {
    const table = state.tables.find((row) => {
      return row.name === name;
    });
    if (!table) throw new PlanningError("ExecutionTableMissing");
    return table;
  };
  const indexedRows = new Map(
    state.tables.map((table) => {
      return [
        table.name,
        new Map(
          table.rows.flatMap((row) => {
            return Object.entries(rowKey.parse(JSON.parse(row.key))).map(
              ([field, value]) => {
                return [JSON.stringify([field, value]), row] as const;
              },
            );
          }),
        ),
      ];
    }),
  );
  const findRow = (
    table: TableImage,
    field: string,
    value: string,
  ): RowImage => {
    const row = indexedRows
      .get(table.name)
      ?.get(JSON.stringify([field, value]));
    if (!row?.before) throw new PlanningError("ExecutionSourceRowMissing");
    return row;
  };
  assertInventoryState(snapshot, approved.targetAgentId, getTable, findRow);

  await mkdir(args.directory, { mode: 0o700 });
  await syncDirectory(dirname(args.directory));
  const bundleDirectory = join(args.directory, "bundles");
  await mkdir(bundleDirectory, { mode: 0o700 });
  const drafts: DraftTable[] = state.tables.map((table) => {
    return {
      metadata: table,
      rows: table.rows.map((row) => {
        return {
          key: row.key,
          before: row.before,
          revision: row.revision,
          patch: null,
          insert: null,
          remove: false,
        };
      }),
    };
  });
  const getDraft = (name: TableImage["name"]) => {
    const value = drafts.find((item) => {
      return item.metadata.name === name;
    });
    if (!value) throw new PlanningError("ExecutionTableMissing");
    return value;
  };
  const draftRows = new Map(
    drafts.map((draft) => {
      return [
        draft.metadata.name,
        new Map(
          draft.rows.map((row) => {
            return [row.key, row];
          }),
        ),
      ];
    }),
  );
  const patch = (name: TableImage["name"], key: string, value: object) => {
    const row = draftRows.get(name)?.get(key);
    if (!row) throw new PlanningError("ExecutionSourceRowMissing");
    row.patch = JSON.stringify(value);
  };
  const insert = (name: TableImage["name"], value: object) => {
    getDraft(name).rows.push({
      key: "",
      before: null,
      revision: null,
      patch: null,
      insert: JSON.stringify(value),
      remove: false,
    });
  };
  const bundles = new Map<
    string,
    ReturnType<typeof contentBundleSchema.parse>
  >();
  const defaultRow = findRow(getTable("agents"), "id", approved.targetAgentId);
  const defaultContent = agentContent.parse(JSON.parse(defaultRow.before!));
  const verifyInstructions = async (
    content: ReturnType<typeof agentContent.parse>,
  ) => {
    const { files, archive } = await downloadBundle(
      content.instructions_bundle,
    );
    if (
      files.length !== 1 ||
      files[0]?.path !== "instructions.md" ||
      !files[0].content.equals(Buffer.from(content.instructions))
    )
      throw new PlanningError("AgentInstructionsBundleMismatch");
    return archive;
  };
  await saveVerifiedArchive(
    bundleDirectory,
    defaultContent.instructions_bundle,
    await verifyInstructions(defaultContent),
  );
  bundles.set(
    defaultContent.instructions_bundle.sha256,
    defaultContent.instructions_bundle,
  );
  for (const moved of approved.movedWorkflows) {
    const row = findRow(getTable("workflows"), "id", moved.source.id);
    const content = workflowContent.parse(JSON.parse(row.before!));
    if (content.instruction === null)
      throw new PlanningError("CanonicalWorkflowInstructionRequired");
    const { files } = await downloadBundle(content.content_bundle);
    const skill = files.find((file) => {
      return file.path === "SKILL.md";
    });
    if (
      !skill ||
      !skill.content.equals(Buffer.from(synthesizeWorkflowSkillMd(content)))
    )
      throw new PlanningError("WorkflowCanonicalBundleMismatch");
    const expectedAttachments =
      content.attachments.kind === "empty" ? [] : content.attachments.files;
    const attachments = files.filter((file) => {
      return file.path !== "SKILL.md";
    });
    if (
      attachments.length !== expectedAttachments.length ||
      !expectedAttachments.every((expected) => {
        const actual = attachments.find((file) => {
          return file.path === expected.path;
        });
        return (
          actual &&
          actual.content.length === expected.size &&
          sha256(actual.content) === expected.sha256
        );
      })
    )
      throw new PlanningError("WorkflowAttachmentManifestMismatch");
    const bundle = await savePreparedBundle(
      bundleDirectory,
      files.map((file) => {
        return file.path === "SKILL.md"
          ? {
              ...file,
              content: Buffer.from(
                synthesizeWorkflowSkillMd({
                  ...content,
                  name: moved.targetName,
                }),
              ),
            }
          : file;
      }),
    );
    bundles.set(bundle.sha256, bundle);
    patch("workflows", row.key, {
      agent_id: moved.targetAgentId,
      name: moved.targetName,
      owner_user_id: moved.targetOwner,
      visibility: moved.targetVisibility,
      content_bundle: bundle,
      updated_at: state.capturedAt,
    });
  }
  for (const converted of approved.convertedInstructions) {
    const row = findRow(getTable("agents"), "id", converted.sourceAgentId);
    const content = agentContent.parse(JSON.parse(row.before!));
    await verifyInstructions(content);
    const bundle = await savePreparedBundle(bundleDirectory, [
      {
        path: "SKILL.md",
        content: Buffer.from(
          synthesizeWorkflowSkillMd({
            name: converted.targetName,
            description: null,
            instruction: content.instructions,
          }),
        ),
      },
    ]);
    bundles.set(bundle.sha256, bundle);
    insert("workflows", {
      id: randomUUID(),
      org_id: args.orgId,
      agent_id: approved.targetAgentId,
      name: converted.targetName,
      visibility: converted.visibility,
      owner_user_id: converted.owner,
      instruction: content.instructions,
      description: null,
      display_name: null,
      attachments: { kind: "empty" },
      content_bundle: bundle,
      official_definition_name: null,
      official_installation_state: null,
      import_source: null,
      import_session_id: null,
      created_by: converted.owner,
      updated_by: converted.owner,
      created_at: state.capturedAt,
      updated_at: state.capturedAt,
    });
  }
  for (const member of approved.personalInstructions) {
    if (member.action === "initialize-once")
      insert("instructions", {
        org_id: args.orgId,
        user_id: member.userId,
        content: defaultContent.instructions,
        bundle: defaultContent.instructions_bundle,
        version: randomUUID(),
        created_at: state.capturedAt,
        updated_at: state.capturedAt,
      });
  }
  for (const group of approved.projectGroups) {
    const id = randomUUID();
    insert("projects", {
      id,
      user_id: group.owner,
      org_id: args.orgId,
      name: group.targetName,
      created_at: state.capturedAt,
      updated_at: state.capturedAt,
    });
    for (const chat of group.chats) {
      const row = findRow(getTable("chat_threads"), "id", chat.id);
      patch("chat_threads", row.key, {
        agent_id: approved.targetAgentId,
        project_id: id,
        updated_at: state.capturedAt,
      });
    }
  }
  planAssociationDeletions(
    drafts,
    deletedAutomationIds,
    approved.automationThreadDeletions.map((row) => {
      return row.source.id;
    }),
  );
  const configuration = bundleConfiguration();
  const image = executionImageSchema.parse({
    ...(args.production
      ? {
          format: "single-agent-production-execution-v1",
          purpose: "production-cutover",
          production: args.production,
        }
      : {
          format: "single-agent-execution-v1",
          purpose: "isolated-copy-rehearsal",
        }),
    scope: {
      orgId: args.orgId,
      target: args.target,
      database: state.database,
      databaseEndpoint: databaseIdentity(args.connection),
      bucket: configuration.bucket,
      endpoint: configuration.endpoint,
    },
    capturedAt: state.capturedAt,
    inventoryBytes: inventoryBytes.toString("utf8"),
    inventorySha256: sha256(inventoryBytes),
    planBytes: planBytes.toString("utf8"),
    planSha256: sha256(planBytes),
    automationIds: deletedAutomationIds,
    runIds: getTable("agent_runs").rows.map((row) => {
      return rowKey.parse(JSON.parse(row.key)).id!;
    }),
    tables: await normalizeExecutionTables(args.connection, drafts),
    bundles: [...bundles.values()].sort((a, b) => {
      return a.sha256.localeCompare(b.sha256);
    }),
  });
  const bytes = JSON.stringify(image, null, 2) + "\n";
  validateExecutionImage(image, approved, snapshot);
  await writePrivate(join(args.directory, "execution.json"), bytes);
  return {
    sha256: sha256(bytes),
    format: image.format,
    purpose: image.purpose,
    directory: args.directory,
    tables: image.tables.length,
    bundles: image.bundles.length,
  };
}

function assertInventoryState(
  snapshot: Snapshot,
  targetAgentId: string,
  getTable: (name: TableImage["name"]) => TableImage,
  findRow: (table: TableImage, field: string, value: string) => RowImage,
) {
  for (const [tableName, rows, field] of [
    ["agents", snapshot.agents, "id"],
    ["workflows", snapshot.workflows, "id"],
    ["chat_threads", snapshot.chats, "id"],
    ["workflow_automations", snapshot.automations, "id"],
    ["workflow_user_automation_threads", snapshot.automationThreads, "id"],
    ["projects", snapshot.projects, "id"],
  ] as const) {
    const table = getTable(tableName);
    if (table.rows.length !== rows.length)
      throw new PlanningError("InventoryMembershipDrift");
    for (const source of rows) {
      if (findRow(table, field, source.id).revision !== source.revision)
        throw new PlanningError("InventorySourceRevisionDrift");
    }
  }
  const personalTable = getTable("instructions");
  if (personalTable.rows.length !== snapshot.personalInstructions.length)
    throw new PlanningError("PersonalInstructionsDrift");
  for (const row of snapshot.personalInstructions) {
    if (findRow(personalTable, "user_id", row.userId).revision !== row.revision)
      throw new PlanningError("PersonalInstructionsDrift");
  }
  const membership = getTable("org_members_cache")
    .rows.map((row) => {
      return object({ user_id: string(), role: string() }).parse(
        JSON.parse(row.before!),
      );
    })
    .sort((a, b) => {
      return a.user_id.localeCompare(b.user_id);
    });
  if (
    JSON.stringify(membership) !==
    JSON.stringify(
      snapshot.members
        .map((member) => {
          return { user_id: member.userId, role: member.role };
        })
        .sort((a, b) => {
          return a.user_id.localeCompare(b.user_id);
        }),
    )
  )
    throw new PlanningError("MembershipCacheDrift");
  const metadata = object({ default_agent_id: string() }).parse(
    JSON.parse(getTable("org_metadata").rows[0]!.before!),
  );
  if (metadata.default_agent_id !== targetAgentId)
    throw new PlanningError("DefaultAgentDrift");
}

function planAssociationDeletions(
  drafts: readonly DraftTable[],
  deletedAutomationIds: readonly string[],
  deletedThreadIds: readonly string[],
) {
  const deletedThreads = new Set(deletedThreadIds);
  const deletedAutomations = new Set(deletedAutomationIds);
  for (const draft of drafts) {
    for (const row of draft.rows) {
      if (row.before === null) continue;
      const value = object({
        id: string().optional(),
        automation_id: string().nullable().optional(),
        workflow_automation_id: string().nullable().optional(),
      }).parse(JSON.parse(row.before));
      if (
        draft.metadata.name === "workflow_automations" &&
        value.id &&
        deletedAutomations.has(value.id)
      )
        row.remove = true;
      if (
        draft.metadata.name === "workflow_user_automation_threads" &&
        value.id &&
        deletedThreads.has(value.id)
      )
        row.remove = true;
      if (
        draft.metadata.name === "agent_runs" &&
        value.workflow_automation_id &&
        deletedAutomations.has(value.workflow_automation_id)
      )
        row.patch = JSON.stringify({ workflow_automation_id: null });
      if (value.automation_id && deletedAutomations.has(value.automation_id)) {
        if (draft.metadata.name === "official_workflow_automation_identities")
          throw new PlanningError(
            "OfficialAutomationDeletionRequiresSeparateReconciliation",
          );
        row.remove = true;
      }
    }
  }
}
